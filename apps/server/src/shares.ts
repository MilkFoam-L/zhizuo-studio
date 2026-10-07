import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Asset,
  ContentVersion,
  Poster,
  Project,
  ShareLink,
  SharedContent,
} from '../../../packages/shared/src/index';
import type { Database } from './db';
import type { Media } from './media';
import { NotFound } from './repository';

const createShareSchema = z.object({
  title: z
    .string()
    .refine((value) => !/\p{Cc}/u.test(value))
    .trim()
    .min(1)
    .max(120),
  versionIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length),
  expiresHours: z.number().int().min(1).max(168),
});
type PublicVersion = SharedContent['versions'][number];
type Snapshot = PublicVersion & { poster?: Poster; assetId?: string };
interface ShareRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  tokenHash: string;
  encryptedToken: string;
  snapshots: Snapshot[];
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

const unavailable = () => new NotFound('分享链接已失效或不可用');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function publicVersion(version: Snapshot): PublicVersion {
  const result: PublicVersion = {
    id: version.id,
    kind: version.kind,
    label: version.label,
    createdAt: version.createdAt,
  };
  if (version.kind === 'copy' && version.copy) {
    const { titles, body, tags, pages } = version.copy;
    result.copy = {
      titles: [...titles],
      body,
      tags: [...tags],
      pages: pages.map(({ headline, body }) => ({ headline, body })),
    };
  }
  if (version.kind !== 'copy') {
    result.width = version.width;
    result.height = version.height;
  }
  return result;
}

function posterSnapshot(poster: Poster): Poster {
  return {
    width: poster.width,
    height: poster.height,
    background: poster.background,
    accent: poster.accent,
    templateId: poster.templateId,
    fontFamily: poster.fontFamily,
    assetId: poster.assetId,
    logoAssetId: poster.logoAssetId,
    ...(poster.logoBox
      ? {
          logoBox: {
            x: poster.logoBox.x,
            y: poster.logoBox.y,
            width: poster.logoBox.width,
            height: poster.logoBox.height,
          },
        }
      : {}),
    imageBox: {
      x: poster.imageBox.x,
      y: poster.imageBox.y,
      width: poster.imageBox.width,
      height: poster.imageBox.height,
    },
    texts: poster.texts.map(({ id, text, x, y, width, fontSize, color, fontWeight, align }) => ({
      id,
      text,
      x,
      y,
      width,
      fontSize,
      color,
      fontWeight,
      align,
    })),
  };
}

export class ShareService {
  private encryptionKey: Buffer;
  constructor(
    private db: Database,
    private media: Media,
    key: string,
    private canAccessProject?: (projectId: string) => Promise<boolean>,
  ) {
    if (!/^[a-f\d]{64}$/i.test(key)) throw new Error('分享加密密钥格式无效');
    this.encryptionKey = Buffer.from(key, 'hex');
  }

