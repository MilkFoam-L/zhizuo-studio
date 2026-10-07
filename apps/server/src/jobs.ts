import type { Brief, GenerationTask, ProviderInput } from '../../../packages/shared/src/index';
import { randomUUID } from 'node:crypto';
import type { Database } from './db';
import { Media } from './media';
import { Repository, now } from './repository';
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
  workspaceId?: string;
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
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  submissionStartedAt?: string;
  submissionStarted?: boolean;
}

/** Bounded, sanitized lifecycle record. Never contains prompts, keys or payloads. */
export type TaskEventKind =
  | 'queued'
  | 'claimed'
  | 'checkpoint'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'reconcile'
  | 'dead'
  | 'requeued'
  | 'unavailable';
export interface TaskEvent {
  id: string;
  taskId: string;
  projectId: string;
  kind: TaskEventKind;
  at: string;
  workerId?: string;
  detail?: string;
}
export function taskEventKindLabel(kind: TaskEventKind): string {
  return {
    queued: '已入队',
    claimed: '已被领取执行',
    checkpoint: '提交前检查点',
    published: '已发布结果',
    failed: '执行失败',
    cancelled: '已取消',
    reconcile: '结果未知，进入核对',
    dead: '自动查询已停止，需人工核对',
    requeued: '租约过期，未提交故重新排队',
    unavailable: '工作空间不可执行，已取消',
  }[kind];
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
    workerId,
    leaseToken,
    leaseExpiresAt,
    submissionStartedAt,
    submissionStarted,
    ...rest
  } = t;
  return { ...rest, needsAttention: t.recoveryStopped === true };
}

/** Appends one bounded lifecycle event; failures never block the task itself. */
export async function recordTaskEvent(
  db: Database,
  input: {
    taskId: string;
    projectId: string;
    kind: TaskEventKind;
    workerId?: string;
    detail?: string;
  },
) {
  const event: TaskEvent = { id: randomUUID(), at: now(), ...input };
  try {
    await db.put('task_events', event.id, event);
    console.log(
      JSON.stringify({
        channel: 'task_event',
        taskId: input.taskId,
        projectId: input.projectId,
        kind: input.kind,
        at: event.at,
        ...(input.workerId ? { workerId: input.workerId } : {}),
      }),
    );
  } catch {
    // Event persistence is best-effort telemetry, never task state.
  }
}

export async function listTaskEvents(db: Database, taskId: string): Promise<TaskEvent[]> {
  const rows = await db.query<{ body: TaskEvent }>(
    "SELECT body FROM documents WHERE scope='task_events' AND body->>'taskId'=$1 ORDER BY body->>'at' ASC, id ASC",
    [taskId],
  );
  // Keep the timeline bounded even for long-recovering tasks.
  return rows.slice(-100).map((row) => row.body);
}
export function publicProvider(p: StoredProvider) {
  const { secret, workspaceId, ...rest } = p;
  return { ...rest, hasKey: !!secret };
}

export interface JobExecution {
  generateCopy?: typeof generateCopy;
  generateImage?: typeof generateImage;
  resumeImage?: typeof resumeImage;
  onWorkerError?: () => void;
  canRunProject?: (projectId: string) => Promise<boolean>;
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatMs?: number;
  keepAlive?: boolean;
  /** Must be idempotent. Called after durable state changes, including uncertain outcomes. */
  onTaskSettled?: (task: StoredTask) => Promise<void>;
}

class LeaseLost extends Error {}

