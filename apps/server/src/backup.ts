import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Asset, ContentVersion } from '../../../packages/shared/src/index';
import { boardSchema, briefSchema, copySchema, posterSchema } from './validation';
import { Repository } from './repository';
import { Media } from './media';

export async function backup(repo: Repository, media: Media, id: string) {
  const { project, assets, versions } = await repo.detail(id);
  const manifest = { format: 'zhizuo', schemaVersion: 1, project, assets, versions };
  importSchema.parse(manifest);
  const json = strToU8(JSON.stringify(manifest, null, 2));
  if (json.length > 5 * 1024 * 1024) throw new Error('项目元数据超过当前5 MB备份限制，请拆分项目');
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  for (const a of assets) {
    const b = await media.bytes(a.id);
    total += b.length;
    if (total > 100 * 1024 * 1024) throw new Error('项目超过当前 100 MB 备份限制，请拆分项目');
    files[`assets/${a.id}.png`] = b;
  }
  files['project.json'] = json;
  return Buffer.from(zipSync(files, { level: 1 }));
}
const versionSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['copy', 'poster', 'image']),
  label: z.string().max(300),
  parentVersionId: z.string().uuid().optional(),
  copy: copySchema.optional(),
  poster: posterSchema.optional(),
  assetId: z.string().uuid().optional(),
  inputSnapshot: z.unknown().optional(),
  createdAt: z.string().datetime().optional(),
});
const importSchema = z.object({
  format: z.literal('zhizuo'),
  schemaVersion: z.literal(1),
  project: z.object({ title: z.string().max(200), brief: briefSchema, board: boardSchema }),
  assets: z.array(z.object({ id: z.string().uuid(), name: z.string().max(200) })).max(200),
  versions: z.array(versionSchema).max(1000),
});
export async function restore(repo: Repository, media: Media, zip: Buffer, workspaceId = 'local') {
  let size = 0;
  const files = unzipSync(zip, {
    filter: (file) => {
      size += file.originalSize;
      if (size > 110 * 1024 * 1024) throw new Error('备份解压后超过 110 MB');
      return file.name === 'project.json' || /^assets\/[a-f0-9-]{36}\.png$/.test(file.name);
    },
  });
  if (!files['project.json'] || files['project.json'].length > 5 * 1024 * 1024)
    throw new Error('无效项目备份');
  const input = importSchema.parse(JSON.parse(strFromU8(files['project.json'])));
  // Validate the whole archive before creating any persistent records.
  for (const a of input.assets)
    if (!files[`assets/${a.id}.png`]) throw new Error('备份缺少素材文件');
  const assetIds = new Set(input.assets.map((a) => a.id));
  const versionIds = new Set(input.versions.map((v) => v.id));
  if (assetIds.size !== input.assets.length || versionIds.size !== input.versions.length)
    throw new Error('备份包含重复的素材或版本 ID');
  const nodeIds = new Set(input.project.board.nodes.map((n) => n.id));
  if (nodeIds.size !== input.project.board.nodes.length) throw new Error('备份包含重复的画布节点');
  if (new Set(input.project.board.edges.map((e) => e.id)).size !== input.project.board.edges.length)
    throw new Error('备份包含重复的连接');
  for (const n of input.project.board.nodes)
    if (
      (n.data.assetId && !assetIds.has(n.data.assetId)) ||
      (n.data.versionId && !versionIds.has(n.data.versionId))
    )
      throw new Error('画布节点引用不存在的内容');
  for (const e of input.project.board.edges)
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target))
      throw new Error('画布连接引用不存在的节点');
  for (const v of input.versions) {
    if (
      (v.kind === 'copy' && !v.copy) ||
      (v.kind === 'poster' && !v.poster) ||
      (v.kind === 'image' && !v.assetId)
    )
      throw new Error('备份中的版本缺少内容');
    if (
      (v.assetId && !assetIds.has(v.assetId)) ||
      (v.poster?.assetId && !assetIds.has(v.poster.assetId))
    )
      throw new Error('版本引用不存在的素材');
    if (v.parentVersionId && !versionIds.has(v.parentVersionId)) throw new Error('来源版本不存在');
    const seen = new Set<string>([v.id]);
    let parent = v.parentVersionId;
    while (parent) {
      if (seen.has(parent)) throw new Error('版本来源存在循环');
      seen.add(parent);
      parent = input.versions.find((x) => x.id === parent)?.parentVersionId;
    }
  }
  const p = await repo.create(`${input.project.title}（恢复）`, input.project.brief, workspaceId);
  const assetMap = new Map<string, string>();
  const versionMap = new Map(input.versions.map((v) => [v.id, randomUUID()]));
  try {
    for (const a of input.assets) {
      const added = await media.ingest(
        p.id,
        Buffer.from(files[`assets/${a.id}.png`]),
        a.name,
        true,
      );
      assetMap.set(a.id, added.id);
    }
    const remapSnapshot = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(remapSnapshot);
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          typeof v === 'string' && ['assetId', 'referenceAssetId'].includes(k)
            ? (assetMap.get(v) ?? v)
            : typeof v === 'string' && ['copyVersionId', 'parentVersionId'].includes(k)
              ? (versionMap.get(v) ?? v)
              : remapSnapshot(v),
        ]),
      );
    };
    for (const v of input.versions) {
      const restored: ContentVersion = {
        ...v,
        id: versionMap.get(v.id)!,
        projectId: p.id,
        parentVersionId: v.parentVersionId ? versionMap.get(v.parentVersionId) : undefined,
        createdAt: v.createdAt ?? new Date().toISOString(),
        assetId: v.assetId ? assetMap.get(v.assetId) : undefined,
        poster: v.poster
          ? { ...v.poster, assetId: v.poster.assetId ? assetMap.get(v.poster.assetId) : undefined }
          : undefined,
      };
      restored.inputSnapshot = remapSnapshot(v.inputSnapshot);
      await repo.db.put('versions', restored.id, restored);
    }
    const nodeMap = new Map(
      input.project.board.nodes.map((n) => [
        n.id,
        versionMap.get(n.id) ?? assetMap.get(n.id) ?? (n.id === 'brief' ? 'brief' : randomUUID()),
      ]),
    );
    const board = {
      ...input.project.board,
      nodes: input.project.board.nodes.map((n) => ({
        ...n,
        id: nodeMap.get(n.id)!,
        data: {
          ...n.data,
          assetId: n.data.assetId ? assetMap.get(n.data.assetId) : undefined,
          versionId: n.data.versionId ? versionMap.get(n.data.versionId) : undefined,
        },
      })),
      edges: input.project.board.edges
        .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
        .map((e) => ({
          ...e,
          id: randomUUID(),
          source: nodeMap.get(e.source)!,
          target: nodeMap.get(e.target)!,
        })),
    };
    await repo.update(p.id, p.revision, { board });
    return repo.detail(p.id);
  } catch (e) {
    for (const a of await repo.db.list<Asset>('assets', p.id)) await media.remove(a.id);
    for (const v of await repo.db.list<ContentVersion>('versions', p.id))
      await repo.db.remove('versions', v.id);
    await repo.db.remove('projects', p.id);
    throw e;
  }
}
