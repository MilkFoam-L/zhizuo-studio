import sharp, { type OverlayOptions } from 'sharp';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Asset, ContentVersion, Poster, Project } from '../../../packages/shared/src/index';
import { layoutPoster } from '../../../packages/shared/src/poster-layout';
import type { Database } from './db';
import { LocalStorage, type BlobStorage } from './storage';
import { versionAssetIds } from './repository';

const fontFiles = {
  sans: path.resolve('apps/server/fonts/NotoSansSC.ttf'),
  serif: path.resolve('apps/server/fonts/NotoSerifSC.ttf'),
};
process.env.FONTCONFIG_FILE ??= path.resolve('apps/server/fonts/fonts.conf');
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PendingAsset {
  id: string;
  projectId: string;
  storageIdentity: string;
  createdAt: string;
  uploadOwner?: string;
  uploadToken?: string;
  leaseExpiresAt?: string;
  phase?: 'uploading' | 'cleaning';
  uploadStopped?: boolean;
  cleanupToken?: string;
  cleanupLeaseExpiresAt?: string;
  cleanupCompleteAt?: string;
  /** Set for presigned direct uploads; the object key that the client PUTs to. */
  stagingKey?: string;
}

export interface MediaExecution {
  leaseDurationMs?: number;
  heartbeatMs?: number;
  legacyGraceMs?: number;
}

class UploadLeaseLost extends Error {
  constructor() {
    super('素材上传租约已失效，请重新上传');
  }
}

export interface PendingAssetReconciliation {
  cleaned: number;
  completed: number;
  deferred: number;
  failed: number;
}

export class Media {
  private storage: BlobStorage;
  private uploads = new Set<Promise<Asset>>();
  private closing = false;
  private owner = randomUUID();
  private leaseDurationMs: number;
  private heartbeatMs: number;
  private legacyGraceMs: number;
  private reconciliation?: Promise<PendingAssetReconciliation>;
  constructor(
    private db: Database,
    private dataDir: string,
    storage?: BlobStorage,
    execution: MediaExecution = {},
  ) {
    this.storage = storage ?? new LocalStorage(dataDir);
    this.leaseDurationMs = execution.leaseDurationMs ?? 180_000;
    this.heartbeatMs = execution.heartbeatMs ?? 20_000;
    this.legacyGraceMs = execution.legacyGraceMs ?? 180_000;
    if (
      ![this.leaseDurationMs, this.heartbeatMs, this.legacyGraceMs].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      this.heartbeatMs >= this.leaseDurationMs / 2
    )
      throw new Error('素材心跳间隔必须小于上传租约的一半');
  }
  filename(id: string, thumb = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效素材标识');
    return path.join(this.dataDir, 'assets', id + (thumb ? '.thumb.webp' : '.png'));
  }
  ingest(projectId: string, bytes: Buffer, name: string, fromBackup = false): Promise<Asset> {
    if (this.closing) return Promise.reject(new Error('素材服务正在关闭'));
    const upload = this.upload(projectId, bytes, name, fromBackup).finally(() =>
      this.uploads.delete(upload),
    );
    this.uploads.add(upload);
    return upload;
  }

  supportsPresign(): boolean {
    return typeof this.storage.presign === 'function';
  }

