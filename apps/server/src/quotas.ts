import { randomUUID } from 'node:crypto';
import type { GenerationTask } from '../../../packages/shared/src/index';
import type { Database } from './db';

export type QuotaState = 'reserved' | 'consumed' | 'released' | 'review';
export interface QuotaReservation {
  taskId: string;
  workspaceId: string;
  period: string;
  state: QuotaState;
  createdAt: string;
  updatedAt: string;
}
export interface QuotaEvent {
  id: string;
  workspaceId: string;
  period: string;
  taskId?: string;
  action: 'reserve' | 'consume' | 'release' | 'review' | 'set_limit';
  previousState?: QuotaState;
  state?: QuotaState;
  previousLimit?: number;
  limit?: number;
  reason: string;
  actorId?: string;
  createdAt: string;
}
export interface QuotaSummary {
  workspaceId: string;
  period: string;
  timeZone: 'Asia/Shanghai';
  unit: 'task';
  limit: number;
  reserved: number;
  consumed: number;
  available: number;
  reviewCount: number;
  records: QuotaReservation[];
  events: QuotaEvent[];
}
export interface QuotaReviewPage {
  records: QuotaReservation[];
  nextCursor?: string;
}

export class QuotaError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code:
      | 'INVALID_QUOTA_INPUT'
      | 'QUOTA_EXCEEDED'
      | 'QUOTA_CONFLICT'
      | 'QUOTA_NOT_FOUND'
      | 'QUOTA_NOT_REVIEWABLE',
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}

interface ReservationRow {
  task_id: string;
  workspace_id: string;
  period: string;
  state: QuotaState;
  created_at: Date | string;
  updated_at: Date | string;
}
interface WindowRow {
  limit: number;
  reserved: number;
  consumed: number;
}
interface ReviewCursor {
  version: 1;
  workspaceId: string;
  createdAt: string;
  taskId: string;
}

const MAX_LIMIT = 1_000_000;
const periodFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function quotaPeriod(date = new Date()): string {
  const parts = periodFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function validLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT)
    throw new QuotaError(`每日任务额度须为 0 至 ${MAX_LIMIT} 的整数`, 400, 'INVALID_QUOTA_INPUT');
}
function validId(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /\p{Cc}/u.test(value))
    throw new QuotaError('任务、空间或操作人标识不正确', 400, 'INVALID_QUOTA_INPUT');
}
function auditReason(reason: string): string {
  if (
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.trim().length > 500 ||
    /\p{Cc}/u.test(reason.replace(/[\n\r\t]/g, ''))
  )
    throw new QuotaError('请填写 1 至 500 字的核对依据或修改原因', 400, 'INVALID_QUOTA_INPUT');
  return reason.trim();
}
function reservation(row: ReservationRow): QuotaReservation {
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    period: row.period,
    state: row.state,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
function reviewCursor(value: QuotaReservation): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      workspaceId: value.workspaceId,
      createdAt: value.createdAt,
      taskId: value.taskId,
    } satisfies ReviewCursor),
  ).toString('base64url');
}
function readReviewCursor(token: string, workspaceId: string): ReviewCursor {
  try {
    if (typeof token !== 'string' || token.length > 2_000 || !/^[\w-]+$/.test(token))
      throw new Error('Invalid cursor');
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error('Invalid cursor');
    const value = JSON.parse(bytes.toString('utf8')) as ReviewCursor;
    if (
      !value ||
      Object.keys(value).length !== 4 ||
      value.version !== 1 ||
      value.workspaceId !== workspaceId ||
      typeof value.createdAt !== 'string' ||
      new Date(value.createdAt).toISOString() !== value.createdAt
    )
      throw new Error('Invalid cursor');
    validId(value.taskId);
    return value;
  } catch {
    throw new QuotaError('分页游标无效，请刷新待核对列表', 400, 'INVALID_QUOTA_INPUT');
  }
}

export class QuotaService {
  constructor(
    private readonly db: Database,
    private readonly defaultLimit = 100,
  ) {
    validLimit(defaultLimit);
  }

