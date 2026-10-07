import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_STORED_BYTES = 40 * 1024 * 1024;

export interface PresignedTarget {
  url: string;
  expiresAt: string;
}
export interface BlobStorage {
  readonly identity: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** Presigned direct transfer is opt-in per backend; local disk never offers it. */
  presign?(key: string, ttlSeconds: number, method: 'put' | 'get'): Promise<PresignedTarget>;
  close?(): void;
}

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  prefix?: string;
}

const messages = {
  INVALID_KEY: '无效素材存储标识',
  INVALID_CONTENT_TYPE: '素材存储类型与文件扩展名不匹配',
  TOO_LARGE: '素材超过 40 MiB 存储限制',
  NOT_FOUND: '素材文件不存在',
  UNSAFE_PATH: '素材存储目录或文件不安全，请检查符号链接和文件权限',
  CONFIG_ERROR: '对象存储配置无效，请检查 HTTPS 地址、区域、存储桶、前缀和凭据',
  IO_ERROR: '素材存储操作失败，请检查存储服务、权限和可用空间',
} as const;

export class StorageError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'StorageError';
  }
}

function validateKey(key: string) {
  if (
    typeof key !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:png|thumb\.webp)$/.test(
      key,
    )
  )
    throw new StorageError('INVALID_KEY');
}

// Presigned staging objects live under uploads/ and never become assets directly.
export const stagingKeyPattern = /^uploads\/[a-f0-9-]{36}$/;
function validateStagingKey(key: string) {
  if (typeof key !== 'string' || !stagingKeyPattern.test(key))
    throw new StorageError('INVALID_KEY');
}

function validateBody(key: string, body: Buffer, contentType: string) {
  validateKey(key);
  if (!Buffer.isBuffer(body)) throw new StorageError('IO_ERROR');
  if (body.length > MAX_STORED_BYTES) throw new StorageError('TOO_LARGE');
  if (contentType !== (key.endsWith('.png') ? 'image/png' : 'image/webp'))
    throw new StorageError('INVALID_CONTENT_TYPE');
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function safeLocalError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (errorCode(error) === 'ENOENT') return new StorageError('NOT_FOUND');
  if (errorCode(error) === 'ELOOP') return new StorageError('UNSAFE_PATH');
  return new StorageError('IO_ERROR');
}

type Directory = { filename: string; dev: number; ino: number };

async function checkDirectory(directory: Directory) {
  const current = await lstat(directory.filename);
  if (
    !current.isDirectory() ||
    current.dev !== directory.dev ||
    current.ino !== directory.ino ||
    (await realpath(directory.filename)) !== directory.filename
  )
    throw new StorageError('UNSAFE_PATH');
}

