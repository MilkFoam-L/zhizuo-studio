import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderClient,
  decryptSecret,
  encryptSecret,
  ProviderCancelledError,
  ProviderUncertainError,
  validateProviderInput,
  type ProviderTransportOptions,
} from '../src/providers.ts';
import {
  EMPTY_BRIEF,
  type AsyncMapping,
  type CopyDraft,
  type ProviderInput,
} from '../../../packages/shared/src/index.ts';

type Request = Parameters<NonNullable<ProviderTransportOptions['send']>>[0];
type Response = Awaited<ReturnType<NonNullable<ProviderTransportOptions['send']>>>;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQJ0AAAAASUVORK5CYII=',
  'base64',
);
const config: ProviderInput = {
  name: '测试接入',
  kind: 'openai',
  baseUrl: 'https://api.example.com/v1',
  textModel: 'test-text',
  imageModel: 'test-image',
  timeoutSeconds: 30,
};
const mapping: AsyncMapping = {
  submitPath: '/tasks',
  pollPath: '/tasks/{taskId}',
  taskIdPath: 'data.id',
  statusPath: 'data.status',
  successValue: 'done',
  failureValue: 'error',
  resultUrlPath: 'data.output.url',
};
const brief = { ...EMPTY_BRIEF, productName: '棉布包', sellingPoints: '米白色', confirmed: true };
const draft: CopyDraft = {
  titles: ['日常布包'],
  body: '米白色布包，搭配日常。',
  tags: ['日常穿搭'],
  pages: [{ headline: '米白日常', body: '根据已确认商品信息整理' }],
  warnings: ['尺寸未提供'],
};
const ok = (body: unknown, status = 200): Response => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
});
const image = (): Response => ({
  status: 200,
  headers: { 'content-type': 'image/png' },
  body: png,
});
const signal = () => new AbortController().signal;

function harness(
  responses: (Response | Error | ((request: Request) => Promise<Response>))[],
  options: ProviderTransportOptions = {},
) {
  const calls: Request[] = [];
  const client = createProviderClient({
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    wait: async () => {},
    send: async (request) => {
      calls.push(request);
      const response = responses.shift();
      if (!response) throw new Error('No fixture response');
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(request) : response;
    },
    ...options,
  });
  return { ...client, calls };
}

test('provider configuration validates normalized HTTPS endpoints and model requirements', () => {
  assert.equal(
    validateProviderInput({ ...config, baseUrl: 'https://api.example.com/v1/' }).baseUrl,
    config.baseUrl,
  );
  for (const input of [
    { ...config, baseUrl: 'http://api.example.com' },
    { ...config, baseUrl: 'https://localhost/v1' },
    { ...config, baseUrl: 'https://127.1/v1' },
    { ...config, baseUrl: 'https://0x7f000001/' },
    { ...config, baseUrl: 'https://user:password@api.example.com' },
    { ...config, baseUrl: 'https://api.example.com?key=secret' },
    { ...config, baseUrl: 'https://[::ffff:127.0.0.1]/' },
    { ...config, timeoutSeconds: 0 },
    { ...config, timeoutSeconds: 301 },
    { ...config, textModel: '', imageModel: '' },
    { ...config, kind: 'unsupported' },
    { ...config, apiKey: 'key\nInjected: value' },
  ])
    assert.throws(() => validateProviderInput(input));
});

test('async mappings allow object fields only, with no script execution or path traversal', () => {
  const input = { ...config, kind: 'async-json', asyncMapping: mapping };
  assert.deepEqual(validateProviderInput(input).asyncMapping, mapping);
  for (const asyncMapping of [
    { ...mapping, taskIdPath: '__proto__.id' },
    { ...mapping, resultUrlPath: 'data.constructor.value' },
    { ...mapping, taskIdPath: 'data[0].id' },
    { ...mapping, taskIdPath: '(() => fetch())()' },
    { ...mapping, submitPath: 'https://example.com/tasks' },
    { ...mapping, submitPath: '/../tasks' },
    { ...mapping, submitPath: '//private/tasks' },
    { ...mapping, pollPath: '/tasks' },
    { ...mapping, pollPath: '/{taskId}/{taskId}' },
    { ...mapping, failureValue: 'done' },
  ])
    assert.throws(() => validateProviderInput({ ...input, asyncMapping }));
});

