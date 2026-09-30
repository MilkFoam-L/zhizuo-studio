import { randomUUID } from 'node:crypto';
import type {
  Asset,
  ContentVersion,
  Project,
  ProjectDetail,
  GenerationTask,
} from '../../../packages/shared/src/index';
import { EMPTY_BRIEF, initialBoard } from '../../../packages/shared/src/index';
import type { Database } from './db';
export const now = () => new Date().toISOString();
export class Conflict extends Error {
  statusCode = 409;
}
export class NotFound extends Error {
  statusCode = 404;
}
export class Repository {
  constructor(readonly db: Database) {}
  async project(id: string) {
    const p = await this.db.get<Project>('projects', id);
    if (!p) throw new NotFound('项目不存在');
    return p;
  }
  async create(title: string, brief = EMPTY_BRIEF) {
    const p: Project = {
      id: randomUUID(),
      title,
      brief,
      board: initialBoard(),
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    await this.db.put('projects', p.id, p);
    return p;
  }
  async detail(id: string): Promise<ProjectDetail> {
    const project = await this.project(id);
    const [assets, versions, tasks] = await Promise.all([
      this.db.list<Asset>('assets', id),
      this.db.list<ContentVersion>('versions', id),
      this.db.list<GenerationTask>('tasks', id),
    ]);
    return { project, assets, versions, tasks };
  }
  async update(
    id: string,
    revision: number,
    patch: Partial<Pick<Project, 'title' | 'brief' | 'board'>>,
  ) {
    const project = await this.project(id);
    const next = { ...project, ...patch, revision: revision + 1, updatedAt: now() };
    const rows = await this.db.query<{ body: Project }>(
      `UPDATE documents SET body=$3::jsonb WHERE scope='projects' AND id=$1 AND (body->>'revision')::integer=$2 RETURNING body`,
      [id, revision, JSON.stringify(next)],
    );
    if (!rows.length) throw new Conflict('项目已被其他操作更新，本地修改已保留，请合并最新内容');
    return rows[0].body;
  }
  async append(id: string, node: Project['board']['nodes'][number], source = 'brief') {
    for (let attempt = 0; attempt < 8; attempt++) {
      const p = await this.project(id);
      if (p.board.nodes.some((n) => n.id === node.id)) return;
      node.position = {
        x: 440 + (p.board.nodes.length % 3) * 360,
        y: 120 + Math.floor((p.board.nodes.length - 1) / 3) * 400,
      };
      const nodes = [...p.board.nodes, node];
      const edges = p.board.nodes.some((n) => n.id === source)
        ? [...p.board.edges, { id: `${source}-${node.id}`, source, target: node.id }]
        : p.board.edges;
      try {
        await this.update(id, p.revision, { board: { ...p.board, nodes, edges } });
        return;
      } catch (e) {
        if (!(e instanceof Conflict)) throw e;
      }
    }
    throw new Conflict('项目正在频繁更新，请稍后刷新查看结果');
  }
  async version(v: Omit<ContentVersion, 'id' | 'createdAt'> & { id?: string }) {
    const version: ContentVersion = { ...v, id: v.id ?? randomUUID(), createdAt: now() };
    await this.db.put('versions', version.id, version);
    await this.append(
      v.projectId,
      {
        id: version.id,
        type: 'content',
        position: { x: 0, y: 0 },
        data: { kind: v.kind, label: v.label, versionId: version.id, assetId: v.assetId },
      },
      v.parentVersionId ?? 'brief',
    );
    return version;
  }
}
