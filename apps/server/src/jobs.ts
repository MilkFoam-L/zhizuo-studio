import type {
  Brief,
  ContentVersion,
  GenerationTask,
  Project,
  ProviderInput,
} from '../../../packages/shared/src/index';
import type { Database } from './db';
import { Media } from './media';
import { Conflict, Repository, now } from './repository';
import {
  decryptSecret,
  generateCopy,
  generateImage,
  resumeImage,
  ProviderCancelledError,
  ProviderUncertainError,
} from './providers';

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_DELAYS_MS = [5000, 15000, 45000];

export interface StoredProvider extends Omit<ProviderInput, 'apiKey'> {
  id: string;
  secret: string;
  createdAt: string;
}
export interface StoredTask extends GenerationTask {
  brief: Brief;
  config: Omit<ProviderInput, 'apiKey'>;
  secret: string;
  recoveryAttempts?: number;
  recoveryDeadlineAt?: string;
  nextRecoveryAt?: string;
  recoveryStopped?: boolean;
}
export function publicTask(t: StoredTask): GenerationTask {
  const {
    brief,
    config,
    secret,
    recoveryAttempts,
    recoveryDeadlineAt,
    nextRecoveryAt,
    recoveryStopped,
    ...rest
  } = t;
  return rest;
}
export function publicProvider(p: StoredProvider) {
  const { secret, ...rest } = p;
  return { ...rest, hasKey: !!secret };
}

export interface JobExecution {
  generateCopy?: typeof generateCopy;
  generateImage?: typeof generateImage;
  resumeImage?: typeof resumeImage;
  onWorkerError?: () => void;
}

