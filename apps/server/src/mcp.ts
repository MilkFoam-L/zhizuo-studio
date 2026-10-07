import { randomUUID } from 'node:crypto';

/**
 * 最小 MCP Streamable HTTP 客户端：initialize → tools/list → tools/call。
 * 兼容 JSON 与 SSE 两种响应形态；仅覆盖发布通道需要的能力，
 * 不引入 SDK 依赖。错误信息一律脱敏（不含 endpoint 与凭据）。
 */

export interface McpEndpointConfig {
  endpoint: string;
  token?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

function safeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return '';
  }
}

function sanitize(error: unknown, endpoint: string): McpError {
  if (error instanceof McpError) return error;
  const origin = safeEndpoint(endpoint);
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(
    origin && message.includes(origin)
      ? message.split(origin).join('<发布通道>')
      : '发布通道连接失败，请检查地址、鉴权与服务状态',
  );
}

async function readResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    // 取最后一个携带 result/error 的 JSON-RPC 数据帧。
    const frames = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (let i = frames.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(frames[i]) as { id?: unknown; result?: unknown; error?: unknown };
        if ('result' in parsed || 'error' in parsed) return parsed;
      } catch {
        // 跳过不完整帧。
      }
    }
    throw new McpError('发布通道返回了空的事件流');
  }
  return response.json();
}

class McpSession {
  constructor(
    private readonly config: McpEndpointConfig,
    private sessionId: string | null,
    private readonly signal?: AbortSignal,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  /** 发送 JSON-RPC 请求（带 id，等待 result），并跟踪会话头。 */
  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: randomUUID() }),
      signal: this.signal ?? AbortSignal.timeout(20_000),
    }).catch((error: unknown) => {
      throw sanitize(error, this.config.endpoint);
    });
    const headerSession = response.headers.get('mcp-session-id');
    if (headerSession) this.sessionId = headerSession;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new McpError(
        `发布通道返回 ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`,
        response.status,
      );
    }
    const payload = (await readResponse(response).catch((error: unknown) => {
      throw sanitize(error, this.config.endpoint);
    })) as { result?: Record<string, unknown>; error?: { message?: string }; id?: unknown };
    if (payload.error)
      throw new McpError(`发布通道工具错误：${String(payload.error.message ?? '未知错误')}`);
    return payload.result ?? {};
  }

  /** 无 id 通知（服务器返回 202 或空）。 */
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await fetch(this.config.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: this.signal ?? AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      throw sanitize(error, this.config.endpoint);
    });
  }
}

export interface McpConnection {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** 建立一次 MCP 会话（initialize → initialized），随后的调用复用会话。 */
export async function connectMcp(
  config: McpEndpointConfig,
  signal?: AbortSignal,
): Promise<McpConnection> {
  if (!/^https?:\/\//.test(config.endpoint)) throw new McpError('发布通道地址必须是 HTTP(S) 端点');
  let session: McpSession | undefined;
  try {
    session = new McpSession(config, null, signal);
    await session.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'zhizuo-studio', version: '0.1.0' },
    });
    await session.notify('notifications/initialized').catch(() => {});
    return {
      async listTools() {
        const result = await session!.request('tools/list', {});
        const tools = Array.isArray(result.tools) ? result.tools : [];
        const mapped: McpToolInfo[] = [];
        for (const tool of tools) {
          const item = tool as { name?: unknown; description?: unknown };
          if (typeof item.name === 'string')
            mapped.push({
              name: item.name,
              ...(typeof item.description === 'string' ? { description: item.description } : {}),
            });
        }
        return mapped;
      },
      async callTool(name: string, args: Record<string, unknown>) {
        const result = await session!.request('tools/call', { name, arguments: args });
        if (result.isError)
          throw new McpError(`工具 ${name} 执行失败：${extractToolText(result) || '未知错误'}`);
        return result.content ?? result;
      },
      async close() {},
    };
  } catch (error) {
    throw sanitize(error, config.endpoint);
  }
}

function extractToolText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    const block = item as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') return block.text.slice(0, 300);
  }
  return '';
}

/** 发布通道常用工具的高层封装。 */
function toolText(result: unknown): string {
  // callTool 返回 content 块数组；也兼容原始 result 对象。
  const blocks = Array.isArray(result)
    ? result
    : Array.isArray((result as Record<string, unknown>)?.content)
      ? ((result as Record<string, unknown>).content as unknown[])
      : [];
  for (const item of blocks) {
    const block = item as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') return block.text.slice(0, 300);
  }
  return '';
}

export async function mcpCheckLogin(config: McpEndpointConfig): Promise<{
  loggedIn: boolean;
  raw: string;
  tools: McpToolInfo[];
}> {
  const connection = await connectMcp(config);
  try {
    const tools = await connection.listTools();
    if (!tools.some((tool) => tool.name === 'check_login_status'))
      throw new McpError('该端点未提供 check_login_status 工具，请确认部署的是内容发布 MCP');
    const raw = toolText(await connection.callTool('check_login_status', {}));
    return { loggedIn: /已登录|logged.?in|true/i.test(raw), raw, tools };
  } finally {
    await connection.close();
  }
}

export async function mcpPublishContent(
  config: McpEndpointConfig,
  args: {
    title: string;
    content: string;
    images: string[];
    tags?: string[];
    visibility?: string;
    scheduleAt?: string;
  },
): Promise<{ raw: string }> {
  const connection = await connectMcp(config);
  try {
    return {
      raw: toolText(await connection.callTool('publish_content', args as Record<string, unknown>)),
    };
  } finally {
    await connection.close();
  }
}

/** 获取登录二维码（Base64），由前端展示后轮询登录状态。 */
export async function mcpLoginQrcode(config: McpEndpointConfig): Promise<{
  imageDataUrl?: string;
  text: string;
}> {
  const connection = await connectMcp(config);
  try {
    const result = await connection.callTool('get_login_qrcode', {});
    const blocks = Array.isArray(result)
      ? result
      : Array.isArray((result as Record<string, unknown>)?.content)
        ? ((result as Record<string, unknown>).content as unknown[])
        : [];
    let text = '';
    for (const item of blocks) {
      const block = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      if (block.type === 'image' && typeof block.data === 'string') {
        const mime = typeof block.mimeType === 'string' ? block.mimeType : 'image/png';
        return { imageDataUrl: `data:${mime};base64,${block.data}`, text };
      }
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    }
    const base64 = /([A-Za-z0-9+/=]{200,})/.exec(text)?.[1];
    if (base64) return { imageDataUrl: `data:image/png;base64,${base64}`, text };
    return { text: text.slice(0, 300) };
  } finally {
    await connection.close();
  }
}