test('AES-GCM encrypts keys with unique IVs and rejects tampering/wrong keys', () => {
  const key = 'ab'.repeat(32);
  const encrypted = encryptSecret('sk-secret-测试', key);
  assert.equal(decryptSecret(encrypted, key), 'sk-secret-测试');
  assert.notEqual(encryptSecret('sk-secret-测试', key), encrypted);
  assert.ok(!encrypted.includes('sk-secret'));
  const parts = encrypted.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptSecret(parts.join('.'), key), /无法解密/);
  assert.throws(() => decryptSecret(encrypted, 'cd'.repeat(32)), /无法解密/);
  assert.throws(() => encryptSecret('secret', 'short'), /32 字节/);
  assert.equal(decryptSecret(encryptSecret('', key), key), '');
});

test('connection probe is a non-billable model-list GET and pins resolved IP', async () => {
  const client = harness([ok({ data: [{ id: 'test-text' }] })]);
  const result = await client.testConnection(config, 'private-key');
  assert.equal(result.ok, true);
  assert.match(result.message, /实际任务验证/);
  assert.equal(client.calls[0].url.href, 'https://api.example.com/v1/models');
  assert.equal(client.calls[0].method, 'GET');
  assert.equal(client.calls[0].headers.Authorization, 'Bearer private-key');
  assert.deepEqual(client.calls[0].address, { address: '1.1.1.1', family: 4 });
});

test('async protocol explicitly cannot claim connectivity without a standard probe', async () => {
  const client = harness([]);
  const result = await client.testConnection(
    { ...config, kind: 'async-json', asyncMapping: mapping },
    'private-key',
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /可能产生费用/);
  assert.equal(client.calls.length, 0);
});

test('OpenAI copy request uses grounded structured output and validates its result', async () => {
  const client = harness([ok({ choices: [{ message: { content: JSON.stringify(draft) } }] })]);
  assert.deepEqual(
    await client.generateCopy(config, 'private-key', brief, '生成三页', signal()),
    draft,
  );
  const payload = JSON.parse(client.calls[0].body!.toString());
  assert.equal(client.calls[0].url.pathname, '/v1/chat/completions');
  assert.equal(payload.model, 'test-text');
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.match(payload.messages[0].content, /不得编造亲身体验、销量、评价、认证/);
  assert.equal(JSON.parse(payload.messages[1].content).confirmedProductFacts.productName, '棉布包');
});

test('copy rejects unconfirmed briefs, unsupported protocol and invalid structured results', async () => {
  const client = harness([ok({ choices: [{ message: { content: '{"titles":[]}' } }] })]);
  await assert.rejects(
    client.generateCopy(config, 'key', { ...brief, confirmed: false }, '', signal()),
    /确认商品事实/,
  );
  await assert.rejects(
    client.generateCopy(
      { ...config, kind: 'async-json', asyncMapping: mapping },
      'key',
      brief,
      '',
      signal(),
    ),
    /仅支持图片/,
  );
  assert.equal(client.calls.length, 0);
  await assert.rejects(client.generateCopy(config, 'key', brief, '', signal()), /文案必须包含/);
});

test('Gemini text protocol puts its key in headers and requests JSON without leaking it into URL', async () => {
  const client = harness([
    ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }] }),
  ]);
  assert.deepEqual(
    await client.generateCopy(
      { ...config, kind: 'gemini', baseUrl: 'https://api.example.com/v1beta' },
      'private-key',
      brief,
      '写中文文案',
      signal(),
    ),
    draft,
  );
  const req = client.calls[0];
  assert.equal(req.url.pathname, '/v1beta/models/test-text:generateContent');
  assert.equal(req.url.search, '');
  assert.equal(req.headers['x-goog-api-key'], 'private-key');
  assert.equal(req.headers.Authorization, undefined);
  const payload = JSON.parse(req.body!.toString());
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.match(payload.systemInstruction.parts[0].text, /不得编造/);
});

