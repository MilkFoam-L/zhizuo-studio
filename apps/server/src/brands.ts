import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { Asset, BrandInput, BrandKit, Project } from '../../../packages/shared/src/index';
import type { Database } from './db';
import type { Media } from './media';
import { Conflict, NotFound, now, type Repository } from './repository';

export const brandInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    tone: z.string().trim().max(1000),
    bannedTerms: z.array(z.string().trim().min(1).max(80)).max(100),
    fontFamily: z.enum(['sans', 'serif']),
  })
  .strict();

const brandSpace = (id: string) => `brand:${id}`;

export class BrandService {
  constructor(
    private db: Database,
    private media: Media,
    private repo: Repository,
  ) {}

  async list(workspaceId: string, includeArchived = false): Promise<BrandKit[]> {
    return (
      await this.db.query<{ body: BrandKit }>(
        `SELECT body FROM documents WHERE scope='brand_kits' AND body->>'workspaceId'=$1
       ${includeArchived ? '' : "AND body->>'archivedAt' IS NULL"} ORDER BY body->>'updatedAt' DESC, id`,
        [workspaceId],
      )
    ).map((row) => row.body);
  }

  async get(id: string, workspaceId: string): Promise<BrandKit> {
    const brand = await this.db.get<BrandKit>('brand_kits', id);
    if (!brand || brand.workspaceId !== workspaceId) throw new NotFound('品牌不存在');
    return brand;
  }

  private async locked(id: string, workspaceId: string, mode: 'SHARE' | 'UPDATE') {
    const [row] = await this.db.query<{ body: BrandKit }>(
      `SELECT body FROM documents WHERE scope='brand_kits' AND id=$1 AND body->>'workspaceId'=$2 FOR ${mode}`,
      [id, workspaceId],
    );
    if (!row) throw new NotFound('品牌不存在');
    return row.body;
  }

  private active(brand: BrandKit) {
    if (brand.archivedAt) throw new Conflict('品牌已归档，请先恢复后再应用');
  }

  private async save(current: BrandKit, next: BrandKit) {
    const rows = await this.db.query<{ body: BrandKit }>(
      `UPDATE documents SET body=$3::jsonb WHERE scope='brand_kits' AND id=$1
       AND (body->>'revision')::integer=$2 RETURNING body`,
      [current.id, current.revision, JSON.stringify(next)],
    );
    if (!rows.length) throw new Conflict('品牌已被其他操作更新，请重新载入后合并修改');
    return rows[0].body;
  }