export class JobRunner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  private running = new Set<Promise<void>>();
  private tickPromise?: Promise<void>;
  private stopping = false;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatMs: number;
  constructor(
    private db: Database,
    private repo: Repository,
    private media: Media,
    private key: string,
    private execution: JobExecution = {},
  ) {
    this.workerId = execution.workerId ?? randomUUID();
    this.leaseDurationMs = execution.leaseDurationMs ?? 60_000;
    this.heartbeatMs = execution.heartbeatMs ?? 10_000;
    if (
      !Number.isFinite(this.leaseDurationMs) ||
      !Number.isFinite(this.heartbeatMs) ||
      this.leaseDurationMs <= 0 ||
      this.heartbeatMs <= 0 ||
      this.heartbeatMs >= this.leaseDurationMs / 2
    )
      throw new Error('任务心跳间隔必须小于租约时长的一半');
  }

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

  private async cancelUnavailable(t: StoredTask) {
    const error =
      '所属账号或工作空间已不可用，任务已取消。' +
      (t.upstreamTaskId || t.submissionStarted || t.submissionStartedAt
        ? '已停止本地等待和自动查询，供应商可能仍在生成并计费，请核对供应商记录。'
        : '');
    // The caller holds the database row lock, shared by API and every worker.
    await this.db.query(
      `UPDATE documents SET body=(body - 'nextRecoveryAt') || $2::jsonb ||
         jsonb_build_object('leaseExpiresAt', clock_timestamp())
       WHERE scope='tasks' AND id=$1 AND body->>'status' IN ('queued','running','reconciling')`,
      [
        t.id,
        JSON.stringify({ status: 'cancelled', recoveryStopped: true, error, updatedAt: now() }),
      ],
    );
    await recordTaskEvent(this.db, {
      taskId: t.id,
      projectId: t.projectId,
      kind: 'unavailable',
      workerId: this.workerId,
    });
  }

  private async locked<T>(
    id: string,
    work: (task: StoredTask | undefined) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async () => {
      const [row] = await this.db.query<{ body: StoredTask }>(
        "SELECT body FROM documents WHERE scope='tasks' AND id=$1 FOR UPDATE",
        [id],
      );
      return work(row?.body);
    });
  }

  private sameLease(current: StoredTask | undefined, claimed: StoredTask): current is StoredTask {
    return !!current && !!claimed.leaseToken && current.leaseToken === claimed.leaseToken;
  }

  /** Database time fences workers even if their host clocks disagree. Caller holds the row lock. */
  private async renew(t: StoredTask): Promise<StoredTask | undefined> {
    const [row] = await this.db.query<{ body: StoredTask }>(
      `UPDATE documents SET body=body || jsonb_build_object(
         'leaseExpiresAt', clock_timestamp() + ($3::double precision * interval '1 millisecond'))
       WHERE scope='tasks' AND id=$1 AND body->>'status'='running'
         AND body->>'leaseToken'=$2
         AND (body->>'leaseExpiresAt')::timestamptz > clock_timestamp()
       RETURNING body`,
      [t.id, t.leaseToken, this.leaseDurationMs],
    );
    return row?.body;
  }

  private async expireLeases() {
    // A new-format record explicitly proves no paid submission began. Clear its
    // old fencing token before returning it to the queue; legacy records stay uncertain.
    const requeued = await this.db.query<{ body: StoredTask }>(
      `UPDATE documents SET body=(body - 'workerId' - 'leaseToken' - 'leaseExpiresAt' - 'error') || $1::jsonb
       WHERE scope='tasks' AND body->>'status'='running'
         AND body->>'submissionStarted'='false'
         AND body->>'submissionStartedAt' IS NULL AND body->>'upstreamTaskId' IS NULL
         AND (body->>'leaseExpiresAt' IS NULL OR
           (body->>'leaseExpiresAt')::timestamptz <= clock_timestamp()) RETURNING body`,
      [JSON.stringify({ status: 'queued', updatedAt: now() })],
    );
    for (const { body } of requeued)
      await recordTaskEvent(this.db, {
        taskId: body.id,
        projectId: body.projectId,
        kind: 'requeued',
      });
    const expired = await this.db.query<{ body: StoredTask }>(
      `UPDATE documents SET body=body || $1::jsonb
       WHERE scope='tasks' AND body->>'status'='running'
         AND (body->>'leaseExpiresAt' IS NULL OR
           (body->>'leaseExpiresAt')::timestamptz <= clock_timestamp()) RETURNING body`,
      [
        JSON.stringify({
          status: 'reconciling',
          error:
            '执行进程租约已过期。已保存的异步任务会在恢复限额内继续查询；其余任务请在供应商控制台核对结果和费用。',
          updatedAt: now(),
        }),
      ],
    );
    for (const { body } of expired) {
      await recordTaskEvent(this.db, {
        taskId: body.id,
        projectId: body.projectId,
        kind: 'reconcile',
        detail: '执行进程中断，提交结果未知',
      });
      await this.settled(body.id);
    }
  }

  private async settled(id: string) {
    const task = await this.locked(id, async (current) => {
      if (!current || ['queued', 'running'].includes(current.status)) return;
      // The same row lock prevents a delayed worker from overwriting newer usage status.
      await this.db.put('usage', id, {
        id,
        projectId: current.projectId,
        providerId: current.providerId,
        kind: current.kind,
        status: current.status,
        cost: null,
        costStatus: 'not_reported',
        createdAt: now(),
      });
      return current;
    });
    if (task) await this.execution.onTaskSettled?.(task);
  }

  async start() {
    if (this.timer) return;
    this.stopping = false;
    // Starting another process must not disturb an existing worker's live lease.
    await this.expireLeases();
    const poll = () => {
      void this.tick().catch(() => this.reportError());
    };
    this.timer = setInterval(poll, 800);
    if (!this.execution.keepAlive) this.timer.unref();
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
    await this.expireLeases();
    if (this.active.size >= 2) return;
    const tasks = await this.db.list<StoredTask>('tasks');
    for (const t of tasks.reverse()) {
      if (this.stopping || this.active.size >= 2) break;
      if (this.active.has(t.id)) continue;
      if (!['queued', 'reconciling'].includes(t.status)) continue;
      if (t.status === 'reconciling' && !this.canRecover(t)) continue;
      const claimed = await this.locked(t.id, async (current) => {
        if (!current || this.stopping || this.active.has(t.id)) return;
        const recovering = current.upstreamTaskId !== undefined;
        if (
          (current.status !== 'queued' && current.status !== 'reconciling') ||
          (current.status === 'reconciling' && !this.canRecover(current)) ||
          (recovering && !this.canRecover(current)) ||
          (current.nextRecoveryAt && Date.parse(current.nextRecoveryAt) > Date.now())
        )
          return;
        if (
          this.execution.canRunProject &&
          !(await this.execution.canRunProject(current.projectId))
        ) {
          await this.cancelUnavailable(current);
          return;
        }
        // A durable pre-submit checkpoint always wins over an accidentally queued status.
        if (!recovering && (current.submissionStartedAt || current.submissionStarted)) {
          await this.db.put('tasks', current.id, {
            ...current,
            status: 'reconciling',
            error: '任务曾准备提交且结果未知，请核对供应商记录后再创建新任务。',
            updatedAt: now(),
          });
          await recordTaskEvent(this.db, {
            taskId: current.id,
            projectId: current.projectId,
            kind: 'reconcile',
            workerId: this.workerId,
            detail: '发现提交前检查点，提交结果未知',
          });
          return;
        }
        const patch = {
          status: 'running',
          attempts: current.attempts + 1,
          workerId: this.workerId,
          leaseToken: randomUUID(),
          updatedAt: now(),
          ...(recovering
            ? {
                recoveryAttempts: (current.recoveryAttempts ?? 0) + 1,
                recoveryDeadlineAt: new Date(this.recoveryDeadline(current)).toISOString(),
              }
            : {}),
        };
        const [row] = await this.db.query<{ body: StoredTask }>(
          `UPDATE documents SET body=(body - 'error' - 'nextRecoveryAt') || $2::jsonb ||
             jsonb_build_object('leaseExpiresAt', clock_timestamp() + ($3::double precision * interval '1 millisecond'))
           WHERE scope='tasks' AND id=$1 AND body->>'status'='${current.status === 'queued' ? 'queued' : 'reconciling'}'
           RETURNING body`,
          [current.id, JSON.stringify(patch), this.leaseDurationMs],
        );
        if (row) return { task: row.body, previous: current };
      });
      if (!claimed) {
        await this.settled(t.id);
        continue;
      }
      await recordTaskEvent(this.db, {
        taskId: claimed.task.id,
        projectId: claimed.task.projectId,
        kind: 'claimed',
        workerId: this.workerId,
      });
      if (this.stopping) {
        await this.releaseUnsent(claimed.task, claimed.previous);
        continue;
      }
      const controller = new AbortController();
      this.active.set(t.id, controller);
      const pending = this.run(claimed.task, controller, claimed.previous)
        .catch(() => this.reportError())
        .finally(() => {
          this.active.delete(t.id);
          this.running.delete(pending);
        });
      this.running.add(pending);
    }
  }

  private async releaseUnsent(t: StoredTask, previous: StoredTask) {
    await this.locked(t.id, async (current) => {
      if (
        this.sameLease(current, t) &&
        current.status === 'running' &&
        !current.submissionStartedAt
      ) {
        await this.db.put('tasks', t.id, { ...previous, updatedAt: now() });
      }
    });
  }

  async cancel(id: string) {
    const result = await this.locked(id, async (t) => {
      if (!t) throw new Error('任务不存在');
      if (!['queued', 'running', 'reconciling'].includes(t.status)) return publicTask(t);
      const patch = {
        status: 'cancelled',
        recoveryStopped: true,
        error:
          t.status !== 'queued' || t.upstreamTaskId
            ? '已停止本地等待和自动查询，供应商可能仍在生成并计费，请核对供应商记录。'
            : undefined,
        updatedAt: now(),
      };
      await this.db.query(
        `UPDATE documents SET body=(body - 'nextRecoveryAt') || $2::jsonb ||
           jsonb_build_object('leaseExpiresAt', clock_timestamp())
         WHERE scope='tasks' AND id=$1 AND body->>'status' IN ('queued','running','reconciling')`,
        [id, JSON.stringify(patch)],
      );
      this.active.get(id)?.abort();
      const final = (await this.db.get<StoredTask>('tasks', id))!;
      if (final.status === 'cancelled' && t.status !== 'cancelled')
        await recordTaskEvent(this.db, {
          taskId: id,
          projectId: final.projectId,
          kind: 'cancelled',
          detail: final.error,
        });
      return publicTask(final);
    });
    await this.settled(id);
    return result;
  }

  private async cleanup(t: StoredTask, assetId?: string) {
    // Versions and board nodes publish atomically. A stale worker must never remove them.
    // Only compensate the unique asset produced by this invocation, and preserve references.
    if (assetId) await this.media.removeIfUnreferenced(assetId, t.projectId);
  }

  private async checkpoint(t: StoredTask, controller: AbortController, submission = false) {
    return this.locked(t.id, async (current) => {
      if (!this.sameLease(current, t) || current.status !== 'running' || controller.signal.aborted)
        throw new LeaseLost('任务已取消或执行租约已失效');
      if (this.execution.canRunProject && !(await this.execution.canRunProject(t.projectId))) {
        await this.cancelUnavailable(current);
        return false;
      }
      const renewed = await this.renew(t);
      if (!renewed || controller.signal.aborted) throw new LeaseLost('执行租约已失效');
      if (submission) {
        await this.db.put('tasks', t.id, {
          ...renewed,
          submissionStarted: true,
          submissionStartedAt: now(),
        });
        await recordTaskEvent(this.db, {
          taskId: t.id,
          projectId: t.projectId,
          kind: 'checkpoint',
          workerId: this.workerId,
        });
      }
      return true;
    });
  }

  private async run(t: StoredTask, controller: AbortController, previous: StoredTask) {
    const recovering = t.upstreamTaskId !== undefined;
    const timeoutMs = recovering
      ? Math.min(t.config.timeoutSeconds * 1000, Math.max(1, this.recoveryDeadline(t) - Date.now()))
      : t.config.timeoutSeconds * 1000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    let heartbeatPending: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      if (this.stopping) {
        controller.abort();
        return;
      }
      heartbeatPending = this.checkpoint(t, controller)
        .then((allowed) => {
          if (!allowed) controller.abort();
        })
        .catch((error) => {
          controller.abort();
          if (!(error instanceof LeaseLost)) this.reportError();
        })
        .finally(() => {
          heartbeatPending = undefined;
        });
    }, this.heartbeatMs);
    heartbeat.unref();
    let createdAssetId: string | undefined;
    let providerCompleted = false;
    let published = false;
    try {
      const key = decryptSecret(t.secret, this.key);
      let copy: Awaited<ReturnType<typeof generateCopy>> | undefined;
      let image: Awaited<ReturnType<typeof generateImage>> | undefined;
      let reference;
      if (t.kind === 'image' && !recovering && t.referenceAssetId) {
        const asset = await this.media.owned(t.referenceAssetId, t.projectId);
        reference = {
          bytes: await this.media.bytes(asset.id),
          mime: asset.mime,
          name: asset.name,
        };
      }
      // The paid-request checkpoint is committed before entering any supplier code.
      // A crash in this gap is conservatively uncertain, never permission to POST again.
      if (!(await this.checkpoint(t, controller, !recovering))) return;
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
      else
        image = await (this.execution.generateImage ?? generateImage)(
          t.config,
          key,
          t.prompt,
          reference,
          controller.signal,
          async (upstreamTaskId) => {
            await this.locked(t.id, async (current) => {
              // A receipt is useful for accounting even if cancellation or expiry won.
              // A newer lease fences this callback; it can never resurrect task state.
              if (!this.sameLease(current, t)) throw new LeaseLost('执行租约已被其他进程接替');
              await this.db.put('tasks', t.id, {
                ...current,
                upstreamTaskId,
                recoveryAttempts: 0,
                recoveryDeadlineAt: new Date(Date.now() + RECOVERY_WINDOW_MS).toISOString(),
                updatedAt: now(),
              });
            });
          },
        );
      providerCompleted = true;
      // Blob storage can be slow. It runs outside the publication transaction while
      // heartbeat renewals and an independent API cancellation continue to work.
      if (!(await this.checkpoint(t, controller))) return;
      let data: Parameters<Repository['version']>[0];
      if (copy) {
        data = {
          projectId: t.projectId,
          kind: 'copy',
          label: `${t.brief.productName || '内容'} · 图文草稿`,
          copy,
        };
      } else {
        const asset = await this.media.ingest(
          t.projectId,
          image!.bytes,
          `${t.brief.productName || '创意'}-生成图片.png`,
        );
        createdAssetId = asset.id;
        data = { projectId: t.projectId, kind: 'image', label: 'AI 视觉方案', assetId: asset.id };
      }
      published = await this.locked(t.id, async (current) => {
        if (
          !this.sameLease(current, t) ||
          current.status !== 'running' ||
          controller.signal.aborted
        )
          return false;
        if (this.execution.canRunProject && !(await this.execution.canRunProject(t.projectId))) {
          await this.cancelUnavailable(current);
          return false;
        }
        if (!(await this.renew(t))) return false;
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
          `UPDATE documents SET body=(body - 'error' - 'nextRecoveryAt') || $2::jsonb ||
             jsonb_build_object('leaseExpiresAt', clock_timestamp())
           WHERE scope='tasks' AND id=$1 AND body->>'status'='running'
             AND body->>'leaseToken'=$3
             AND (body->>'leaseExpiresAt')::timestamptz > clock_timestamp()
           RETURNING body`,
          [
            t.id,
            JSON.stringify({ status: 'succeeded', resultVersionId: version.id, updatedAt: now() }),
            t.leaseToken,
          ],
        );
        if (!completed.length) throw new LeaseLost('发布前执行租约已失效');
        await recordTaskEvent(this.db, {
          taskId: t.id,
          projectId: t.projectId,
          kind: 'published',
          workerId: this.workerId,
          detail: `结果版本 ${version.id}`,
        });
        return true;
      });
      if (!published) throw new LeaseLost('任务已取消或执行租约已失效');
    } catch (error) {
      // The commit response may be lost after the database committed success.
      const saved = await this.db.get<StoredTask>('tasks', t.id);
      if (saved?.status === 'succeeded') {
        if (this.sameLease(saved, t)) published = true;
        return;
      }
      let cleaned = true;
      try {
        await this.cleanup(t, createdAssetId);
      } catch {
        cleaned = false;
        this.reportError();
      }
      createdAssetId = undefined;
      await this.expireLeases();
      await this.locked(t.id, async (current) => {
        if (!this.sameLease(current, t) || current.status !== 'running') return;
        if (this.stopping && !current.submissionStartedAt && !recovering) {
          await this.db.put('tasks', t.id, { ...previous, updatedAt: now() });
          return;
        }
        if (!(await this.renew(t))) return;
        const cancelled = error instanceof ProviderCancelledError;
        const uncertain =
          !cancelled &&
          (providerCompleted ||
            !cleaned ||
            error instanceof ProviderUncertainError ||
            (controller.signal.aborted && (!!current.submissionStartedAt || recovering)));
        const retry = uncertain && cleaned && this.canRecover(current);
        const nextTime = retry
          ? Date.now() + RECOVERY_DELAYS_MS[current.recoveryAttempts ?? 0]
          : undefined;
        const nextRecoveryAt =
          nextTime && nextTime < this.recoveryDeadline(current)
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
          uncertain && current.upstreamTaskId && !nextRecoveryAt
            ? ' 自动查询已停止，请在供应商后台核对原任务结果与费用。'
            : '';
        const finalKind: TaskEventKind = cancelled
          ? 'cancelled'
          : uncertain && !nextRecoveryAt
            ? 'dead'
            : uncertain
              ? 'reconcile'
              : 'failed';
        await this.db.query(
          `UPDATE documents SET body=(body - 'nextRecoveryAt') || $2::jsonb ||
             jsonb_build_object('leaseExpiresAt', clock_timestamp())
           WHERE scope='tasks' AND id=$1 AND body->>'status'='running' AND body->>'leaseToken'=$3`,
          [
            t.id,
            JSON.stringify({
              status: cancelled ? 'cancelled' : uncertain ? 'reconciling' : 'failed',
              error: (message + limit).slice(0, 500),
              nextRecoveryAt,
              recoveryStopped: uncertain && !nextRecoveryAt,
              updatedAt: now(),
            }),
            t.leaseToken,
          ],
        );
        await recordTaskEvent(this.db, {
          taskId: t.id,
          projectId: t.projectId,
          kind: finalKind,
          workerId: this.workerId,
          detail: (message + limit).slice(0, 300),
        });
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      await heartbeatPending;
      if (!published && createdAssetId) await this.cleanup(t, createdAssetId);
      await this.settled(t.id);
    }
  }
}