test('OpenAI image generation consumes base64 image result', async () => {
  const client = harness([ok({ data: [{ b64_json: png.toString('base64') }] })]);
  const result = await client.generateImage(config, 'key', '米白色布包', undefined, signal());
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.bytes, png);
  assert.equal(client.calls[0].url.pathname, '/v1/images/generations');
  assert.deepEqual(JSON.parse(client.calls[0].body!.toString()), {
    model: 'test-image',
    prompt: '米白色布包',
    n: 1,
    size: '1024x1024',
  });
});

test('reference image uses OpenAI multipart edits with a safe fixed filename', async () => {
  const client = harness([ok({ data: [{ b64_json: png.toString('base64') }] })]);
  await client.generateImage(
    config,
    'key',
    '保留商品外观',
    { bytes: png, mime: 'image/png', name: 'bad"\r\nInjected: value' },
    signal(),
  );
  const req = client.calls[0];
  assert.equal(req.url.pathname, '/v1/images/edits');
  assert.match(req.headers['Content-Type'], /^multipart\/form-data; boundary=zhizuo-/);
  assert.match(req.body!.toString(), /name="image"; filename="reference.png"/);
  assert.ok(req.body!.includes(png));
  assert.ok(!req.body!.toString().includes('Injected'));
});

test('Gemini images use native inline data and parse image parts', async () => {
  const client = harness([
    ok({
      candidates: [
        {
          content: {
            parts: [
              { text: '图片结果' },
              { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
            ],
          },
        },
      ],
    }),
  ]);
  const result = await client.generateImage(
    { ...config, kind: 'gemini' },
    'key',
    '保留商品',
    { bytes: png, mime: 'image/png', name: 'product.png' },
    signal(),
  );
  assert.deepEqual(result.bytes, png);
  const payload = JSON.parse(client.calls[0].body!.toString());
  assert.deepEqual(payload.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(payload.contents[0].parts[1], {
    inlineData: { mimeType: 'image/png', data: png.toString('base64') },
  });
});

test('image results download without forwarding provider credentials, including public redirects', async () => {
  const client = harness([
    ok({ data: [{ url: 'https://images.example.com/result.png?signature=value' }] }),
    {
      status: 302,
      headers: { location: 'https://cdn.example.com/final.png' },
      body: Buffer.alloc(0),
    },
    image(),
  ]);
  const result = await client.generateImage(config, 'private-key', '商品图', undefined, signal());
  assert.deepEqual(result.bytes, png);
  assert.deepEqual(client.calls[1].headers, {});
  assert.deepEqual(client.calls[2].headers, {});
});

test('async JSON submits once, polls mapped fields and downloads the final image', async () => {
  const client = harness([
    ok({ data: { id: 'job-123' } }),
    ok({ data: { status: 'running' } }),
    ok({ data: { status: 'done', output: { url: 'https://images.example.com/result.png' } } }),
    image(),
  ]);
  const result = await client.generateImage(
    { ...config, kind: 'async-json', asyncMapping: mapping },
    'key',
    '参考图重绘',
    { bytes: png, mime: 'image/png', name: 'product.png' },
    signal(),
  );
  assert.deepEqual(result.bytes, png);
  assert.deepEqual(JSON.parse(client.calls[0].body!.toString()), {
    model: 'test-image',
    prompt: '参考图重绘',
    image: `data:image/png;base64,${png.toString('base64')}`,
  });
  assert.equal(client.calls[1].url.pathname, '/v1/tasks/job-123');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(client.calls[1].headers.Authorization, 'Bearer key');
  assert.deepEqual(client.calls[3].headers, {});
});

test('async jobs preserve uncertainty when task ID or status mapping is missing', async () => {
  const cfg = { ...config, kind: 'async-json' as const, asyncMapping: mapping };
  for (const responses of [
    [ok({})],
    [ok({ data: { id: '../private' } })],
    [ok({ data: { id: 'job' } }), ok({ unknown: true })],
  ]) {
    const client = harness(responses);
    await assert.rejects(
      client.generateImage(cfg, 'key', '商品图', undefined, signal()),
      ProviderUncertainError,
    );
    assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  }
});

test('async polling has a hard request-count bound and never repeats submission', async () => {
  let count = 0;
  const client = harness([], {
    send: async (req) => {
      count++;
      return req.method === 'POST'
        ? ok({ data: { id: 'job' } })
        : ok({ data: { status: 'running' } });
    },
  });
  await assert.rejects(
    client.generateImage(
      { ...config, kind: 'async-json', asyncMapping: mapping },
      'key',
      '商品图',
      undefined,
      signal(),
    ),
    /60 次查询/,
  );
  assert.equal(count, 61);
});

test('explicit async failure is terminal and does not echo service response details', async () => {
  const client = harness([
    ok({ data: { id: 'job' } }),
    ok({ data: { status: 'error', message: 'secret-provider-body' } }),
  ]);
  await assert.rejects(
    client.generateImage(
      { ...config, kind: 'async-json', asyncMapping: mapping },
      'key',
      '商品图',
      undefined,
      signal(),
    ),
    (error) =>
      error instanceof Error &&
      !(error instanceof ProviderUncertainError) &&
      /报告图片生成失败/.test(error.message) &&
      !error.message.includes('secret-provider-body'),
  );
});

test('DNS lookup rejects private, mixed public/private, reserved and transition addresses', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.20.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.2.3',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2002:7f00:1::',
    '2001:db8::1',
    '2001:0000:ffff::1',
  ]) {
    const client = harness([], {
      resolve: async () => [
        { address: '1.1.1.1', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ],
    });
    const result = await client.testConnection(config, 'key');
    assert.equal(result.ok, false, address);
    assert.match(result.message, /内网或保留地址/, address);
    assert.equal(client.calls.length, 0);
  }
});