  private aad(id: string) {
    return Buffer.from(`zhizuo-share-token:v1:${id}`);
  }
  private encrypt(token: string, id: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(this.aad(id));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext]
      .map((value) => value.toString('base64url'))
      .join('.');
  }
  private link(record: ShareRecord): ShareLink {
    const [iv, tag, ciphertext] = record.encryptedToken
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAAD(this.aad(record.id));
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return {
      id: record.id,
      title: record.title,
      versionIds: record.snapshots.map((version) => version.id),
      expiresAt: record.expiresAt,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      createdAt: record.createdAt,
      urlPath: `/#/share/${token}`,
    };
  }
  private async project(projectId: string, workspaceId?: string) {
    const [row] = await this.db.query<{ body: Project }>(
      "SELECT body FROM documents WHERE scope='projects' AND id=$1 FOR SHARE",
      [projectId],
    );
    if (!row || (workspaceId !== undefined && (row.body.workspaceId ?? 'local') !== workspaceId))
      throw unavailable();
    return row.body;
  }
  private async lockAssets(projectId: string, snapshots: Snapshot[]) {
    const ids = [
      ...new Set(
        snapshots.flatMap((version) =>
          [version.assetId, version.poster?.assetId, version.poster?.logoAssetId].filter(
            (id): id is string => !!id,
          ),
        ),
      ),
    ].sort();
    const assets = new Map<string, Asset>();
    for (const id of ids) {
      const [row] = await this.db.query<{ body: Asset }>(
        "SELECT body FROM documents WHERE scope='assets' AND id=$1 FOR SHARE",
        [id],
      );
      if (!row || row.body.projectId !== projectId) throw unavailable();
      assets.set(id, row.body);
    }
    return assets;
  }

  async create(projectId: string, workspaceId: string, input: unknown): Promise<ShareLink> {
    const { title, versionIds, expiresHours } = createShareSchema.parse(input);
    return this.db.transaction(async () => {
      await this.project(projectId, workspaceId);
      const snapshots: Snapshot[] = [];
      for (const id of [...versionIds].sort()) {
        const [row] = await this.db.query<{ body: ContentVersion }>(
          "SELECT body FROM documents WHERE scope='versions' AND id=$1 FOR SHARE",
          [id],
        );
        const version = row?.body;
        if (!version || version.projectId !== projectId) throw unavailable();
        const snapshot: Snapshot = publicVersion(version);
        if (version.kind === 'copy') {
          if (!snapshot.copy) throw unavailable();
        } else if (version.kind === 'poster') {
          if (!version.poster) throw unavailable();
          snapshot.poster = posterSnapshot(version.poster);
          snapshot.width = version.poster.width;
          snapshot.height = version.poster.height;
        } else {
          if (!version.assetId) throw unavailable();
          snapshot.assetId = version.assetId;
        }
        snapshots.push(snapshot);
      }
      const assets = await this.lockAssets(projectId, snapshots);
      for (const snapshot of snapshots) {
        if (snapshot.kind === 'image') {
          const asset = assets.get(snapshot.assetId!)!;
          snapshot.width = asset.width;
          snapshot.height = asset.height;
        }
      }
      snapshots.sort((a, b) => versionIds.indexOf(a.id) - versionIds.indexOf(b.id));
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const record: ShareRecord = {
        id,
        projectId,
        workspaceId,
        title,
        snapshots,
        tokenHash: hashToken(token),
        encryptedToken: this.encrypt(token, id),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresHours * 3_600_000).toISOString(),
      };
      await this.db.put('shares', id, record);
      return this.link(record);
    });
  }

  async list(projectId: string, workspaceId: string): Promise<ShareLink[]> {
    return this.db.transaction(async () => {
      await this.project(projectId, workspaceId);
      const records = await this.db.list<ShareRecord>('shares', projectId);
      return records
        .filter((record) => record.workspaceId === workspaceId)
        .map((record) => this.link(record));
    });
  }

  async revoke(projectId: string, workspaceId: string, id: string): Promise<ShareLink> {
    return this.db.transaction(async () => {
      await this.project(projectId, workspaceId);
      const [row] = await this.db.query<{ body: ShareRecord }>(
        "SELECT body FROM documents WHERE scope='shares' AND id=$1 FOR UPDATE",
        [id],
      );
      const record = row?.body;
      if (!record || record.projectId !== projectId || record.workspaceId !== workspaceId)
        throw unavailable();
      const next = { ...record, revokedAt: record.revokedAt ?? new Date().toISOString() };
      await this.db.put('shares', id, next);
      return this.link(next);
    });
  }

  private async active(token: string): Promise<ShareRecord> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
    const [row] = await this.db.query<{ body: ShareRecord }>(
      "SELECT body FROM documents WHERE scope='shares' AND body->>'tokenHash'=$1 FOR SHARE",
      [hashToken(token)],
    );
    const record = row?.body;
    if (!record || record.revokedAt || !(Date.parse(record.expiresAt) > Date.now()))
      throw unavailable();
    await this.project(record.projectId, record.workspaceId);
    if (this.canAccessProject && !(await this.canAccessProject(record.projectId)))
      throw unavailable();
    return record;
  }
  async read(token: string): Promise<SharedContent> {
    return this.db.transaction(async () => {
      const record = await this.active(token);
      return {
        title: record.title,
        expiresAt: record.expiresAt,
        versions: record.snapshots.map(publicVersion),
      };
    });
  }
  async preview(token: string, versionId: string): Promise<Buffer> {
    return this.db.transaction(async () => {
      const record = await this.active(token);
      const snapshot = record.snapshots.find((version) => version.id === versionId);
      if (!snapshot || snapshot.kind === 'copy') throw unavailable();
      await this.lockAssets(record.projectId, [snapshot]);
      try {
        if (snapshot.kind === 'poster' && snapshot.poster)
          return await this.media.render(snapshot.poster, record.projectId);
        if (snapshot.kind === 'image' && snapshot.assetId)
          return await this.media.bytes(snapshot.assetId);
      } catch {
        throw unavailable();
      }
      throw unavailable();
    });
  }
}
