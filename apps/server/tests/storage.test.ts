import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  link,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  createStorage,
  LocalStorage,
  MAX_STORED_BYTES,
  S3Storage,
  StorageError,
  type S3StorageConfig,
  type StorageCommand,
  type StorageSend,
} from '../src/storage.ts';

const id = '44163866-04df-44ef-9d8d-726dc61e937a';
const key = `${id}.png`;
const thumbnailKey = `${id}.thumb.webp`;
const config: S3StorageConfig = {
  endpoint: 'https://storage.example.com',
  region: 'test-region',
  bucket: 'test-bucket',
  accessKeyId: 'private-access-id',
  secretAccessKey: 'private-secret-key',
};

const errorIs = (code: StorageError['code']) => (error: unknown) =>
  error instanceof StorageError && error.code === code;

async function local(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'zhizuo-storage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, storage: new LocalStorage(directory) };
}

function s3Fixture() {
  const objects = new Map<string, Buffer>();
  const calls: StorageCommand[] = [];
  const send: StorageSend = async (command) => {
    calls.push(command);
    const name = `${command.input.Bucket}/${command.input.Key}`;
    if (command instanceof PutObjectCommand) {
      assert.ok(Buffer.isBuffer(command.input.Body));
      objects.set(name, Buffer.from(command.input.Body));
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(name);
      return {};
    }
    const value = objects.get(name);
    if (!value) throw Object.assign(new Error('raw storage error'), { name: 'NoSuchKey' });
    return {
      Body: Readable.from([value.subarray(0, 1), value.subarray(1)]),
      ContentLength: value.length,
    };
  };
  return { objects, calls, send, storage: new S3Storage(config, { send }) };
}

test('local storage keeps existing UUID image/thumbnail paths and private atomic writes', async (t) => {
  const { directory, storage } = await local(t);
  await storage.put(key, Buffer.from('image'), 'image/png');
  await storage.put(thumbnailKey, Buffer.from('thumbnail'), 'image/webp');
  assert.equal((await storage.get(key)).toString(), 'image');
  assert.equal((await storage.get(thumbnailKey)).toString(), 'thumbnail');
  assert.equal((await stat(path.join(directory, 'assets', key))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'assets', thumbnailKey))).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(path.join(directory, 'assets'))).sort(),
    [key, thumbnailKey].sort(),
  );
  await storage.put(key, Buffer.from('replacement'), 'image/png');
  assert.equal((await readFile(path.join(directory, 'assets', key))).toString(), 'replacement');
  await storage.remove(key);
  await storage.remove(key);
  await assert.rejects(storage.get(key), errorIs('NOT_FOUND'));
  assert.equal((await storage.get(thumbnailKey)).toString(), 'thumbnail');
});

test('local readers see complete old or new content during concurrent replacement', async (t) => {
  const { storage } = await local(t);
  const before = Buffer.alloc(200_000, 11);
  const after = Buffer.alloc(250_000, 22);
  await storage.put(key, before, 'image/png');
  await Promise.all([
    (async () => {
      for (let i = 0; i < 6; i++) await storage.put(key, i % 2 ? before : after, 'image/png');
    })(),
    (async () => {
      for (let i = 0; i < 12; i++) {
        const bytes = await storage.get(key);
        assert.ok(bytes.equals(before) || bytes.equals(after));
      }
    })(),
  ]);
});