test('public global IPv6 is eligible for pinned HTTPS', async () => {
  const client = harness([ok({ data: [] })], {
    resolve: async () => [{ address: '2606:4700:4700::1111', family: 6 }],
  });
  assert.equal((await client.testConnection(config, 'key')).ok, true);
  assert.equal(client.calls[0].address.family, 6);
});

test('authenticated redirect cannot leak credentials to a different origin', async () => {
  const client = harness([
    {
      status: 302,
      headers: { location: 'https://other.example.com/models' },
      body: Buffer.alloc(0),
    },
  ]);
  const result = await client.testConnection(config, 'private-key');
  assert.equal(result.ok, false);
  assert.match(result.message, /不允许跨站重定向/);
  assert.equal(client.calls.length, 1);
});

test('same-origin redirect revalidates DNS, preventing rebinding', async () => {
  let count = 0;
  const client = harness(
    [{ status: 302, headers: { location: '/models-v2' }, body: Buffer.alloc(0) }],
    { resolve: async () => [{ address: count++ ? '127.0.0.1' : '1.1.1.1', family: 4 }] },
  );
  const result = await client.testConnection(config, 'private-key');
  assert.equal(result.ok, false);
  assert.match(result.message, /内网或保留地址/);
  assert.equal(client.calls.length, 1);
});

test('result URL and download redirects cannot access private addresses', async () => {
  for (const url of ['http://169.254.169.254/', 'https://127.0.0.1/', 'https://[::1]/']) {
    const client = harness([ok({ data: [{ url }] })]);
    await assert.rejects(
      client.generateImage(config, 'key', '商品图', undefined, signal()),
      ProviderUncertainError,
    );
    assert.equal(client.calls.length, 1);
  }
  const client = harness([
    ok({ data: [{ url: 'https://images.example.com/image' }] }),
    { status: 302, headers: { location: 'https://10.0.0.1/private' }, body: Buffer.alloc(0) },
  ]);
  await assert.rejects(
    client.generateImage(config, 'key', '商品图', undefined, signal()),
    ProviderUncertainError,
  );
  assert.equal(client.calls.length, 2);
});

