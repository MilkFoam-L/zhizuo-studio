import sharp, { type OverlayOptions } from 'sharp';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Asset, Poster } from '../../../packages/shared/src/index';
import { layoutPoster } from '../../../packages/shared/src/poster-layout';
import type { Database } from './db';
import { LocalStorage, type BlobStorage } from './storage';

const fontFile = path.resolve('apps/server/fonts/NotoSansSC.ttf');
process.env.FONTCONFIG_FILE ??= path.resolve('apps/server/fonts/fonts.conf');
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PendingAsset {
  id: string;
  projectId: string;
  storageIdentity: string;
  createdAt: string;
}

export interface PendingAssetReconciliation {
  cleaned: number;
  completed: number;
  deferred: number;
  failed: number;
}

export class Media {
  private storage: BlobStorage;
  private activeUploads = new Set<string>();
  private reconciliation?: Promise<PendingAssetReconciliation>;
  constructor(
    private db: Database,
    private dataDir: string,
    storage?: BlobStorage,
  ) {
    this.storage = storage ?? new LocalStorage(dataDir);
  }
  filename(id: string, thumb = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效素材标识');
    return path.join(this.dataDir, 'assets', id + (thumb ? '.thumb.webp' : '.png'));
  }
  async ingest(projectId: string, bytes: Buffer, name: string, fromBackup = false): Promise<Asset> {
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
    const pending: PendingAsset = {
      id,
      projectId,
      storageIdentity: this.storage.identity,
      createdAt: asset.createdAt,
    };
    this.activeUploads.add(id);
    try {
      // Persist intent before touching blobs so partial writes survive process or cleanup failure.
      await this.db.put('pending_assets', id, pending);
      await this.storage.put(`${id}.png`, normalized.data, 'image/png');
      await this.storage.put(
        `${id}.thumb.webp`,
        await sharp(normalized.data)
          .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer(),
        'image/webp',
      );
      await this.db.put('assets', id, asset);
    } catch (e) {
      try {
        const committed = await this.db.get<Asset>('assets', id);
        if (committed) {
          // A lost database acknowledgement can happen after a successful commit.
          await this.db.remove('pending_assets', id).catch(() => {});
          return committed;
        }
        await this.removeObjects(id);
        await this.db.remove('pending_assets', id);
      } catch {
        // Keep the intent when reads or compensation fail; a later sweep can safely retry.
      }
      throw e;
    } finally {
      this.activeUploads.delete(id);
    }
    // Failure to remove bookkeeping must never turn a committed upload into destructive rollback.
    await this.db.remove('pending_assets', id).catch(() => {});
    return asset;
  }

  reconcilePending(): Promise<PendingAssetReconciliation> {
    if (!this.reconciliation) {
      this.reconciliation = this.reconcileUploads().finally(() => {
        this.reconciliation = undefined;
      });
    }
    return this.reconciliation;
  }

  private async reconcileUploads(): Promise<PendingAssetReconciliation> {
    const result: PendingAssetReconciliation = { cleaned: 0, completed: 0, deferred: 0, failed: 0 };
    for (const pending of await this.db.list<PendingAsset>('pending_assets')) {
      if (pending.storageIdentity !== this.storage.identity || this.activeUploads.has(pending.id)) {
        result.deferred++;
        continue;
      }
      try {
        if (await this.db.get<Asset>('assets', pending.id)) {
          await this.db.remove('pending_assets', pending.id);
          result.completed++;
        } else {
          await this.removeObjects(pending.id);
          await this.db.remove('pending_assets', pending.id);
          result.cleaned++;
        }
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
  private async removeObjects(id: string) {
    const removed = await Promise.allSettled([
      this.storage.remove(`${id}.png`),
      this.storage.remove(`${id}.thumb.webp`),
    ]);
    for (const result of removed) if (result.status === 'rejected') throw result.reason;
  }
  async remove(id: string) {
    await this.removeObjects(id);
    await this.db.remove('assets', id);
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
    // Render one CJK-wrapped line at a time with the bundled OFL font; no host font dependency.
    for (const line of layoutPoster(poster).lines) {
      if (!line.text.trim()) continue;
      const input = await sharp({
        text: {
          text: `<span foreground="${escape(line.color)}" weight="${line.fontWeight}">${escape(line.text)}</span>`,
          font: `Noto Sans SC ${line.fontSize}`,
          fontfile: fontFile,
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