export class JobRunner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  private running = new Set<Promise<void>>();
  private tickPromise?: Promise<void>;
  private stopping = false;
  private locks = new Map<string, Promise<void>>();
  constructor(
    private db: Database,
    private repo: Repository,
    private media: Media,
    private key: string,
    private execution: JobExecution = {},
  ) {}

  private reportError() {
    if (this.execution.onWorkerError) this.execution.onWorkerError();
    else console.error('生成任务处理失败，请检查服务端数据库和存储状态');
  }

  private recoveryDeadline(t: StoredTask): number {
    return t.recoveryDeadlineAt
      ? Date.parse(t.recoveryDeadlineAt)
      : Date.parse(t.createdAt) + RECOVERY_WINDOW_MS;
  }

  private canRecover(t: StoredTask): boolean {
    return (
      !t.recoveryStopped &&
      t.kind === 'image' &&
      t.config.kind === 'async-json' &&
      typeof t.upstreamTaskId === 'string' &&
      /^[a-zA-Z0-9_-]{1,200}$/.test(t.upstreamTaskId) &&
      (t.recoveryAttempts ?? 0) < MAX_RECOVERY_ATTEMPTS &&
      this.recoveryDeadline(t) > Date.now()
    );
  }

  // This deployment runs one worker process. Claim, cancellation and publication share
  // one per-task lock so cancellation never observes a half-published task.
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(id, next);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  async start() {
    if (this.timer) return;
    this.stopping = false;
    // Interrupted paid requests remain uncertain. Only a saved async task ID can be
    // resumed by the polling loop; other protocols are never resubmitted here.
    await this.db.query(
      `UPDATE documents SET body=body || $1::jsonb WHERE scope='tasks' AND body->>'status'='running'`,
      [
        JSON.stringify({
          status: 'reconciling',
          error:
            '服务曾中断。已保存的异步任务会在恢复限额内继续查询；其余任务请在供应商控制台核对结果和费用。',
          updatedAt: now(),
        }),
      ],
    );
    const poll = () => {
      void this.tick().catch(() => this.reportError());
    };
    this.timer = setInterval(poll, 800);
    this.timer.unref();
    poll();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    // A tick may be waiting on the database; drain it before the caller closes storage.
    await this.tickPromise?.catch(() => this.reportError());
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.running]);
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.tickPromise) return this.tickPromise;
    const pending = this.poll().finally(() => {
      if (this.tickPromise === pending) this.tickPromise = undefined;
    });
    this.tickPromise = pending;
    return pending;
  }

  private async poll() {
    if (this.active.size >= 2) return;
    const tasks = await this.db.list<StoredTask>('tasks');
    for (const t of tasks.reverse()) {
      if (this.stopping || this.active.size >= 2) break;
      if (this.active.has(t.id)) continue;
      const recovering = t.upstreamTaskId !== undefined;
      if (
        t.status !== 'queued' &&
        !(
          t.status === 'reconciling' &&
          this.canRecover(t) &&
          (!t.nextRecoveryAt || Date.parse(t.nextRecoveryAt) <= Date.now())
        )
      )
        continue;
      // Even a queued record with an upstream ID must use GET, never submit again.
      if (recovering && !this.canRecover(t)) continue;
      await this.locked(t.id, async () => {
        if (this.stopping || this.active.has(t.id)) return;
        const patch = {
          status: 'running',
          attempts: t.attempts + 1,
          updatedAt: now(),
          ...(recovering
            ? {
                recoveryAttempts: (t.recoveryAttempts ?? 0) + 1,
                recoveryDeadlineAt: new Date(this.recoveryDeadline(t)).toISOString(),
              }
            : {}),
        };
        const claimed = await this.db.query<{ body: StoredTask }>(
          `UPDATE documents SET body=(body - 'error' - 'nextRecoveryAt') || $2::jsonb WHERE scope='tasks' AND id=$1 AND body->>'status'='${t.status === 'queued' ? 'queued' : 'reconciling'}' RETURNING body`,
          [t.id, JSON.stringify(patch)],
        );
        if (!claimed.length) return;
        if (this.stopping) {
          // No supplier request has started, so safely return this claim to the queue.
          await this.db.query(
            `UPDATE documents SET body=body || $2::jsonb WHERE scope='tasks' AND id=$1 AND body->>'status'='running'`,
            [
              t.id,
              JSON.stringify({
                status: t.status,
                attempts: t.attempts,
                recoveryAttempts: t.recoveryAttempts ?? 0,
                nextRecoveryAt: t.nextRecoveryAt,
                error: t.error,
                updatedAt: now(),
              }),
            ],
          );
          return;
        }
        const controller = new AbortController();
        this.active.set(t.id, controller);
        const pending = this.run(claimed[0].body, controller)
          .catch(() => this.reportError())
          .finally(() => {
            this.active.delete(t.id);
            this.running.delete(pending);
          });
        this.running.add(pending);
      });
    }
  }

  async cancel(id: string) {
    return this.locked(id, async () => {
      const t = await this.db.get<StoredTask>('tasks', id);
      if (!t) throw new Error('任务不存在');
      if (!['queued', 'running', 'reconciling'].includes(t.status)) return publicTask(t);
      const patch = {
        status: 'cancelled',
        error:
          t.status !== 'queued' || t.upstreamTaskId
            ? '已停止本地等待和自动查询，供应商可能仍在生成并计费，请核对供应商记录。'
            : undefined,
        updatedAt: now(),
      };
      await this.db.query(
        `UPDATE documents SET body=(body - 'nextRecoveryAt') || $2::jsonb WHERE scope='tasks' AND id=$1 AND body->>'status' IN ('queued','running','reconciling')`,
        [id, JSON.stringify(patch)],
      );
      this.active.get(id)?.abort();
      return publicTask((await this.db.get<StoredTask>('tasks', id))!);
    });
  }

  private async cleanup(t: StoredTask, assetId?: string) {
    const version = await this.db.get<ContentVersion>('versions', t.id);
    if (version?.taskId === t.id && version.projectId === t.projectId) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const project = await this.repo.project(t.projectId);
        const nodeIds = new Set(
          project.board.nodes
            .filter((n) => n.id === t.id || n.data.versionId === t.id)
            .map((n) => n.id),
        );
        if (!nodeIds.size) break;
        const board: Project['board'] = {
          ...project.board,
          nodes: project.board.nodes.filter((n) => !nodeIds.has(n.id)),
          edges: project.board.edges.filter(
            (e) => !nodeIds.has(e.source) && !nodeIds.has(e.target),
          ),
        };
        try {
          await this.repo.update(t.projectId, project.revision, { board });
          break;
        } catch (error) {
          if (!(error instanceof Conflict) || attempt === 7) throw error;
        }
      }
      await this.db.remove('versions', t.id);
    }
    if (assetId) {
      const versions = await this.db.list<ContentVersion>('versions', t.projectId);
      const project = await this.repo.project(t.projectId);
      if (
        !versions.some((v) => v.assetId === assetId || v.poster?.assetId === assetId) &&
        !project.board.nodes.some((n) => n.data.assetId === assetId)
      )
        await this.media.remove(assetId);
    }
  }

  private async run(t: StoredTask, controller: AbortController) {
    const recovering = t.upstreamTaskId !== undefined;
    const timeoutMs = recovering
      ? Math.min(t.config.timeoutSeconds * 1000, Math.max(1, this.recoveryDeadline(t) - Date.now()))
      : t.config.timeoutSeconds * 1000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    let createdAssetId: string | undefined;
    let providerCompleted = false;
    try {
      const key = decryptSecret(t.secret, this.key);
      let copy: Awaited<ReturnType<typeof generateCopy>> | undefined;
      let image: Awaited<ReturnType<typeof generateImage>> | undefined;
      if (t.kind === 'copy')
        copy = await (this.execution.generateCopy ?? generateCopy)(
          t.config,
          key,
          t.brief,
          t.prompt,
          controller.signal,
        );
      else if (recovering)
        image = await (this.execution.resumeImage ?? resumeImage)(
          t.config,
          key,
          t.upstreamTaskId!,
          controller.signal,
        );
      else {
        let reference;
        if (t.referenceAssetId) {
          const asset = await this.media.owned(t.referenceAssetId, t.projectId);
          reference = {
            bytes: await this.media.bytes(asset.id),
            mime: asset.mime,
            name: asset.name,
          };
        }
        image = await (this.execution.generateImage ?? generateImage)(
          t.config,
          key,
          t.prompt,
          reference,
          controller.signal,
          async (upstreamTaskId) => {
            await this.locked(t.id, async () => {
              // Record an accepted ID even when cancellation won the lock. This patch
              // never changes task status, so it cannot resurrect a cancelled task.
              const saved = await this.db.query(
                `UPDATE documents SET body=body || $2::jsonb WHERE scope='tasks' AND id=$1 RETURNING body`,
                [
                  t.id,
                  JSON.stringify({
                    upstreamTaskId,
                    recoveryAttempts: 0,
                    recoveryDeadlineAt: new Date(Date.now() + RECOVERY_WINDOW_MS).toISOString(),
                    updatedAt: now(),
                  }),
                ],
              );
              if (!saved.length) throw new Error('生成任务记录不存在');
            });
          },
        );
      }
      providerCompleted = true;
      await this.locked(t.id, async () => {
        if ((await this.db.get<StoredTask>('tasks', t.id))?.status !== 'running') return;
        let data: Parameters<Repository['version']>[0];
        if (copy)
          data = {
            projectId: t.projectId,
            kind: 'copy',
            label: `${t.brief.productName || '内容'} · 图文草稿`,
            copy,
          };
        else {
          const asset = await this.media.ingest(
            t.projectId,
            image!.bytes,
            `${t.brief.productName || '创意'}-生成图片.png`,
          );
          createdAssetId = asset.id;
          data = { projectId: t.projectId, kind: 'image', label: 'AI 视觉方案', assetId: asset.id };
        }
        const version = await this.repo.version({
          ...data,
          id: t.id,
          parentVersionId: t.parentVersionId,
          taskId: t.id,
          inputSnapshot: {
            brief: t.brief,
            prompt: t.prompt,
            provider: t.config.name,
            model: t.kind === 'copy' ? t.config.textModel : t.config.imageModel,
            referenceAssetId: t.referenceAssetId,
          },
        });
        const completed = await this.db.query<{ body: StoredTask }>(
          `UPDATE documents SET body=(body - 'error' - 'nextRecoveryAt') || $2::jsonb WHERE scope='tasks' AND id=$1 AND body->>'status'='running' RETURNING body`,
          [
            t.id,
            JSON.stringify({ status: 'succeeded', resultVersionId: version.id, updatedAt: now() }),
          ],
        );
        if (!completed.length) await this.cleanup(t, createdAssetId);
      });
    } catch (error) {
      await this.locked(t.id, async () => {
        const current = await this.db.get<StoredTask>('tasks', t.id);
        // A lost database response must not erase an already committed success.
        if (current?.status === 'succeeded') return;
        let cleaned = true;
        try {
          await this.cleanup(t, createdAssetId);
        } catch {
          cleaned = false;
          this.reportError();
        }
        const cancelled = error instanceof ProviderCancelledError;
        const uncertain =
          !cancelled &&
          (providerCompleted ||
            !cleaned ||
            error instanceof ProviderUncertainError ||
            controller.signal.aborted);
        const retry = uncertain && cleaned && current && this.canRecover(current);
        const nextTime = retry
          ? Date.now() + RECOVERY_DELAYS_MS[current.recoveryAttempts ?? 0]
          : undefined;
        const nextRecoveryAt =
          nextTime && current && nextTime < this.recoveryDeadline(current)
            ? new Date(nextTime).toISOString()
            : undefined;
        const message = nextRecoveryAt
          ? '图片任务已提交，稍后将自动查询原任务，不会重新生成；可取消自动查询。供应商费用需另行核对。'
          : providerCompleted
            ? '服务商已返回内容，但本地保存未完成；请先核对任务与服务商记录，避免重复计费。'
            : error instanceof Error
              ? error.message
              : '生成未完成';
        const limit =
          uncertain && current?.upstreamTaskId && !nextRecoveryAt
            ? ' 自动查询已停止，请在供应商后台核对原任务结果与费用。'
            : '';
        await this.db.query(
          `UPDATE documents SET body=(body - 'nextRecoveryAt') || $2::jsonb WHERE scope='tasks' AND id=$1 AND body->>'status'='running'`,
          [
            t.id,
            JSON.stringify({
              status: cancelled ? 'cancelled' : uncertain ? 'reconciling' : 'failed',
              error: (message + limit).slice(0, 500),
              nextRecoveryAt,
              recoveryStopped: uncertain && !nextRecoveryAt,
              updatedAt: now(),
            }),
          ],
        );
      });
    } finally {
      clearTimeout(timeout);
      const last = await this.db.get<StoredTask>('tasks', t.id);
      // Supplier costs are unknown unless the supplier reports them. Never invent a price.
      await this.db.put('usage', t.id, {
        id: t.id,
        projectId: t.projectId,
        providerId: t.providerId,
        kind: t.kind,
        status: last?.status,
        cost: null,
        costStatus: 'not_reported',
        createdAt: now(),
      });
    }
  }
}
