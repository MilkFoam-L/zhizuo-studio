import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from '../src/app';
import { connectMcp, McpError, mcpCheckLogin, mcpLoginQrcode, mcpPublishContent } from '../src/mcp';

const headers = { host: 'localhost:4317' };

/** JSON-RPC over HTTP 的 MCP stub：校验 Bearer 与会话头，返回固定工具清单。 */
function mcpStub(
  token: string | undefined,
): Promise<{ port: number; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (token) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk as string));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      calls.push(String(payload.method ?? ''));
      if (payload.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'stub-session-1');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: { serverInfo: { name: 'stub' }, capabilities: { tools: {} } },
          }),
        );
        return;
      }
      if (payload.method?.startsWith('notifications/')) {
        res.statusCode = 202;
        res.end();
        return;
      }
      const respond = (result: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      };
      if (payload.method === 'tools/list') {
        respond({
          tools: [
            { name: 'check_login_status', description: '检查登录' },
            { name: 'publish_content', description: '发布图文' },
          ],
        });
        return;
      }
      if (payload.method === 'tools/call') {
        const name = payload.params?.name;
        if (name === 'check_login_status')
          respond({ content: [{ type: 'text', text: '已登录：用户 小织' }] });
        else if (name === 'publish_content')
          respond({ content: [{ type: 'text', text: '发布成功' }] });
        else if (name === 'get_login_qrcode')
          respond({
            content: [
              {
                type: 'image',
                data: 'iVBORw0KGgoAAAANSUhEUg==',
                mimeType: 'image/png',
              },
            ],
          });
        else respond({ content: [{ type: 'text', text: '未知工具' }], isError: true });
        return;
      }
      respond({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('MCP client negotiates sessions, lists tools and publishes content', async (t) => {
  const stub = await mcpStub('stub-secret');
  t.after(async () => {
    await stub.close();
  });
  const endpoint = `http://127.0.0.1:${stub.port}/mcp`;

  const login = await mcpCheckLogin({ endpoint, token: 'stub-secret' });
  assert.equal(login.loggedIn, true);
  assert.match(login.raw, /已登录/);
  assert.ok(stub.calls.includes('initialize'));
  assert.ok(stub.calls.includes('notifications/initialized'));

  const qrcode = await mcpLoginQrcode({ endpoint, token: 'stub-secret' });
  assert.match(qrcode.imageDataUrl ?? '', /^data:image\/png;base64,/);

  const published = await mcpPublishContent(
    { endpoint, token: 'stub-secret' },
    {
      title: '山间茶室上新',
      content: '手作陶瓷杯，今日上新。',
      images: ['/tmp/tea-1.png'],
      tags: ['陶瓷'],
    },
  );
  assert.match(published.raw, /发布成功/);

  // 错误 token 必须被拒绝并脱敏。
  await assert.rejects(
    mcpCheckLogin({ endpoint, token: 'wrong-secret' }),
    (error: unknown) => error instanceof McpError,
  );

  const connection = await connectMcp({ endpoint, token: 'stub-secret' });
  const tools = await connection.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['check_login_status', 'publish_content'],
  );
  await connection.close();
});

test('mcp_servers routes isolate workspaces and mask tokens; check hits the endpoint', async (t) => {
  const stub = await mcpStub(undefined);
  t.after(async () => {
    await stub.close();
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-mcp-api-'));
  const state = await createApp({
    dataDir: dir,
    worker: false,
    accounts: { bootstrap: { email: 'owner@example.test', password: 'owner-password-123' } },
  });
  t.after(async () => {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    cookie?: string,
    payload?: object,
  ) =>
    state.app.inject({
      method,
      url,
      headers: {
        host: 'localhost:4317',
        ...(cookie ? { cookie } : {}),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });
  const login = async (email: string, password: string) => {
    const response = await call('POST', '/api/session', undefined, { email, password });
    assert.equal(response.statusCode, 200, response.body);
    return (response.headers['set-cookie'] as string).split(';')[0];
  };
  const owner = await login('owner@example.test', 'owner-password-123');
  assert.equal((await call('GET', '/api/mcp-servers')).statusCode, 401);

  const created = await call('POST', '/api/mcp-servers', owner, {
    name: '本机发布通道',
    endpoint: `http://127.0.0.1:${stub.port}/mcp`,
    token: 'channel-secret',
  });
  assert.equal(created.statusCode, 200, created.body);
  const server = created.json();
  assert.equal(server.hasToken, true);
  assert.ok(!JSON.stringify(server).includes('channel-secret'));

  // 未认证请求 401；stubs 收到 check 调用并返回登录状态。
  const checked = await call('POST', `/api/mcp-servers/${server.id}/check`, owner);
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().loggedIn, true);
  assert.ok(checked.json().tools.includes('publish_content'));

  // 更新不传 token 保留原凭据；删除后资源消失。
  const updated = await call('PUT', `/api/mcp-servers/${server.id}`, owner, {
    name: '本机发布通道',
    endpoint: `http://127.0.0.1:${stub.port}/mcp`,
    enabled: false,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().enabled, false);
  assert.equal((await call('POST', `/api/mcp-servers/${server.id}/check`, owner)).statusCode, 409);
  assert.equal((await call('DELETE', `/api/mcp-servers/${server.id}`, owner)).statusCode, 200);
  assert.deepEqual(await call('GET', '/api/mcp-servers', owner).then((r) => r.json()), []);
});