  async create(workspaceId: string, input: BrandInput): Promise<BrandKit> {
    const fields = brandInputSchema.parse(input);
    const timestamp = now();
    const brand: BrandKit = {
      ...fields,
      id: randomUUID(),
      workspaceId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.db.put('brand_kits', brand.id, brand);
    return brand;
  }

  async update(id: string, workspaceId: string, revision: number, input: BrandInput) {
    const fields = brandInputSchema.parse(input);
    z.number().int().positive().parse(revision);
    return this.db.transaction(async () => {
      const brand = await this.locked(id, workspaceId, 'UPDATE');
      if (brand.revision !== revision)
        throw new Conflict('品牌已被其他操作更新，本地修改已保留，请重新载入后合并修改');
      return this.save(brand, { ...brand, ...fields, revision: revision + 1, updatedAt: now() });
    });
  }

  async setArchived(id: string, workspaceId: string, archived: boolean) {
    z.boolean().parse(archived);
    return this.db.transaction(async () => {
      const brand = await this.locked(id, workspaceId, 'UPDATE');
      if (!!brand.archivedAt === archived) return brand;
      return this.save(brand, {
        ...brand,
        archivedAt: archived ? now() : undefined,
        revision: brand.revision + 1,
        updatedAt: now(),
      });
    });
  }

  async uploadLogo(id: string, workspaceId: string, bytes: Buffer, name: string) {
    const original = await this.get(id, workspaceId);
    if (bytes.length > 4 * 1024 * 1024) throw new Error('Logo 不能超过 4 MiB');
    const image = sharp(bytes, { limitInputPixels: 32_000_000, failOn: 'error' });
    const metadata = await image.metadata();
    if (
      !['jpeg', 'png', 'webp', 'avif'].includes(metadata.format ?? '') ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error('Logo 仅支持静态 JPG、PNG、WebP、AVIF 图片');
    const normalized = await image
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const asset = await this.media.ingest(brandSpace(id), normalized, name);
    let saved: BrandKit;
    try {
      saved = await this.db.transaction(async () => {
        const [row] = await this.db.query<{ body: Asset }>(
          "SELECT body FROM documents WHERE scope='assets' AND id=$1 FOR SHARE",
          [asset.id],
        );
        if (!row || row.body.projectId !== brandSpace(id)) throw new NotFound('Logo 素材不存在');
        const brand = await this.locked(id, workspaceId, 'UPDATE');
        if (brand.revision !== original.revision)
          throw new Conflict('上传期间品牌已更新，原 Logo 已保留，请重新上传');
        return this.save(brand, {
          ...brand,
          logoAssetId: asset.id,
          revision: brand.revision + 1,
          updatedAt: now(),
        });
      });
    } catch (error) {
      await this.media.removeIfUnreferenced(asset.id, brandSpace(id)).catch(() => {});
      throw error;
    }
    if (original.logoAssetId)
      await this.media.removeIfUnreferenced(original.logoAssetId, brandSpace(id)).catch(() => {});
    return saved;
  }

  private async snapshot(id: string, workspaceId: string, requireActive: boolean) {
    return this.db.transaction(async () => {
      const brand = await this.locked(id, workspaceId, 'SHARE');
      if (requireActive) this.active(brand);
      if (!brand.logoAssetId) return { brand, bytes: undefined };
      const [row] = await this.db.query<{ body: Asset }>(
        "SELECT body FROM documents WHERE scope='assets' AND id=$1 FOR SHARE",
        [brand.logoAssetId],
      );
      if (!row || row.body.projectId !== brandSpace(id)) throw new NotFound('Logo 素材不存在');
      // A shared lock keeps replacement cleanup from deleting this object during the read.
      return { brand, bytes: await this.media.bytes(brand.logoAssetId) };
    });
  }

  async logo(id: string, workspaceId: string): Promise<Buffer> {
    const snapshot = await this.snapshot(id, workspaceId, false);
    if (!snapshot.bytes) throw new NotFound('品牌尚未上传 Logo');
    return snapshot.bytes;
  }

  async apply(
    id: string,
    workspaceId: string,
    projectId: string,
    revision: number,
  ): Promise<Project> {
    z.number().int().positive().parse(revision);
    const project = await this.repo.project(projectId);
    if ((project.workspaceId ?? 'local') !== workspaceId) throw new NotFound('项目不存在');
    if (project.revision !== revision) throw new Conflict('项目已更新，请重新载入后应用品牌');
    const { brand, bytes } = await this.snapshot(id, workspaceId, true);
    const copied = bytes
      ? await this.media.ingest(projectId, bytes, `${brand.name} Logo.png`)
      : undefined;
    try {
      return await this.db.transaction(async () => {
        const current = await this.locked(id, workspaceId, 'SHARE');
        this.active(current);
        if (current.revision !== brand.revision)
          throw new Conflict('应用期间品牌已更新，请重新选择后应用');
        const target = await this.repo.project(projectId);
        if ((target.workspaceId ?? 'local') !== workspaceId) throw new NotFound('项目不存在');
        return this.repo.update(projectId, revision, {
          brief: {
            ...target.brief,
            brand: brand.name,
            brandColor: brand.primaryColor,
            tone: brand.tone,
            fontFamily: brand.fontFamily,
            bannedTerms: [...brand.bannedTerms],
            brandKitId: brand.id,
            brandKitRevision: brand.revision,
            logoAssetId: copied?.id,
            confirmed: false,
          },
        });
      });
    } catch (error) {
      if (copied) await this.media.removeIfUnreferenced(copied.id, projectId).catch(() => {});
      throw error;
    }
  }
}