  async initialize() {
    await this.db.transaction(async () => {
      await this.db.query(`CREATE TABLE IF NOT EXISTS quota_policies (
        workspace_id text PRIMARY KEY,
        daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 0 AND ${MAX_LIMIT})
      )`);
      await this.db.query(`CREATE TABLE IF NOT EXISTS quota_windows (
        workspace_id text NOT NULL REFERENCES quota_policies(workspace_id),
        period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
        "limit" integer NOT NULL CHECK ("limit" BETWEEN 0 AND ${MAX_LIMIT}),
        reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
        consumed integer NOT NULL DEFAULT 0 CHECK (consumed >= 0),
        PRIMARY KEY (workspace_id, period),
        CHECK (reserved + consumed <= "limit")
      )`);
      await this.db.query(`CREATE TABLE IF NOT EXISTS quota_reservations (
        task_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        period text NOT NULL,
        state text NOT NULL CHECK (state IN ('reserved', 'consumed', 'released', 'review')),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        FOREIGN KEY (workspace_id, period) REFERENCES quota_windows(workspace_id, period)
      )`);
      await this.db.query(`CREATE INDEX IF NOT EXISTS quota_reservations_workspace
        ON quota_reservations(workspace_id, updated_at DESC, task_id)`);
      await this.db.query(`CREATE INDEX IF NOT EXISTS quota_reservations_reviews
        ON quota_reservations(workspace_id, created_at, task_id) WHERE state='review'`);
      await this.db.query(`CREATE TABLE IF NOT EXISTS quota_events (
        sequence bigserial PRIMARY KEY,
        workspace_id text NOT NULL,
        body jsonb NOT NULL
      )`);
      await this.db.query(`CREATE INDEX IF NOT EXISTS quota_events_workspace
        ON quota_events(workspace_id, sequence DESC)`);
    });
  }

  // The policy row serializes window creation and edits across server processes.
  private async window(workspaceId: string, period: string): Promise<WindowRow> {
    await this.db.query(
      `INSERT INTO quota_policies(workspace_id, daily_limit) VALUES($1,$2)
       ON CONFLICT(workspace_id) DO NOTHING`,
      [workspaceId, this.defaultLimit],
    );
    const [policy] = await this.db.query<{ daily_limit: number }>(
      'SELECT daily_limit FROM quota_policies WHERE workspace_id=$1 FOR UPDATE',
      [workspaceId],
    );
    await this.db.query(
      `INSERT INTO quota_windows(workspace_id,period,"limit") VALUES($1,$2,$3)
       ON CONFLICT(workspace_id,period) DO NOTHING`,
      [workspaceId, period, policy.daily_limit],
    );
    const [row] = await this.db.query<WindowRow>(
      'SELECT "limit",reserved,consumed FROM quota_windows WHERE workspace_id=$1 AND period=$2',
      [workspaceId, period],
    );
    return row;
  }

  private async event(event: Omit<QuotaEvent, 'id' | 'createdAt'>) {
    await this.db.query('INSERT INTO quota_events(workspace_id,body) VALUES($1,$2::jsonb)', [
      event.workspaceId,
      JSON.stringify({ ...event, id: randomUUID(), createdAt: new Date().toISOString() }),
    ]);
  }

  async reserve(taskId: string, workspaceId: string): Promise<QuotaReservation> {
    validId(taskId);
    validId(workspaceId);
    return this.db.transaction(async () => {
      const period = quotaPeriod();
      await this.window(workspaceId, period);
      const timestamp = new Date().toISOString();
      const inserted = await this.db.query<ReservationRow>(
        `INSERT INTO quota_reservations(task_id,workspace_id,period,state,created_at,updated_at)
         VALUES($1,$2,$3,'reserved',$4,$4) ON CONFLICT(task_id) DO NOTHING RETURNING *`,
        [taskId, workspaceId, period, timestamp],
      );
      if (!inserted.length) {
        const [existing] = await this.db.query<ReservationRow>(
          'SELECT * FROM quota_reservations WHERE task_id=$1',
          [taskId],
        );
        if (existing.workspace_id !== workspaceId)
          throw new QuotaError('任务额度记录不属于当前空间', 409, 'QUOTA_CONFLICT');
        return reservation(existing);
      }
      const updated = await this.db.query<WindowRow>(
        `UPDATE quota_windows SET reserved=reserved+1
         WHERE workspace_id=$1 AND period=$2 AND reserved+consumed<"limit" RETURNING *`,
        [workspaceId, period],
      );
      if (!updated.length)
        throw new QuotaError(
          '今日任务额度已用完，请先核对待确认任务或联系管理员',
          429,
          'QUOTA_EXCEEDED',
        );
      await this.event({
        workspaceId,
        period,
        taskId,
        action: 'reserve',
        state: 'reserved',
        reason: '创建任务，预占一次额度',
      });
      return reservation(inserted[0]);
    });
  }