async function checkExistingFile(filename: string) {
  try {
    const current = await lstat(filename);
    if (!current.isFile() || current.nlink !== 1) throw new StorageError('UNSAFE_PATH');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export class LocalStorage implements BlobStorage {
  private readonly dataDir: string;
  readonly identity: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.identity = JSON.stringify(['local', path.join(this.dataDir, 'assets')]);
  }

  private async directory(): Promise<Directory> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.dataDir)).isDirectory()) throw new StorageError('UNSAFE_PATH');
    const filename = path.join(await realpath(this.dataDir), 'assets');
    try {
      await mkdir(filename, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const current = await lstat(filename);
    if (!current.isDirectory()) throw new StorageError('UNSAFE_PATH');
    const directory = { filename, dev: current.dev, ino: current.ino };
    await checkDirectory(directory);
    return directory;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    validateBody(key, body, contentType);
    let temporary: string | undefined;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const directory = await this.directory();
      const filename = path.join(directory.filename, key);
      await checkExistingFile(filename);
      temporary = path.join(directory.filename, `.${randomUUID()}.tmp`);
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await checkDirectory(directory);
      await file.writeFile(body);
      await file.sync();
      await file.close();
      file = undefined;
      await checkDirectory(directory);
      await checkExistingFile(filename);
      await rename(temporary, filename);
      temporary = undefined;
    } catch (error) {
      throw safeLocalError(error);
    } finally {
      await file?.close().catch(() => {});
      if (temporary) await unlink(temporary).catch(() => {});
    }
  }

  async get(key: string): Promise<Buffer> {
    validateKey(key);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const directory = await this.directory();
      const filename = path.join(directory.filename, key);
      await checkExistingFile(filename);
      file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      await checkDirectory(directory);
      const current = await file.stat();
      // Atomic replacement may unlink an already-open reader's old inode (nlink === 0).
      if (!current.isFile() || current.nlink > 1) throw new StorageError('UNSAFE_PATH');
      if (current.size > MAX_STORED_BYTES) throw new StorageError('TOO_LARGE');
      const chunks: Buffer[] = [];
      let total = 0;
      // Bound actual bytes as well as stat.size, including a file growing while it is read.
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_STORED_BYTES - total + 1));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_STORED_BYTES) throw new StorageError('TOO_LARGE');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      throw safeLocalError(error);
    } finally {
      await file?.close().catch(() => {});
    }
  }

  async remove(key: string): Promise<void> {
    validateKey(key);
    try {
      const directory = await this.directory();
      const filename = path.join(directory.filename, key);
      await checkExistingFile(filename);
      await checkDirectory(directory);
      await unlink(filename);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw safeLocalError(error);
    }
  }
}

export type StorageCommand = PutObjectCommand | GetObjectCommand | DeleteObjectCommand;
export type StorageSend = (
  command: StorageCommand,
) => Promise<{ Body?: unknown; ContentLength?: number }>;

function validateConfig(input: S3StorageConfig) {
  try {
    if (typeof input.endpoint !== 'string' || /[\s\\?#]/.test(input.endpoint))
      throw new StorageError('CONFIG_ERROR');
    const endpoint = new URL(input.endpoint);
    // Public endpoints must be HTTPS. Loopback HTTP stays allowed so a local
    // S3-compatible service (for example MinIO) can be validated in isolation.
    const loopbackHttp =
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    const prefix = (input.prefix ?? 'zhizuo/assets').replace(/\/$/, '');
    if (
      (endpoint.protocol !== 'https:' && !loopbackHttp) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      typeof input.region !== 'string' ||
      typeof input.bucket !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(input.region) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
      /\.\.|\.-|-\.|^\d+\.\d+\.\d+\.\d+$/.test(input.bucket) ||
      prefix.length > 200 ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix) ||
      (input.forcePathStyle !== undefined && typeof input.forcePathStyle !== 'boolean') ||
      [input.accessKeyId, input.secretAccessKey].some(
        (value) =>
          typeof value !== 'string' ||
          !value ||
          value.length > 4096 ||
          /[\s\x00-\x1f\x7f]/.test(value),
      )
    )
      throw new StorageError('CONFIG_ERROR');
    return { ...input, endpoint: endpoint.href, prefix };
  } catch {
    throw new StorageError('CONFIG_ERROR');
  }
}

function destroyBody(body: unknown) {
  if (body && typeof body === 'object' && 'destroy' in body && typeof body.destroy === 'function') {
    try {
      body.destroy();
    } catch {
      // Closing a failed upstream stream must not expose the upstream error or its credentials.
    }
  }
}

async function boundedBody(body: unknown, contentLength?: number): Promise<Buffer> {
  try {
    if (contentLength !== undefined) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 0)
        throw new StorageError('IO_ERROR');
      if (contentLength > MAX_STORED_BYTES) throw new StorageError('TOO_LARGE');
    }
    if (body instanceof Uint8Array) {
      if (body.byteLength > MAX_STORED_BYTES) throw new StorageError('TOO_LARGE');
      if (contentLength !== undefined && contentLength !== body.byteLength)
        throw new StorageError('IO_ERROR');
      return Buffer.from(body);
    }
    if (
      !body ||
      typeof body !== 'object' ||
      !(Symbol.asyncIterator in body) ||
      typeof body[Symbol.asyncIterator] !== 'function'
    )
      throw new StorageError('IO_ERROR');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) throw new StorageError('IO_ERROR');
      total += chunk.byteLength;
      if (total > MAX_STORED_BYTES) throw new StorageError('TOO_LARGE');
      chunks.push(Buffer.from(chunk));
    }
    if (contentLength !== undefined && contentLength !== total) throw new StorageError('IO_ERROR');
    return Buffer.concat(chunks, total);
  } catch (error) {
    destroyBody(body);
    if (error instanceof StorageError) throw error;
    throw new StorageError('IO_ERROR');
  }
}