test('paid POST network errors, 5xx, redirects and invalid JSON remain uncertain with no replay', async () => {
  for (const response of [
    new Error('private-key raw network error'),
    ok({ error: 'private-key' }, 503),
    { status: 307, headers: { location: '/new-endpoint' }, body: Buffer.alloc(0) },
    { status: 200, headers: {}, body: Buffer.from('<html>private-key</html>') },
  ]) {
    const client = harness([response]);
    await assert.rejects(
      client.generateImage(config, 'private-key', '商品图', undefined, signal()),
      (error) => error instanceof ProviderUncertainError && !error.message.includes('private-key'),
    );
    assert.equal(client.calls.length, 1);
  }
});

test('cancelling an in-flight paid submission produces an uncertain result', async () => {
  const controller = new AbortController();
  const client = harness([
    async () => {
      controller.abort();
      return new Promise(() => {});
    },
  ]);
  await assert.rejects(
    client.generateImage(config, 'key', '商品图', undefined, controller.signal),
    ProviderUncertainError,
  );
  assert.equal(client.calls.length, 1);
});

test('already cancelled calls and unresponsive DNS terminate without submission', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = harness([]);
  await assert.rejects(
    client.generateImage(config, 'key', '商品图', undefined, controller.signal),
    /取消|超时/,
  );
  assert.equal(client.calls.length, 0);
  const pendingController = new AbortController();
  const pending = harness([], { resolve: () => new Promise(() => {}) });
  const probe = pending.testConnection(config, 'key', pendingController.signal);
  pendingController.abort();
  assert.equal((await probe).ok, false);
});

test('provider error responses never expose body or key in user-facing messages', async () => {
  const client = harness([ok({ error: 'private-key and internal body' }, 401)]);
  const result = await client.testConnection(config, 'private-key');
  assert.equal(result.ok, false);
  assert.match(result.message, /拒绝了密钥/);
  assert.ok(!result.message.includes('private-key'));
  assert.ok(!result.message.includes('internal body'));
});

test('download limits and unsupported image content are surfaced as already-paid uncertainty', async () => {
  for (const response of [
    {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('<svg>not a bitmap</svg>'),
    },
    { status: 200, headers: {}, body: Buffer.alloc(20 * 1024 * 1024 + 1) },
  ]) {
    const client = harness([
      ok({ data: [{ url: 'https://images.example.com/result' }] }),
      response,
    ]);
    await assert.rejects(
      client.generateImage(config, 'key', '商品图', undefined, signal()),
      (error) => error instanceof ProviderUncertainError && /可能已计费/.test(error.message),
    );
  }
});

test('malformed reference-edit and Gemini image responses retain potential billing context', async () => {
  const edits = harness([
    { status: 200, headers: {}, body: Buffer.from('<html>upstream error</html>') },
  ]);
  await assert.rejects(
    edits.generateImage(
      config,
      'key',
      '参考图',
      { bytes: png, mime: 'image/png', name: 'product.png' },
      signal(),
    ),
    (error) => error instanceof ProviderUncertainError && /可能已计费/.test(error.message),
  );
  const gemini = harness([
    ok({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW52YWxpZA==' } }] } },
      ],
    }),
  ]);
  await assert.rejects(
    gemini.generateImage({ ...config, kind: 'gemini' }, 'key', '商品图', undefined, signal()),
    (error) => error instanceof ProviderUncertainError && /可能已计费/.test(error.message),
  );
});

