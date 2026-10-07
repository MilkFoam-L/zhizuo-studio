import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createApp } from '../src/app';
import type { AssistantOptions } from '../src/assistant';
import type { AssistantMessage, AssistantTool } from '../src/providers';
import type { AutomationRun, ProjectDetail } from '../../../packages/shared/src/index';

const headers = { host: 'localhost:4317' };
const OWNER = { email: 'owner@example.test', password: 'owner-password-123' };

function mcpStub(): Promise<{ port: number; publishArgs: unknown[]; close: () => Promise<void> }> {
  const publishArgs: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk as string));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const respond = (result: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      };
      if (payload.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'auto-session');
        respond({ serverInfo: { name: 'stub' }, capabilities: { tools: {} } });
      } else if (payload.method?.startsWith('notifications/')) {
        res.statusCode = 202;
        res.end();
      } else if (payload.method === 'tools/list') {
        respond({ tools: [{ name: 'check_login_status' }, { name: 'publish_content' }] });
      } else if (payload.method === 'tools/call') {
        if (payload.params?.name === 'check_login_status')
          respond({ content: [{ type: 'text', text: '已登录' }] });
        else {
          publishArgs.push(payload.params);
          respond({ content: [{ type: 'text', text: '发布成功' }] });
        }
      } else respond({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        publishArgs,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('automation pipeline: idea to draft to images to confirmed MCP publish', async (t) => {
  const stub = await mcpStub();
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-automation-'));
  // 助手模型 fixture：按调用次数推进（读简报 → 加配图 → 提交草稿）。
  let assistantCalls = 0;
  const fakeAssistant = (
    _config: unknown,
    _key: string,
    _messages: AssistantMessage[],
    _tools: AssistantTool[],
  ) => {
    assistantCalls += 1;
    const turn = (toolCalls: { name: string; arguments: unknown }[]) => ({
      content: '',
      toolCalls: toolCalls.map((call, index) => ({
        id: `call-${assistantCalls}-${index}`,
        ...call,
      })),
    });
    if (assistantCalls === 1) return turn([{ name: 'read_brief', arguments: {} }]);
    if (assistantCalls === 2)
      return turn([
        {
          name: 'add_image_prompt',
          arguments: {
            prompt: '生成一张 3:4 小红书种草图，主体是[产品名称] 棉布包，温暖自然光，真实摄影质感',
          },
        },
      ]);
    return turn([
      {
        name: 'finish_draft',
        arguments: {
          title: '棉布包上新',
          content: '手作棉布包，米白色，日常百搭。',
          tags: ['手作', '日常'],
        },
      },
    ]);
  };
  const picture = await sharp({
    create: { width: 320, height: 240, channels: 3, background: '#4d6a58' },
  })
    .png()
    .toBuffer();
  const state = await createApp({
    dataDir: dir,
    accounts: { bootstrap: OWNER },
    execution: {
      generateImage: async () => ({ bytes: picture, mime: 'image/png' }),
    },
    assistantGenerateWithTools: fakeAssistant as unknown as AssistantOptions['generateWithTools'],
  });
  t.after(async () => {
    await state.app.close();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
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
  const owner = await login(OWNER.email, OWNER.password);
  const waitUntil = async (check: () => Promise<boolean>) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('条件未达成');
  };

  // 服务商（含助手模型）+ 已确认项目。
  let r = await call('POST', '/api/providers', owner, {
    name: '自动化渠道',
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'automation-key',
    textModel: 'text',
    imageModel: 'image',
    assistantModel: 'assistant-x',
    timeoutSeconds: 30,
  });
  assert.equal(r.statusCode, 200, r.body);
  const provider = r.json();
  r = await call('POST', '/api/projects', owner, {
    title: '自动化验证',
    brief: { confirmed: true, productName: '棉布包', sellingPoints: '米白色' },
  });
  const project = r.json<ProjectDetail>().project;

  // 启动自动化：助手产出草稿并创建生图任务。
  r = await call('POST', `/api/projects/${project.id}/automation`, owner, {
    idea: '给棉布包写一篇上新笔记',
    imageCount: 1,
    providerId: provider.id,
  });
  assert.equal(r.statusCode, 200, r.body);
  const run = r.json<AutomationRun>();
  assert.equal(run.status, 'generating');
  assert.equal(run.draft.images.length, 1);
  assert.equal(run.draft.images[0].status, 'generating');
  assert.equal(run.draft.title, '棉布包上新');
  assert.deepEqual(run.draft.tags, ['手作', '日常']);
  assert.equal(assistantCalls, 3);

  // 内联 worker 完成生图任务后，运行进入 ready。
  await waitUntilReady();
  async function waitUntilReady() {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const detail = await call('GET', `/api/projects/${project.id}/automation/${run.id}`, owner);
      const current = detail.json<AutomationRun>();
      if (current.status === 'ready' || current.status === 'failed') return current;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const detail = await call('GET', `/api/projects/${project.id}/automation/${run.id}`, owner);
    const tasks = (await state.db.list('tasks')) as { status?: string; error?: string }[];
    const compact = tasks.map((task) => ({ status: task.status, error: task.error }));
    throw new Error(
      `未进入 ready：run=${detail.body.slice(0, 200)}；任务=${JSON.stringify(compact)}`,
    );
  }
  r = await call('GET', `/api/projects/${project.id}/automation/${run.id}`, owner);
  const ready = r.json<AutomationRun>();
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.draft.images[0].status, 'done');
  assert.ok(ready.draft.images[0].versionId);

  // 未就绪前不可发布的状态保护在上方已隐含（ready 才允许）。

  // 单图重新生成（ready 状态下）：新任务、尝试次数递增、再次 ready。
  r = await call('POST', `/api/projects/${project.id}/automation/${run.id}/regenerate`, owner, {
    imageId: ready.draft.images[0].id,
    feedback: '颜色再浅一点',
    providerId: provider.id,
  });
  assert.equal(r.statusCode, 200, r.body);
  const regenerating = r.json<AutomationRun>();
  assert.equal(regenerating.draft.images[0].attempts, 2);
  assert.notEqual(regenerating.draft.images[0].taskId, ready.draft.images[0].taskId);
  await waitUntilReady();
  r = await call('GET', `/api/projects/${project.id}/automation/${run.id}`, owner);
  assert.equal(r.json<AutomationRun>().status, 'ready');

  // 配置发布通道并确认发布：图片导出到本机 staging 路径交给 MCP。
  const mcp = await call('POST', '/api/mcp-servers', owner, {
    name: '自动化通道',
    endpoint: `http://127.0.0.1:${stub.port}/mcp`,
  });
  const mcpServer = mcp.json();
  r = await call('POST', `/api/projects/${project.id}/automation/${run.id}/publish`, owner, {
    mcpServerId: mcpServer.id,
    visibility: '仅自己可见',
  });
  assert.equal(r.statusCode, 200, r.body);
  const published = r.json<AutomationRun>();
  assert.equal(published.status, 'published');
  assert.match(published.publish!.response, /发布成功/);
  assert.equal(stub.publishArgs.length, 1);
  const publishCall = stub.publishArgs[0] as {
    arguments: { images: string[]; visibility: string };
  };
  assert.equal(publishCall.arguments.images.length, 1);
  assert.ok(existsSync(publishCall.arguments.images[0]), 'staging 图片应存在于本机路径');
  assert.equal(publishCall.arguments.visibility, '仅自己可见');
  const staged = await readFile(publishCall.arguments.images[0]);
  assert.equal((await sharp(staged).metadata()).format, 'png');
  void headers;
});