function isMissingObject(error: unknown) {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    (error.name === 'NoSuchKey' || error.name === 'NotFound')
  );
}

export class S3Storage implements BlobStorage {
  readonly identity: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly send: StorageSend;
  private readonly client?: S3Client;

  constructor(input: S3StorageConfig, transport: { send?: StorageSend } = {}) {
    const config = validateConfig(input);
    this.identity = JSON.stringify([
      's3',
      config.endpoint.replace(/\/$/, ''),
      config.bucket,
      config.prefix,
    ]);
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    if (transport.send) {
      this.send = transport.send;
    } else {
      const client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        forcePathStyle: config.forcePathStyle ?? true,
        maxAttempts: 2,
        requestHandler: {
          connectionTimeout: 5_000,
          socketTimeout: 30_000,
          requestTimeout: 60_000,
          throwOnRequestTimeout: true,
        },
      });
      this.client = client;
      this.send = async (command) => {
        if (command instanceof GetObjectCommand) {
          const response = await client.send(command);
          return { Body: response.Body, ContentLength: response.ContentLength };
        }
        if (command instanceof PutObjectCommand) await client.send(command);
        else await client.send(command);
        return {};
      };
    }
  }

  private objectKey(key: string) {
    validateKey(key);
    return `${this.prefix}/${key}`;
  }

  // Asset objects and upload-staging objects share one prefix namespace.
  private objectKeyFor(key: string) {
    return key.startsWith('uploads/') ? this.stagingObjectKey(key) : this.objectKey(key);
  }

  private stagingObjectKey(key: string) {
    validateStagingKey(key);
    return `${this.prefix}/${key}`;
  }

  async presign(key: string, ttlSeconds: number, method: 'put' | 'get'): Promise<PresignedTarget> {
    const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 30), 3600);
    const objectKey = this.objectKeyFor(key);
    const command =
      method === 'put'
        ? new PutObjectCommand({ Bucket: this.bucket, Key: objectKey })
        : new GetObjectCommand({ Bucket: this.bucket, Key: objectKey });
    try {
      if (!this.client) throw new StorageError('IO_ERROR');
      const url = await getSignedUrl(this.client, command, { expiresIn: ttl });
      return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('IO_ERROR');
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    validateBody(key, body, contentType);
    try {
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          CacheControl: 'private, no-store',
        }),
      );
    } catch {
      throw new StorageError('IO_ERROR');
    }
  }

  async get(key: string): Promise<Buffer> {
    const objectKey = this.objectKeyFor(key);
    try {
      const result = await this.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return await boundedBody(result.Body, result.ContentLength);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (isMissingObject(error)) throw new StorageError('NOT_FOUND');
      throw new StorageError('IO_ERROR');
    }
  }

  async remove(key: string): Promise<void> {
    const objectKey = this.objectKeyFor(key);
    try {
      await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (error) {
      if (isMissingObject(error)) return;
      throw new StorageError('IO_ERROR');
    }
  }

  close() {
    this.client?.destroy();
  }
}

export function createStorage(dataDir: string, config?: S3StorageConfig): BlobStorage {
  return config ? new S3Storage(config) : new LocalStorage(dataDir);
}