  /**
   * Presigned direct upload: a short-lived staging intent bounds the client PUT,
   * while normalization and the authoritative asset commit stay server-side.
   */
  async createPresignedUpload(
    projectId: string,
    name: string,
  ): Promise<{
    uploadId: string;
    token: string;
    uploadUrl: string;
    expiresAt: string;
    leaseExpiresAt: string;
  }> {
    if (this.closing) throw new Error('素材服务正在关闭');
    if (!this.storage.presign) throw new Error('当前存储后端不支持预签名直传，请使用普通上传');
    const id = randomUUID();
    const stagingKey = `uploads/${id}`;
    const token = randomUUID();
    const createdAt = new Date().toISOString();
    await this.db.transaction(async () => {
      await this.db.put('pending_assets', id, {
        id,
        projectId,
        storageIdentity: this.storage.identity,
        createdAt,
        uploadOwner: this.owner,
        uploadToken: token,
        phase: 'uploading',
        stagingKey,
      } satisfies PendingAsset);
      await this.db.query(
        `UPDATE documents SET body=body || jsonb_build_object('leaseExpiresAt', clock_timestamp() + ($2::double precision * interval '1 millisecond'))
         WHERE scope='pending_assets' AND id=$1`,
        [id, this.leaseDurationMs],
      );
    });
    // The URL must outlive the database lease so the client can finish the PUT.
    const target = await this.storage.presign(
      stagingKey,
      Math.floor(this.leaseDurationMs / 1000) + 120,
      'put',
    );
    const [lease] = await this.db.query<{ body: PendingAsset }>(
      "SELECT body FROM documents WHERE scope='pending_assets' AND id=$1",
      [id],
    );
    return {
      uploadId: id,
      token,
      uploadUrl: target.url,
      expiresAt: target.expiresAt,
      leaseExpiresAt: lease?.body.leaseExpiresAt ?? createdAt,
    };
  }

  async completePresignedUpload(
    projectId: string,
    uploadId: string,
    token: string,
    name: string,
  ): Promise<Asset> {
    const valid = await this.pendingLocked(uploadId, async (pending) => {
      if (
        !pending ||
        pending.uploadToken !== token ||
        pending.phase !== 'uploading' ||
        !pending.stagingKey ||
        pending.projectId !== projectId
      )
        return false;
      const rows = await this.db.query<{ id: string }>(
        `SELECT id FROM documents WHERE scope='pending_assets' AND id=$1
         AND (body->>'leaseExpiresAt')::timestamptz > clock_timestamp()`,
        [uploadId],
      );
      return rows.length > 0;
    });
    if (!valid) throw new Error('上传会话已过期或不存在，请重新发起上传');
    const staged = await this.storage.get(`uploads/${uploadId}`);
    if (!staged.length) throw new Error('尚未收到上传的文件，请完成上传后再登记');
    // Normalization, lease and reference rules are identical to ordinary uploads.
    const asset = await this.ingest(projectId, staged, name);
    await this.pendingLocked(uploadId, async (pending) => {
      if (pending?.uploadToken === token) await this.db.remove('pending_assets', uploadId);
    }).catch(() => {});
    await this.storage.remove(`uploads/${uploadId}`).catch(() => {});
    return asset;
  }