  private async transition(
    row: ReservationRow,
    next: Exclude<QuotaState, 'reserved'>,
    reason: string,
    actorId?: string,
  ): Promise<QuotaReservation> {
    if (row.state === next || row.state === 'consumed' || row.state === 'released')
      return reservation(row);
    if (next !== 'review') {
      const updated = await this.db.query(
        `UPDATE quota_windows SET reserved=reserved-1,consumed=consumed+$3
         WHERE workspace_id=$1 AND period=$2 AND reserved>0 RETURNING workspace_id`,
        [row.workspace_id, row.period, next === 'consumed' ? 1 : 0],
      );
      if (!updated.length)
        throw new QuotaError('额度记录不一致，请检查数据后再核对', 409, 'QUOTA_CONFLICT');
    }
    const [updated] = await this.db.query<ReservationRow>(
      'UPDATE quota_reservations SET state=$2,updated_at=$3 WHERE task_id=$1 RETURNING *',
      [row.task_id, next, new Date().toISOString()],
    );
    await this.event({
      workspaceId: row.workspace_id,
      period: row.period,
      taskId: row.task_id,
      action: next === 'consumed' ? 'consume' : next === 'released' ? 'release' : 'review',
      previousState: row.state,
      state: next,
      reason,
      actorId,
    });
    return reservation(updated);
  }

  async settle(
    task: GenerationTask & { submissionStarted?: boolean; submissionStartedAt?: string },
  ): Promise<QuotaReservation | undefined> {
    return this.db.transaction(async () => {
      const [row] = await this.db.query<ReservationRow>(
        'SELECT * FROM quota_reservations WHERE task_id=$1 FOR UPDATE',
        [task.id],
      );
      if (!row) return undefined;
      if (task.status === 'succeeded')
        return this.transition(row, 'consumed', '生成完成，确认使用一次任务额度');
      if (task.status === 'reconciling')
        return this.transition(row, 'review', '供应商结果尚未确定，保留额度等待核对');
      if (task.status === 'failed' || task.status === 'cancelled') {
        const submitted =
          !!task.upstreamTaskId ||
          !!task.submissionStartedAt ||
          task.submissionStarted === true ||
          (task.submissionStarted === undefined && task.attempts > 0);
        // A held review can only be released by an explicit, audited resolution.
        if (submitted || row.state === 'review')
          return this.transition(row, 'review', '任务已提交或提交状态不确定，保留额度等待核对');
        return this.transition(row, 'released', '供应商请求尚未发起，释放任务额度');
      }
      return reservation(row);
    });
  }