test('storage keys reject traversal, alternate extensions and malformed UUIDs before IO', async (t) => {
  const { directory, storage: disk } = await local(t);
  const { storage: s3, calls } = s3Fixture();
  for (const storage of [disk, s3]) {
    for (const invalid of [
      `../${key}`,
      `/tmp/${key}`,
      `nested/${key}`,
      `nested\\${key}`,
      `./${key}`,
      `${key}?token=secret`,
      `${key}\0`,
      `${key}\n`,
      `${id}.jpeg`,
      `${id}.webp`,
      `${id}.png.bak`,
      '------------------------------------.png',
      '00000000-0000-0000-0000-000000000000.png',
      key.toUpperCase(),
      '',
    ]) {
      await assert.rejects(
        storage.put(invalid, Buffer.from('x'), 'image/png'),
        errorIs('INVALID_KEY'),
      );
      await assert.rejects(storage.get(invalid), errorIs('INVALID_KEY'));
      await assert.rejects(storage.remove(invalid), errorIs('INVALID_KEY'));
    }
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('both storage backends require matching normalized media types and bounded put bodies', async (t) => {
  const { storage: disk } = await local(t);
  const { storage: s3, calls } = s3Fixture();
  for (const storage of [disk, s3]) {
    await assert.rejects(
      storage.put(key, Buffer.from('x'), 'text/html'),
      errorIs('INVALID_CONTENT_TYPE'),
    );
    await assert.rejects(
      storage.put(key, Buffer.from('x'), 'image/webp'),
      errorIs('INVALID_CONTENT_TYPE'),
    );
    await assert.rejects(
      storage.put(thumbnailKey, Buffer.from('x'), 'image/png'),
      errorIs('INVALID_CONTENT_TYPE'),
    );
    await assert.rejects(
      storage.put(key, Buffer.alloc(MAX_STORED_BYTES + 1), 'image/png'),
      errorIs('TOO_LARGE'),
    );
  }
  assert.equal(calls.length, 0);
});

test('local storage accepts the exact size boundary and rejects oversized existing files', async (t) => {
  const { directory, storage } = await local(t);
  await storage.put(key, Buffer.alloc(MAX_STORED_BYTES, 7), 'image/png');
  const bytes = await storage.get(key);
  assert.equal(bytes.length, MAX_STORED_BYTES);
  assert.equal(bytes[0], 7);
  assert.equal(bytes.at(-1), 7);
  await writeFile(path.join(directory, 'assets', key), Buffer.alloc(MAX_STORED_BYTES + 1));
  await assert.rejects(storage.get(key), errorIs('TOO_LARGE'));
});

test('local storage refuses file symlinks and hardlinks without modifying their target', async (t) => {
  const { directory, storage } = await local(t);
  const outside = path.join(directory, 'private-source');
  await writeFile(outside, 'must stay private');
  await mkdir(path.join(directory, 'assets'));
  await symlink(outside, path.join(directory, 'assets', key));
  await link(outside, path.join(directory, 'assets', thumbnailKey));
  for (const [name, type] of [
    [key, 'image/png'],
    [thumbnailKey, 'image/webp'],
  ]) {
    await assert.rejects(storage.get(name), errorIs('UNSAFE_PATH'));
    await assert.rejects(storage.put(name, Buffer.from('new'), type), errorIs('UNSAFE_PATH'));
    await assert.rejects(storage.remove(name), errorIs('UNSAFE_PATH'));
  }
  assert.equal(await readFile(outside, 'utf8'), 'must stay private');
  assert.equal((await readdir(path.join(directory, 'assets'))).length, 2);
});

test('local storage rejects asset-directory and data-directory symlinks', async (t) => {
  const { directory, storage } = await local(t);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, key), 'private');
  await symlink(outside, path.join(directory, 'assets'));
  await symlink(outside, path.join(directory, 'linked-data'));
  for (const target of [storage, new LocalStorage(path.join(directory, 'linked-data'))]) {
    await assert.rejects(target.get(key), errorIs('UNSAFE_PATH'));
    await assert.rejects(target.put(key, Buffer.from('new'), 'image/png'), errorIs('UNSAFE_PATH'));
    await assert.rejects(target.remove(key), errorIs('UNSAFE_PATH'));
  }
  assert.equal(await readFile(path.join(outside, key), 'utf8'), 'private');
  assert.deepEqual(await readdir(outside), [key]);
});

test('S3 storage issues put/get/delete commands under the fixed application prefix', async () => {
  const { storage, calls, objects } = s3Fixture();
  await storage.put(key, Buffer.from('image'), 'image/png');
  await storage.put(thumbnailKey, Buffer.from('thumbnail'), 'image/webp');
  assert.equal((await storage.get(key)).toString(), 'image');
  assert.equal((await storage.get(thumbnailKey)).toString(), 'thumbnail');
  assert.ok(calls[0] instanceof PutObjectCommand);
  assert.equal(calls[0].input.Key, `zhizuo/assets/${key}`);
  assert.equal(calls[0].input.Bucket, config.bucket);
  assert.equal(calls[0].input.ContentType, 'image/png');
  assert.equal(calls[0].input.ContentLength, 5);
  assert.equal(calls[0].input.CacheControl, 'private, no-store');
  assert.equal(calls[0].input.ACL, undefined);
  assert.equal(calls[1].input.Key, `zhizuo/assets/${thumbnailKey}`);
  assert.ok(calls[2] instanceof GetObjectCommand);
  await storage.remove(key);
  await storage.remove(key);
  assert.ok(calls[4] instanceof DeleteObjectCommand);
  assert.equal(objects.size, 1);
  await assert.rejects(storage.get(key), errorIs('NOT_FOUND'));
});

test('S3 prefixes isolate deployments sharing a bucket without listing or bulk deletion', async () => {
  const { send, objects, calls } = s3Fixture();
  const first = new S3Storage({ ...config, prefix: 'deploy-one/assets/' }, { send });
  const second = new S3Storage({ ...config, prefix: 'deploy-two/assets' }, { send });
  await first.put(key, Buffer.from('first'), 'image/png');
  await second.put(key, Buffer.from('second'), 'image/png');
  await first.remove(key);
  assert.equal((await second.get(key)).toString(), 'second');
  assert.equal(objects.size, 1);
  assert.ok(calls.every((command) => command.input.Key?.startsWith('deploy-')));
  assert.ok(
    calls.every(
      (command) =>
        command instanceof PutObjectCommand ||
        command instanceof GetObjectCommand ||
        command instanceof DeleteObjectCommand,
    ),
  );
});

test('S3 administrator configuration validates HTTPS and hides invalid configuration values', () => {
  const badConfigs = [
    { endpoint: 'http://storage.example.com' },
    { endpoint: 'http://127.0.0.1:9000' },
    { endpoint: 'https://user:private-secret-key@storage.example.com' },
    { endpoint: 'https://storage.example.com?key=private-secret-key' },
    { endpoint: 'https://storage.example.com#private-secret-key' },
    { endpoint: 'https://storage.example.com?' },
    { endpoint: 'https://storage.example.com#' },
    { endpoint: 'https://storage.example.com\n' },
    { endpoint: 'not-a-url-private-secret-key' },
    { bucket: '../private-bucket' },
    { bucket: '127.0.0.1' },
    { bucket: 'invalid..bucket' },
    { region: 'region\nsecret' },
    { accessKeyId: '' },
    { secretAccessKey: 'private-secret-key\nInjected: secret' },
    { prefix: '' },
    { prefix: '/' },
    { prefix: '../other-app' },
    { prefix: 'valid/../other-app' },
    { prefix: '/other-app' },
    { prefix: 'valid//other-app' },
    { prefix: 'x'.repeat(201) },
    { region: undefined },
    { bucket: undefined },
  ];
  for (const invalid of badConfigs) {
    assert.throws(
      () => new S3Storage({ ...config, ...invalid } as S3StorageConfig),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, 'CONFIG_ERROR');
        assert.ok(!error.stack?.includes('private-secret-key'));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test('S3 transport failures and stream errors are redacted for every operation', async () => {
  const send: StorageSend = async () => {
    throw new Error('private-access-id private-secret-key https://private-endpoint/raw-response');
  };
  const storage = new S3Storage(config, { send });
  for (const operation of [
    () => storage.put(key, Buffer.from('x'), 'image/png'),
    () => storage.get(key),
    () => storage.remove(key),
  ]) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, 'IO_ERROR');
      assert.ok(!error.stack?.includes('private-'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  let closed = false;
  const stream = new S3Storage(config, {
    send: async () => ({
      Body: (async function* () {
        try {
          yield Buffer.from('x');
          throw new Error('private-secret-key raw error');
        } finally {
          closed = true;
        }
      })(),
    }),
  });
  await assert.rejects(stream.get(key), errorIs('IO_ERROR'));
  assert.equal(closed, true);
});

test('S3 reads enforce advertised size before iteration and close the unread response stream', async () => {
  let read = false;
  let destroyed = false;
  const body = {
    destroy() {
      destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      read = true;
      yield Buffer.from('x');
    },
  };
  const storage = new S3Storage(config, {
    send: async () => ({ Body: body, ContentLength: MAX_STORED_BYTES + 1 }),
  });
  await assert.rejects(storage.get(key), errorIs('TOO_LARGE'));
  assert.equal(read, false);
  assert.equal(destroyed, true);
});

test('S3 reads bound streamed bytes even without a trusted Content-Length', async () => {
  for (const contentLength of [undefined, 1]) {
    let closed = false;
    const storage = new S3Storage(config, {
      send: async () => ({
        ContentLength: contentLength,
        Body: (async function* () {
          try {
            const chunk = Buffer.alloc(1024 * 1024);
            for (let i = 0; i < 41; i++) yield chunk;
            assert.fail('must stop on the first oversized chunk');
          } finally {
            closed = true;
          }
        })(),
      }),
    });
    await assert.rejects(storage.get(key), errorIs('TOO_LARGE'));
    assert.equal(closed, true);
  }
});

test('S3 reads reject truncated/malformed bodies and accept an exact-limit stream', async () => {
  for (const result of [
    { Body: Buffer.from('x'), ContentLength: 2 },
    { Body: Readable.from([Buffer.from('x')]), ContentLength: 2 },
    { Body: Readable.from(['string-chunk']) },
    { Body: Buffer.from('x'), ContentLength: -1 },
    { Body: Buffer.from('x'), ContentLength: Number.NaN },
    { Body: undefined },
  ]) {
    const storage = new S3Storage(config, { send: async () => result });
    await assert.rejects(storage.get(key), errorIs('IO_ERROR'));
  }
  const storage = new S3Storage(config, {
    send: async () => ({
      ContentLength: MAX_STORED_BYTES,
      Body: (async function* () {
        for (let i = 0; i < 40; i++) yield Buffer.alloc(1024 * 1024, i);
      })(),
    }),
  });
  const bytes = await storage.get(key);
  assert.equal(bytes.length, MAX_STORED_BYTES);
  assert.equal(bytes[0], 0);
  assert.equal(bytes.at(-1), 39);
});

test('S3 deletion is idempotent only for missing objects, not denied or missing buckets', async () => {
  for (const name of ['NoSuchKey', 'NotFound']) {
    const storage = new S3Storage(config, {
      send: async () => {
        throw Object.assign(new Error('secret'), { name });
      },
    });
    await storage.remove(key);
    await assert.rejects(storage.get(key), errorIs('NOT_FOUND'));
  }
  for (const name of ['AccessDenied', 'NoSuchBucket']) {
    const storage = new S3Storage(config, {
      send: async () => {
        throw Object.assign(new Error('secret'), { name });
      },
    });
    await assert.rejects(storage.remove(key), errorIs('IO_ERROR'));
  }
});

test('factory defaults to local and creates an HTTPS S3 client with explicit administrator config', () => {
  assert.ok(createStorage('/unused') instanceof LocalStorage);
  const storage = createStorage('/unused', config);
  assert.ok(storage instanceof S3Storage);
  storage.close?.();
});
