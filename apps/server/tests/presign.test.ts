import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/app';
import type { ProjectDetail } from '../../../packages/shared/src/index';

const headers = { host: 'localhost:4317' };

/**
 * Minimal S3-compatible stub that RECOMPUTES SigV4 query-auth signatures with
 * the shared secret. It proves the SDK emits valid presigned URLs and lets the
 * full presigned upload/download flow run against a real HTTP surface. Real
 * MinIO/cloud S3 acceptance still needs network access to the vendor.
 */
function sigV4Stub(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  bucket: string,
): Promise<{ port: number; objects: Map<string, Buffer>; close: () => Promise<void> }> {
  const objects = new Map<string, Buffer>();
  const hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data).digest();
  const verify = (req: IncomingMessage, url: URL) => {
    const q = url.searchParams;
    if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return 'algorithm';
    const credential = q.get('X-Amz-Credential');
    const amzDate = q.get('X-Amz-Date');
    const expires = Number(q.get('X-Amz-Expires') ?? 0);
    const signature = q.get('X-Amz-Signature');
    if (!credential || !amzDate || !signature) return 'missing';
    const match = /^(\d{8})T(\d{6})Z$/.exec(amzDate);
    if (!match) return 'date';
    const requestTime = Date.parse(
      `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}T${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}Z`,
    );
    if (Number.isNaN(requestTime)) return 'date';
    if ((Date.now() - requestTime) / 1000 > expires) return 'expired';
    const scope = credential.split('/').slice(1).join('/');
    const canonicalQuery = [...q.entries()]
      .filter(([k]) => k !== 'X-Amz-Signature')
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const canonical = [
      req.method ?? 'GET',
      url.pathname,
      canonicalQuery,
      `host:${(req.headers.host ?? '').toLowerCase()}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
    const parts = scope.split('/');
    const key = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, parts[0]), parts[1]), parts[2]),
      parts[3],
    );
    const expected = createHmac('sha256', key).update(stringToSign).digest('hex');
    return expected === signature ? '' : 'signature';
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const key = segments.length > 1 ? segments.slice(1).join('/') : '';
    const verdict = verify(req, url);
    // Direct SDK calls authenticate with the Authorization header instead of
    // query parameters; the stub accepts those and fully verifies presigned URLs.
    const headerAuth = String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256');
    if (verdict && !headerAuth) {
      res.statusCode = verdict === 'expired' ? 403 : 400;
      res.end(JSON.stringify({ error: verdict }));
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        res.statusCode = 200;
        res.setHeader('etag', `"${hex(objects.get(key)!)}"`);
        res.end();
      });
      return;
    }
    if (req.method === 'GET') {
      const body = objects.get(key);
      if (!body) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('content-length', body.length);
      res.end(body);
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 400;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        objects,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('presigned direct upload and download round-trip against a SigV4-verifying stub', async () => {
  const stub = await sigV4Stub('zhizuotest', 'zhizuo-stub-secret', 'test', 'zhizuo-bucket');
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-presign-'));
    const state = await createApp({
      dataDir: dir,
      worker: false,
      storage: {
        endpoint: `http://127.0.0.1:${stub.port}`,
        region: 'test',
        bucket: 'zhizuo-bucket',
        accessKeyId: 'zhizuotest',
        secretAccessKey: 'zhizuo-stub-secret',
        forcePathStyle: true,
      },
    });
    try {
      let r = await state.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers,
        payload: { title: '预签名验收' },
      });
      const project = r.json<ProjectDetail>().project;

      // Presign a direct upload; the staging intent holds a lease and a token.
      r = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/uploads/presign`,
        headers,
        payload: { name: '直传商品图.png' },
      });
      assert.equal(r.statusCode, 200, r.body);
      const session = r.json();
      assert.ok(session.uploadUrl.startsWith(`http://127.0.0.1:${stub.port}/zhizuo-bucket/`));
      assert.match(session.uploadUrl, /X-Amz-Signature=/);
      // Completing before any bytes arrive is rejected.
      r = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/uploads/presign/${session.uploadId}/complete`,
        headers,
        payload: { token: session.token, name: '直传商品图.png' },
      });
      assert.equal(r.statusCode, 400, r.body);

      // The client PUTs straight to the presigned URL; the stub verifies SigV4.
      const raw = await sharp({
        create: { width: 640, height: 480, channels: 3, background: '#40624f' },
      })
        .png()
        .toBuffer();
      const put = await fetch(session.uploadUrl, { method: 'PUT', body: raw });
      assert.equal(put.status, 200, `presigned PUT failed: ${await put.text()}`);

      // A tampered signature is rejected by the S3-compatible surface.
      const tampered = `${session.uploadUrl.slice(0, -4)}beef`;
      const rejected = await fetch(tampered, { method: 'PUT', body: raw });
      assert.equal(rejected.status, 400);

      r = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/uploads/presign/${session.uploadId}/complete`,
        headers,
        payload: { token: session.token, name: '直传商品图.png' },
      });
      assert.equal(r.statusCode, 200, r.body);
      const asset = r.json();
      assert.equal(asset.width, 640);
      assert.equal(asset.projectId, project.id);

      // A wrong token cannot complete someone else's staging intent.
      r = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/uploads/presign`,
        headers,
        payload: { name: '第二张.png' },
      });
      const second = r.json();
      await fetch(second.uploadUrl, { method: 'PUT', body: raw });
      r = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/uploads/presign/${second.uploadId}/complete`,
        headers,
        payload: { token: session.token, name: '第二张.png' },
      });
      assert.equal(r.statusCode, 400);

      // An expired lease can no longer be completed.
      await state.db.query(
        `UPDATE documents SET body=body || jsonb_build_object('leaseExpiresAt','2020-01-01T00:00:00Z'::timestamptz)
         WHERE scope='pending_assets' AND id=$1`,
        [second.uploadId],
      );
      r = await state.app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/uploads/presign/${second.uploadId}/complete`,
        headers,
        payload: { token: second.token, name: '第二张.png' },
      });
      assert.equal(r.statusCode, 400);
      assert.match(r.body, /过期/);

      // Presigned download returns a verified GET URL serving identical bytes.
      r = await state.app.inject({
        method: 'GET',
        url: `/api/assets/${asset.id}/download-url`,
        headers,
      });
      assert.equal(r.statusCode, 200, r.body);
      const download = r.json();
      assert.equal(download.mode, 'presigned');
      const got = await fetch(download.url);
      assert.equal(got.status, 200);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), await state.media.bytes(asset.id));

      // The completed upload's staging object was removed; the expired second
      // intent keeps its object until the periodic cleaner reclaims it.
      assert.equal(stub.objects.has(`zhizuo/assets/uploads/${session.uploadId}`), false);
    } finally {
      await state.app.close();
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await stub.close();
  }
});

test('presigned upload is only offered when the storage backend supports it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-presign-local-'));
  const state = await createApp({ dataDir: dir, worker: false });
  try {
    let r = await state.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: { title: '本地存储' },
    });
    const project = r.json<ProjectDetail>().project;
    r = await state.app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/uploads/presign`,
      headers,
      payload: { name: 'x.png' },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /不支持预签名直传/);
    // Local download URLs keep using the authorized API route.
    const picture = await sharp({
      create: { width: 200, height: 160, channels: 3, background: '#7a8a7f' },
    })
      .png()
      .toBuffer();
    const asset = await state.media.ingest(project.id, picture, 'a.png');
    r = await state.app.inject({
      method: 'GET',
      url: `/api/assets/${asset.id}/download-url`,
      headers,
    });
    assert.equal(r.statusCode, 200, r.body);
    const download = r.json();
    assert.equal(download.mode, 'api');
    assert.equal(download.url, `/api/assets/${asset.id}/content`);
  } finally {
    await state.app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