test('async submission awaits the durable task-ID callback before its first GET', async () => {
  let checkpointed = false;
  const client = harness([
    ok({ data: { id: 1234 } }),
    async () => {
      assert.equal(checkpointed, true);
      return ok({
        data: { status: 'done', output: { url: 'https://images.example.com/result.png' } },
      });
    },
    image(),
  ]);
  const result = await client.generateImage(
    { ...config, kind: 'async-json', asyncMapping: mapping },
    'private-key',
    '商品图',
    undefined,
    signal(),
    async (taskId) => {
      assert.equal(taskId, '1234');
      assert.equal(client.calls.length, 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      checkpointed = true;
    },
  );
  assert.deepEqual(result.bytes, png);
  assert.deepEqual(
    client.calls.map((call) => call.method),
    ['POST', 'GET', 'GET'],
  );
});

test('failed async checkpoint does not poll or resubmit and hides persistence error details', async () => {
  const client = harness([ok({ data: { id: 'job' } })]);
  await assert.rejects(
    client.generateImage(
      { ...config, kind: 'async-json', asyncMapping: mapping },
      'private-key',
      '商品图',
      undefined,
      signal(),
      async () => {
        throw new Error('database contained private-key and internal SQL');
      },
    ),
    (error) =>
      error instanceof ProviderUncertainError &&
      /任务 ID 失败/.test(error.message) &&
      !error.message.includes('private-key') &&
      !error.message.includes('SQL'),
  );
  assert.deepEqual(
    client.calls.map((call) => call.method),
    ['POST'],
  );
});

test('resumed async images only query the saved ID and download without credentials', async () => {
  const client = harness([
    ok({ data: { status: 'running' } }),
    ok({ data: { status: 'done', output: { url: 'https://images.example.com/result.png' } } }),
    image(),
  ]);
  const result = await client.resumeImage(
    { ...config, kind: 'async-json', asyncMapping: mapping },
    'private-key',
    'persisted-123',
    signal(),
  );
  assert.deepEqual(result.bytes, png);
  assert.deepEqual(
    client.calls.map((call) => call.method),
    ['GET', 'GET', 'GET'],
  );
  assert.equal(client.calls[0].url.href, 'https://api.example.com/v1/tasks/persisted-123');
  assert.equal(client.calls[0].headers.Authorization, 'Bearer private-key');
  assert.deepEqual(client.calls[2].headers, {});
  assert.ok(client.calls.every((call) => !call.url.href.includes('private-key')));
});

test('resume validates protocol, task ID and cancellation without any remote request', async () => {
  const client = harness([]);
  await assert.rejects(client.resumeImage(config, 'key', 'job', signal()), /只有异步 JSON/);
  const cfg = { ...config, kind: 'async-json' as const, asyncMapping: mapping };
  for (const id of ['', '../admin', 'job?key=secret', 'x'.repeat(201)]) {
    await assert.rejects(client.resumeImage(cfg, 'key', id, signal()), /任务 ID 无效/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.resumeImage(cfg, 'key', 'job', controller.signal),
    ProviderUncertainError,
  );
  assert.equal(client.calls.length, 0);
});

test('resume remains bounded and terminal supplier failure or cancellation never exposes response data', async () => {
  const cfg = { ...config, kind: 'async-json' as const, asyncMapping: mapping };
  for (const state of ['error', 'cancelled', 'canceled']) {
    const client = harness([
      ok({ data: { status: state, message: 'private-key internal-response' } }),
    ]);
    await assert.rejects(
      client.resumeImage(cfg, 'private-key', 'job', signal()),
      (error) =>
        error instanceof Error &&
        !(error instanceof ProviderUncertainError) &&
        (state === 'error' || error instanceof ProviderCancelledError) &&
        !error.message.includes('private-key') &&
        !error.message.includes('internal-response'),
    );
    assert.deepEqual(
      client.calls.map((call) => call.method),
      ['GET'],
    );
  }
  let queries = 0;
  const bounded = harness([], {
    send: async (req) => {
      assert.equal(req.method, 'GET');
      queries++;
      return ok({ data: { status: 'running' } });
    },
  });
  await assert.rejects(bounded.resumeImage(cfg, 'key', 'job', signal()), /60 次查询/);
  assert.equal(queries, 60);
});