  async presignedDownload(
    id: string,
    projectId: string,
  ): Promise<{ url: string; mode: 'presigned' | 'api'; expiresAt?: string }> {
    await this.owned(id, projectId);
    if (this.storage.presign) {
      const target = await this.storage.presign(`${id}.png`, 600, 'get');
      return { url: target.url, mode: 'presigned', expiresAt: target.expiresAt };
    }
    // Local storage keeps serving downloads through the authorized API route.
    return { url: `/api/assets/${id}/content`, mode: 'api' };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.uploads]);
    await this.reconciliation;
  }

  private async pendingLocked<T>(
    id: string,
    work: (pending: PendingAsset | undefined) => Promise<T>,
  ) {
    return this.db.transaction(async () => {
      const [row] = await this.db.query<{ body: PendingAsset }>(
        "SELECT body FROM documents WHERE scope='pending_assets' AND id=$1 FOR UPDATE",
        [id],
      );
      return work(row?.body);
    });
  }

  private async renewUpload(id: string, token: string) {
    return this.pendingLocked(id, async (pending) => {
      if (!pending || pending.uploadToken !== token || pending.phase !== 'uploading')
        throw new UploadLeaseLost();
      const renewed = await this.db.query(
        `UPDATE documents SET body=body || jsonb_build_object('leaseExpiresAt', clock_timestamp() + ($3::double precision * interval '1 millisecond'))
         WHERE scope='pending_assets' AND id=$1 AND body->>'uploadToken'=$2
           AND (body->>'leaseExpiresAt')::timestamptz > clock_timestamp() RETURNING id`,
        [id, token, this.leaseDurationMs],
      );
      if (!renewed.length) throw new UploadLeaseLost();
    });
  }

  private async upload(
    projectId: string,
    bytes: Buffer,
    name: string,
    fromBackup: boolean,
  ): Promise<Asset> {
    if (bytes.length > (fromBackup ? 40 : 24) * 1024 * 1024) throw new Error('图片超过大小限制');
    const img = sharp(bytes, { limitInputPixels: 32_000_000, failOn: 'error' });
    const meta = await img.metadata();
    if (!['jpeg', 'png', 'webp', 'avif'].includes(meta.format || '') || (meta.pages ?? 1) > 1)
      throw new Error('仅支持静态 JPG、PNG、WebP、AVIF 图片');
    const normalized = await img.rotate().png().toBuffer({ resolveWithObject: true });
    if (normalized.data.length > 40 * 1024 * 1024) throw new Error('图片解码后过大，请压缩尺寸');
    const id = randomUUID();
    const asset: Asset = {
      id,
      projectId,
      name: path.basename(name).slice(0, 200),
      mime: 'image/png',
      size: normalized.data.length,
      width: normalized.info.width,
      height: normalized.info.height,
      url: `/api/assets/${id}/content`,
      thumbnailUrl: `/api/assets/${id}/thumbnail`,
      createdAt: new Date().toISOString(),
    };
    const token = randomUUID();
    const pending: PendingAsset = {
      id,
      projectId,
      storageIdentity: this.storage.identity,
      createdAt: asset.createdAt,
      uploadOwner: this.owner,
      uploadToken: token,
      phase: 'uploading',
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatPending: Promise<void> | undefined;
    let lost = false;
    const checkpoint = async () => {
      if (lost) throw new UploadLeaseLost();
      await this.renewUpload(id, token);
    };
    try {
      await this.db.transaction(async () => {
        await this.db.put('pending_assets', id, pending);
        await this.db.query(
          `UPDATE documents SET body=body || jsonb_build_object('leaseExpiresAt', clock_timestamp() + ($2::double precision * interval '1 millisecond'))
           WHERE scope='pending_assets' AND id=$1`,
          [id, this.leaseDurationMs],
        );
      });
      heartbeat = setInterval(() => {
        if (heartbeatPending || lost) return;
        heartbeatPending = checkpoint()
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            heartbeatPending = undefined;
          });
      }, this.heartbeatMs);
      heartbeat.unref();
      await checkpoint();
      await this.storage.put(`${id}.png`, normalized.data, 'image/png');
      const thumbnail = await sharp(normalized.data)
        .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      await checkpoint();
      await this.storage.put(`${id}.thumb.webp`, thumbnail, 'image/webp');
      await this.pendingLocked(id, async (current) => {
        if (!current || current.uploadToken !== token || current.phase !== 'uploading' || lost)
          throw new UploadLeaseLost();
        await checkpoint();
        await this.db.put('assets', id, asset);
        await checkpoint();
      });
    } catch (error) {
      try {
        const committed = await this.db.get<Asset>('assets', id);
        if (committed) {
          await this.finishIntent(id).catch(() => {});
          return committed;
        }
        // The last PUT has settled in this invocation. Marking it stopped permits
        // a cleaner to remove the tombstone after deleting possible late objects.
        await this.pendingLocked(id, async (current) => {
          if (current?.uploadToken === token) {
            await this.db.put('pending_assets', id, {
              ...current,
              phase: 'cleaning',
              uploadStopped: true,
              leaseExpiresAt: new Date(0).toISOString(),
            });
          }
        });
        await this.cleanPending(id);
      } catch {
        // Keep the durable intent when state or compensation cannot be confirmed.
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
    }
    await this.finishIntent(id).catch(() => {});
    return asset;
  }

  private async finishIntent(id: string) {
    await this.pendingLocked(id, async (pending) => {
      if (pending && (await this.db.get<Asset>('assets', id)))
        await this.db.remove('pending_assets', id);
    });
  }

  reconcilePending(): Promise<PendingAssetReconciliation> {
    if (this.closing) return Promise.resolve({ cleaned: 0, completed: 0, deferred: 0, failed: 0 });
    if (!this.reconciliation) {
      this.reconciliation = this.reconcileUploads().finally(() => {
        this.reconciliation = undefined;
      });
    }
    return this.reconciliation;
  }

  private async cleanPending(id: string): Promise<'cleaned' | 'completed' | 'deferred'> {
    const token = randomUUID();
    const claim = await this.pendingLocked(id, async (pending) => {
      if (!pending || pending.storageIdentity !== this.storage.identity) return 'deferred' as const;
      if (await this.db.get<Asset>('assets', id)) {
        await this.db.remove('pending_assets', id);
        return 'completed' as const;
      }
      // Lease comparisons use database time, including conservative legacy intents.
      const expired = await this.db.query(
        `SELECT id FROM documents WHERE scope='pending_assets' AND id=$1
           AND (body->>'cleanupLeaseExpiresAt' IS NULL OR (body->>'cleanupLeaseExpiresAt')::timestamptz <= clock_timestamp())
           AND (body->>'phase'='cleaning' OR
             (body->>'leaseExpiresAt' IS NOT NULL AND (body->>'leaseExpiresAt')::timestamptz <= clock_timestamp()) OR
             (body->>'leaseExpiresAt' IS NULL AND (body->>'createdAt')::timestamptz <= clock_timestamp() - ($2::double precision * interval '1 millisecond')))`,
        [id, this.legacyGraceMs],
      );
      if (!expired.length) return 'deferred' as const;
      await this.db.query(
        `UPDATE documents SET body=body || $2::jsonb || jsonb_build_object(
          'cleanupLeaseExpiresAt', clock_timestamp() + ($3::double precision * interval '1 millisecond'))
         WHERE scope='pending_assets' AND id=$1`,
        [id, JSON.stringify({ phase: 'cleaning', cleanupToken: token }), this.leaseDurationMs],
      );
      return 'claimed' as const;
    });
    if (claim !== 'claimed') return claim;
    try {
      const pending = await this.db.get<PendingAsset>('pending_assets', id);
      await this.removeObjects(id, pending?.stagingKey);
      await this.pendingLocked(id, async (pending) => {
        if (!pending || pending.cleanupToken !== token) return;
        if (pending.uploadStopped || !pending.uploadToken) {
          await this.db.remove('pending_assets', id);
        } else {
          // An expired process may have a PUT already in flight. Retain a tombstone
          // and sweep it again until that uploader confirms no more writes can occur.
          const { cleanupToken: _token, cleanupLeaseExpiresAt: _expires, ...rest } = pending;
          await this.db.put('pending_assets', id, {
            ...rest,
            cleanupCompleteAt: new Date().toISOString(),
          });
        }
      });
      return 'cleaned';
    } catch (error) {
      await this.pendingLocked(id, async (pending) => {
        if (pending?.cleanupToken === token) {
          const { cleanupToken: _token, cleanupLeaseExpiresAt: _expires, ...rest } = pending;
          await this.db.put('pending_assets', id, rest);
        }
      }).catch(() => {});
      throw error;
    }
  }

  private async reconcileUploads(): Promise<PendingAssetReconciliation> {
    const result: PendingAssetReconciliation = { cleaned: 0, completed: 0, deferred: 0, failed: 0 };
    for (const pending of await this.db.list<PendingAsset>('pending_assets')) {
      try {
        result[await this.cleanPending(pending.id)]++;
      } catch {
        result.failed++;
      }
    }
    return result;
  }
  async owned(id: string, projectId: string) {
    const a = await this.db.get<Asset>('assets', id);
    if (!a || a.projectId !== projectId) throw new Error('素材不存在或不属于当前项目');
    return a;
  }
  async bytes(id: string) {
    this.filename(id);
    return this.storage.get(`${id}.png`);
  }
  async thumbnail(id: string) {
    this.filename(id);
    return this.storage.get(`${id}.thumb.webp`);
  }
  private async removeObjects(id: string, stagingKey?: string) {
    const targets: Promise<unknown>[] = [
      this.storage.remove(`${id}.png`),
      this.storage.remove(`${id}.thumb.webp`),
    ];
    if (stagingKey) targets.push(this.storage.remove(stagingKey));
    const removed = await Promise.allSettled(targets);
    for (const result of removed) if (result.status === 'rejected') throw result.reason;
  }
  async remove(id: string) {
    await this.removeObjects(id);
    await this.db.remove('assets', id);
  }
  async removeIfUnreferenced(id: string, projectId: string): Promise<boolean> {
    const removed = await this.db.transaction(async () => {
      const [row] = await this.db.query<{ body: Asset }>(
        "SELECT body FROM documents WHERE scope='assets' AND id=$1 FOR UPDATE",
        [id],
      );
      if (!row || row.body.projectId !== projectId) return false;
      const versions = await this.db.list<ContentVersion>('versions', projectId);
      const project = await this.db.get<Project>('projects', projectId);
      if (
        versions.some((version) => versionAssetIds(version).includes(id)) ||
        project?.board.nodes.some((node) => node.data.assetId === id) ||
        project?.brief.logoAssetId === id ||
        (
          await this.db.query(
            "SELECT id FROM documents WHERE scope='brand_kits' AND body->>'logoAssetId'=$1 LIMIT 1",
            [id],
          )
        ).length > 0
      )
        return false;
      // Remove visibility and persist cleanup intent atomically before remote I/O.
      // New references take a shared asset lock and reject the now-missing record.
      await this.db.remove('assets', id);
      await this.pendingLocked(id, async () => {
        const pending: PendingAsset = {
          id,
          projectId,
          storageIdentity: this.storage.identity,
          createdAt: new Date().toISOString(),
          phase: 'cleaning',
          uploadStopped: true,
        };
        await this.db.put('pending_assets', id, pending);
      });
      return true;
    });
    if (removed) await this.cleanPending(id);
    return removed;
  }
  async render(poster: Poster, projectId: string): Promise<Buffer> {
    const { width, height, imageBox } = poster;
    const overlays: OverlayOptions[] = [];
    if (poster.assetId) {
      await this.owned(poster.assetId, projectId);
      if (imageBox.x + imageBox.width > width || imageBox.y + imageBox.height > height)
        throw new Error('图片超出画布，请调整位置');
      const picture = await sharp(await this.bytes(poster.assetId))
        .resize(Math.floor(imageBox.width), Math.floor(imageBox.height), {
          fit: 'contain',
          background: '#ffffff00',
        })
        .png()
        .toBuffer();
      overlays.push({ input: picture, left: Math.floor(imageBox.x), top: Math.floor(imageBox.y) });
    }
    if (poster.logoAssetId) {
      await this.owned(poster.logoAssetId, projectId);
      const box = poster.logoBox ?? { x: width - 170, y: 65, width: 80, height: 80 };
      if (box.x + box.width > width || box.y + box.height > height)
        throw new Error('Logo超出画布，请调整位置');
      const logo = await sharp(await this.bytes(poster.logoAssetId))
        .resize(Math.floor(box.width), Math.floor(box.height), {
          fit: 'contain',
          background: '#ffffff00',
        })
        .png()
        .toBuffer();
      overlays.push({ input: logo, left: Math.floor(box.x), top: Math.floor(box.y) });
    }
    // Render one CJK-wrapped line at a time with the bundled OFL font; no host font dependency.
    for (const line of layoutPoster(poster).lines) {
      if (!line.text.trim()) continue;
      const input = await sharp({
        text: {
          text: `<span foreground="${escape(line.color)}" weight="${line.fontWeight}">${escape(line.text)}</span>`,
          font: `${poster.fontFamily === 'serif' ? 'Noto Serif SC' : 'Noto Sans SC'} ${line.fontSize}`,
          fontfile: fontFiles[poster.fontFamily ?? 'sans'],
          rgba: true,
          dpi: 72,
        },
      })
        .png()
        .toBuffer({ resolveWithObject: true });
      const left = Math.round(
        line.x -
          (line.anchor === 'middle'
            ? input.info.width / 2
            : line.anchor === 'end'
              ? input.info.width
              : 0),
      );
      const top = Math.round(line.y - line.fontSize);
      if (
        left < 0 ||
        top < 0 ||
        left + input.info.width > width ||
        top + input.info.height > height
      )
        throw new Error('文字超出画布，请缩小字号或调整位置');
      overlays.push({ input: input.data, left, top });
    }
    return sharp({ create: { width, height, channels: 4, background: poster.background } })
      .composite(overlays)
      .png()
      .toBuffer();
  }
}