  async summary(workspaceId: string): Promise<QuotaSummary> {
    validId(workspaceId);
    return this.db.transaction(async () => {
      const period = quotaPeriod();
      await this.window(workspaceId, period);
      const [window] = await this.db.query<WindowRow>(
        'SELECT "limit",reserved,consumed FROM quota_windows WHERE workspace_id=$1 AND period=$2 FOR UPDATE',
        [workspaceId, period],
      );
      const records = await this.db.query<ReservationRow>(
        'SELECT * FROM quota_reservations WHERE workspace_id=$1 ORDER BY updated_at DESC,task_id LIMIT 50',
        [workspaceId],
      );
      const events = await this.db.query<{ body: QuotaEvent }>(
        'SELECT body FROM quota_events WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 50',
        [workspaceId],
      );
      const [count] = await this.db.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM quota_reservations WHERE workspace_id=$1 AND state='review'",
        [workspaceId],
      );
      return {
        workspaceId,
        period,
        timeZone: 'Asia/Shanghai',
        unit: 'task',
        ...window,
        available: window.limit - window.reserved - window.consumed,
        reviewCount: Number(count.count),
        records: records.map(reservation),
        events: events.map((row) => row.body),
      };
    });
  }

  async reviewRecords(
    workspaceId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<QuotaReviewPage> {
    validId(workspaceId);
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new QuotaError('每页数量须为 1 至 100 的整数', 400, 'INVALID_QUOTA_INPUT');
    const cursor =
      options.cursor === undefined ? undefined : readReviewCursor(options.cursor, workspaceId);
    return this.db.transaction(async () => {
      if (cursor) {
        // A resolved anchor remains valid, so processing page one does not invalidate page two.
        const anchor = await this.db.query(
          `SELECT task_id FROM quota_reservations
           WHERE task_id=$1 AND workspace_id=$2 AND created_at=$3::timestamptz`,
          [cursor.taskId, workspaceId, cursor.createdAt],
        );
        if (!anchor.length)
          throw new QuotaError('分页游标无效，请刷新待核对列表', 400, 'INVALID_QUOTA_INPUT');
      }
      const rows = await this.db.query<ReservationRow>(
        `SELECT * FROM quota_reservations WHERE workspace_id=$1 AND state='review'
         ${cursor ? 'AND (created_at,task_id)>($3::timestamptz,$4)' : ''}
         ORDER BY created_at,task_id LIMIT $2`,
        cursor
          ? [workspaceId, limit + 1, cursor.createdAt, cursor.taskId]
          : [workspaceId, limit + 1],
      );
      const records = rows.slice(0, limit).map(reservation);
      return {
        records,
        ...(rows.length > limit ? { nextCursor: reviewCursor(records[records.length - 1]) } : {}),
      };
    });
  }

  async setLimit(
    workspaceId: string,
    limit: number,
    reason: string,
    actorId: string,
  ): Promise<QuotaSummary> {
    validId(workspaceId);
    validId(actorId);
    validLimit(limit);
    const note = auditReason(reason);
    return this.db.transaction(async () => {
      const period = quotaPeriod();
      const current = await this.window(workspaceId, period);
      const updated = await this.db.query(
        `UPDATE quota_windows SET "limit"=$3
         WHERE workspace_id=$1 AND period=$2 AND reserved+consumed<=$3 RETURNING workspace_id`,
        [workspaceId, period, limit],
      );
      if (!updated.length)
        throw new QuotaError('额度不能低于今日已使用和预占的总数', 409, 'QUOTA_CONFLICT');
      await this.db.query('UPDATE quota_policies SET daily_limit=$2 WHERE workspace_id=$1', [
        workspaceId,
        limit,
      ]);
      await this.event({
        workspaceId,
        period,
        action: 'set_limit',
        previousLimit: current.limit,
        limit,
        reason: note,
        actorId,
      });
      return this.summary(workspaceId);
    });
  }

  async resolve(
    taskId: string,
    action: 'consume' | 'release',
    reason: string,
    actorId: string,
  ): Promise<QuotaReservation> {
    validId(taskId);
    validId(actorId);
    if (action !== 'consume' && action !== 'release')
      throw new QuotaError('请选择确认使用或释放额度', 400, 'INVALID_QUOTA_INPUT');
    const note = auditReason(reason);
    return this.db.transaction(async () => {
      const [row] = await this.db.query<ReservationRow>(
        'SELECT * FROM quota_reservations WHERE task_id=$1 FOR UPDATE',
        [taskId],
      );
      if (!row) throw new QuotaError('任务额度记录不存在', 404, 'QUOTA_NOT_FOUND');
      const next = action === 'consume' ? 'consumed' : 'released';
      if (row.state === next) return reservation(row);
      if (row.state !== 'review')
        throw new QuotaError(
          '仅待核对的任务额度可人工确认，请先停止任务查询',
          409,
          'QUOTA_NOT_REVIEWABLE',
        );
      return this.transition(row, next, note, actorId);
    });
  }
}
