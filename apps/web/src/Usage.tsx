import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartNoAxesCombined, CircleCheck, Clock3, Info, RefreshCw, Settings2 } from 'lucide-react';
import { api, ApiError, json, message, type SessionInfo } from './api';
import { AlertDialogCancel } from './components/ui/alert-dialog';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Textarea } from './components/ui/textarea';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';
import { ConfirmModal, ErrorBox, Spinner, type Notify } from './ui';

type QuotaState = 'reserved' | 'consumed' | 'released' | 'review';
type QuotaRecord = {
  taskId: string;
  workspaceId: string;
  period: string;
  state: QuotaState;
  createdAt: string;
  updatedAt: string;
};
type QuotaEvent = {
  id: string;
  period: string;
  taskId?: string;
  action: 'reserve' | 'consume' | 'release' | 'review' | 'set_limit';
  previousLimit?: number;
  limit?: number;
  reason: string;
  createdAt: string;
};
type QuotaSummary = {
  workspaceId: string;
  period: string;
  timeZone: 'Asia/Shanghai';
  unit: 'task';
  limit: number;
  reserved: number;
  consumed: number;
  available: number;
  reviewCount: number;
  records: QuotaRecord[];
  events: QuotaEvent[];
};
type Workspace = { id: string; name: string; email?: string };
type ReviewPage = { records: QuotaRecord[]; nextCursor?: string };
type QuotaEdit = { kind: 'limit' } | { kind: 'resolve'; record: QuotaRecord };

const stateNames: Record<QuotaState, string> = {
  reserved: '已预占',
  consumed: '已消耗',
  released: '已释放',
  review: '待核对',
};
const eventNames: Record<QuotaEvent['action'], string> = {
  reserve: '预占额度',
  consume: '确认消耗',
  release: '释放额度',
  review: '转为待核对',
  set_limit: '调整每日额度',
};
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function TaskId({ id }: { id: string }) {
  return <code className="usage-task-id">{id}</code>;
}

export function Usage({ session, notify }: { session: SessionInfo; notify: Notify }) {
  const canManage = session.mode !== 'accounts' || session.user?.role === 'admin';
  const ownWorkspaceId = session.user?.workspace.id || 'local';
  const [workspaceId, setWorkspaceId] = useState(ownWorkspaceId);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceError, setWorkspaceError] = useState('');
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [summary, setSummary] = useState<QuotaSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviews, setReviews] = useState<QuotaRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [edit, setEdit] = useState<QuotaEdit>();
  const [limit, setLimit] = useState('');
  const [action, setAction] = useState<'' | 'consume' | 'release'>('');
  const [reason, setReason] = useState('');
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const summaryRequest = useRef<AbortController | null>(null);
  const reviewRequest = useRef<AbortController | null>(null);
  const workspaceRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);

  const loadSummary = useCallback(() => {
    summaryRequest.current?.abort();
    const controller = new AbortController();
    summaryRequest.current = controller;
    setLoading(true);
    setError('');
    const request =
      workspaceId === ownWorkspaceId
        ? api<{ quota: QuotaSummary }>('/usage', { signal: controller.signal }).then(
            (result) => result.quota,
          )
        : api<QuotaSummary>(`/admin/quotas/${encodeURIComponent(workspaceId)}`, {
            signal: controller.signal,
          });
    void request
      .then((result) => {
        if (!controller.signal.aborted) setSummary(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [workspaceId, ownWorkspaceId]);

  const loadWorkspaces = useCallback(() => {
    if (!canManage) return;
    workspaceRequest.current?.abort();
    const controller = new AbortController();
    workspaceRequest.current = controller;
    setWorkspaceLoading(true);
    setWorkspaceError('');
    void api<Workspace[]>('/admin/quota-workspaces', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setWorkspaces(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setWorkspaceError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      });
  }, [canManage]);

  const loadReviews = useCallback(
    (cursor?: string) => {
      if (!canManage) return;
      reviewRequest.current?.abort();
      const controller = new AbortController();
      reviewRequest.current = controller;
      setReviewLoading(true);
      setReviewError('');
      const params = new URLSearchParams({ limit: '25' });
      if (cursor) params.set('cursor', cursor);
      void api<ReviewPage>(`/admin/quotas/${encodeURIComponent(workspaceId)}/reviews?${params}`, {
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          setReviews((current) => {
            if (!cursor) return result.records;
            const updated = new Map(current.map((record) => [record.taskId, record]));
            result.records.forEach((record) => updated.set(record.taskId, record));
            return [...updated.values()];
          });
          setNextCursor(result.nextCursor);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setReviewError(message(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setReviewLoading(false);
        });
    },
    [canManage, workspaceId],
  );

  useEffect(() => {
    loadWorkspaces();
    return () => workspaceRequest.current?.abort();
  }, [loadWorkspaces]);
  useEffect(() => {
    setSummary(undefined);
    setReviews([]);
    setNextCursor(undefined);
    loadSummary();
    loadReviews();
    return () => {
      summaryRequest.current?.abort();
      reviewRequest.current?.abort();
    };
  }, [loadSummary, loadReviews]);
  useEffect(() => () => mutationRequest.current?.abort(), []);

  function refresh() {
    loadSummary();
    loadReviews();
    loadWorkspaces();
  }
  function openEdit(next: QuotaEdit) {
    setEdit(next);
    setLimit(String(summary?.limit ?? ''));
    setAction('');
    setReason('');
    setEditError('');
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !edit || !summary || !canManage) return;
    const note = reason.trim();
    if (!note || note.length > 500 || /\p{Cc}/u.test(note)) {
      setEditError('请填写 1–500 字原因，使用一段文字，不包含换行或控制字符。');
      return;
    }
    if (edit.kind === 'limit' && (!/^\d+$/.test(limit) || Number(limit) > 1_000_000)) {
      setEditError('每日任务额度须为 0–1,000,000 的整数。');
      return;
    }
    if (edit.kind === 'limit' && Number(limit) < summary.consumed + summary.reserved) {
      setEditError(
        `每日额度不能低于今天已消耗与已预占之和（${summary.consumed + summary.reserved}）。`,
      );
      return;
    }
    if (edit.kind === 'resolve' && !action) {
      setEditError('请根据服务商记录选择确认消耗或释放额度。');
      return;
    }
    const controller = new AbortController();
    mutationRequest.current = controller;
    setSaving(true);
    setEditError('');
    const path = `/admin/quotas/${encodeURIComponent(workspaceId)}`;
    const request =
      edit.kind === 'limit'
        ? json('PATCH', { limit: Number(limit), reason: note })
        : json('POST', { taskId: edit.record.taskId, action, reason: note });
    try {
      const updated = await api<QuotaSummary>(edit.kind === 'limit' ? path : `${path}/resolve`, {
        ...request,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      // A previous refresh must not overwrite the newly confirmed quota balance.
      summaryRequest.current?.abort();
      setLoading(false);
      setError('');
      setSummary(updated);
      if (edit.kind === 'resolve')
        setReviews((current) => current.filter((record) => record.taskId !== edit.record.taskId));
      setEdit(undefined);
      loadReviews();
      notify(edit.kind === 'limit' ? '每日任务额度已更新' : '额度核对已记录');
    } catch (e) {
      if (controller.signal.aborted) return;
      const detail = message(e);
      setEditError(
        e instanceof ApiError && e.status === 409 && edit.kind === 'resolve'
          ? `${detail}。任务仍在排队、运行或恢复查询时，请由创作者在对应项目中停止任务，等待处理结束，再刷新核对。`
          : `${detail}。如请求中断，请关闭面板并刷新记录，确认是否已生效后再操作。`,
      );
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  const workspaceName =
    workspaces.find((workspace) => workspace.id === workspaceId)?.name ||
    session.user?.workspace.name ||
    '本地工作空间';
  const busy = loading || workspaceLoading || reviewLoading || saving;

  return (
    <div className="page-container usage-page">
      <header className="page-topbar">
        <div className="breadcrumbs">
          工作空间<span>/</span>用量与额度
        </div>
        <span className="workspace-status">
          <ChartNoAxesCombined size={16} />
          任务额度
        </span>
      </header>
      <section className="page-heading">
        <div>
          <p className="eyebrow">ROOM FOR YOUR NEXT IDEA</p>
          <h1>每一次创作，心中有数</h1>
          <p className="muted">查看任务用量与可用额度，为下一次灵感留好空间。</p>
        </div>
        <Button className="button secondary" disabled={busy} onClick={refresh}>
          <RefreshCw size={17} />
          刷新用量
        </Button>
      </section>

      {canManage && (
        <div className="usage-workspace-control">
          <div className="usage-field">
            <Label htmlFor="usage-workspace">管理工作空间</Label>
            <select
              id="usage-workspace"
              value={workspaceId}
              disabled={busy || !!edit || !!workspaceError || !workspaces.length}
              onChange={(event) => {
                setSummary(undefined);
                setReviews([]);
                setNextCursor(undefined);
                setLoading(true);
                setWorkspaceId(event.target.value);
              }}
            >
              {!workspaces.some((workspace) => workspace.id === ownWorkspaceId) && (
                <option value={ownWorkspaceId}>
                  {session.user?.workspace.name || '本地工作空间'}
                </option>
              )}
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                  {workspace.email ? ` · ${workspace.email}` : ''}
                </option>
              ))}
            </select>
          </div>
          <p>按工作空间独立计数，每日 00:00（北京时间）开始新的额度周期。</p>
          {workspaceError && <ErrorBox>空间列表读取失败：{workspaceError}。可刷新重试。</ErrorBox>}
        </div>
      )}

      {loading ? (
        <Card className="usage-empty">
          <Spinner label="正在读取任务额度" />
        </Card>
      ) : error ? (
        <Card className="usage-empty">
          <ErrorBox>{error}</ErrorBox>
          <Button className="button secondary" onClick={refresh}>
            重新读取
          </Button>
        </Card>
      ) : summary ? (
        <>
          <Card className="usage-overview">
            <div className="usage-overview-heading">
              <div>
                <h2>{workspaceName}</h2>
                <p>{summary.period} · 北京时间（UTC+8）</p>
              </div>
              {canManage && (
                <Button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => openEdit({ kind: 'limit' })}
                >
                  <Settings2 size={16} />
                  调整额度
                </Button>
              )}
            </div>
            <dl className="usage-metrics">
              <div className="usage-metric-primary">
                <dt>今日可用</dt>
                <dd>
                  {summary.available.toLocaleString('zh-CN')}
                  <span>次</span>
                </dd>
              </div>
              <div>
                <dt>已消耗</dt>
                <dd>
                  {summary.consumed.toLocaleString('zh-CN')}
                  <span>次</span>
                </dd>
              </div>
              <div>
                <dt>已预占</dt>
                <dd>
                  {summary.reserved.toLocaleString('zh-CN')}
                  <span>次</span>
                </dd>
              </div>
              <div>
                <dt>每日上限</dt>
                <dd>
                  {summary.limit.toLocaleString('zh-CN')}
                  <span>次</span>
                </dd>
              </div>
            </dl>
            <meter
              className="usage-meter"
              aria-label="今日已消耗与预占额度"
              min={0}
              max={Math.max(1, summary.limit)}
              value={summary.consumed + summary.reserved}
              aria-valuetext={
                summary.limit === 0
                  ? '每日额度为 0，暂停新建生成任务'
                  : `上限 ${summary.limit} 次，已消耗 ${summary.consumed} 次，预占 ${summary.reserved} 次`
              }
            >
              {summary.consumed + summary.reserved} / {summary.limit}
            </meter>
            <p className="usage-overview-note">
              预占额度包含今天创建的待核对任务。
              {summary.limit === 0
                ? '当前已暂停新建生成任务。'
                : summary.available === 0
                  ? '今日可用额度已用完，可联系管理员或等待下一周期。'
                  : '任务确认完成后计入消耗，确认未执行时可释放预占。'}
            </p>
          </Card>

          <div className="usage-billing-note">
            <Info size={19} />
            <p>
              这里统计的是<strong>任务额度</strong>，每个生成任务占用 1
              次。当前未记录可核验的服务商费用，请以服务商账单为准；释放额度不会取消远程任务，也不代表实际退款。
            </p>
          </div>

          <Card className="usage-panel">
            <div className="usage-panel-heading">
              <div>
                <h2>
                  待核对任务
                  <Badge variant="outline" className="usage-review-count">
                    {summary.reviewCount}
                  </Badge>
                </h2>
                <p>包含历史日期的未确认任务，核对结果记入任务原来的额度周期。</p>
              </div>
              {canManage && (
                <Button className="button secondary" disabled={busy} onClick={() => loadReviews()}>
                  <RefreshCw size={16} />
                  刷新待核对
                </Button>
              )}
            </div>
            {canManage ? (
              <>
                {reviewError && (
                  <div className="usage-panel-message">
                    <ErrorBox>{reviewError}</ErrorBox>
                  </div>
                )}
                {reviewLoading && !reviews.length ? (
                  <div className="usage-empty">
                    <Spinner label="正在读取待核对任务" />
                  </div>
                ) : !reviews.length ? (
                  <div className="usage-empty">
                    <CircleCheck size={28} />
                    <h3>{reviewError ? '暂时无法读取核对列表' : '当前没有待核对任务'}</h3>
                    <p>
                      {reviewError
                        ? '刷新后重试，任务额度记录会继续保留。'
                        : '发生超时或执行状态不确定时，任务会出现在这里。'}
                    </p>
                  </div>
                ) : (
                  <Table className="usage-table">
                    <TableCaption className="sr-only">
                      跨日期待核对任务，全部时间为北京时间
                    </TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>任务编号</TableHead>
                        <TableHead>额度日期</TableHead>
                        <TableHead>最后更新</TableHead>
                        <TableHead className="usage-action-cell">处理</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reviews.map((record) => (
                        <TableRow key={record.taskId}>
                          <TableCell>
                            <TaskId id={record.taskId} />
                          </TableCell>
                          <TableCell>{record.period}</TableCell>
                          <TableCell>
                            <time dateTime={record.updatedAt}>
                              {dateFormatter.format(new Date(record.updatedAt))}
                            </time>
                          </TableCell>
                          <TableCell className="usage-action-cell">
                            <Button
                              className="button secondary"
                              disabled={busy}
                              aria-label={`核对任务 ${record.taskId}`}
                              onClick={() => openEdit({ kind: 'resolve', record })}
                            >
                              核对额度
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                {(nextCursor || reviews.length > 0) && (
                  <div className="usage-list-footer">
                    <span>
                      已载入 {reviews.length} 条{nextCursor ? '，还有更多待核对记录' : '待核对记录'}
                    </span>
                    {nextCursor && (
                      <Button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => loadReviews(nextCursor)}
                      >
                        {reviewLoading ? <Spinner label="正在读取" /> : '加载更多'}
                      </Button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="usage-member-review">
                <Clock3 size={20} />
                <p>
                  {summary.reviewCount > 0
                    ? `有 ${summary.reviewCount} 个任务需要核对。请将任务编号交给管理员，并提供服务商的执行或账单记录。`
                    : '当前没有待核对任务。执行结果不确定时，可联系管理员核对额度。'}
                </p>
              </div>
            )}
          </Card>

          <Card className="usage-panel">
            <div className="usage-panel-heading">
              <div>
                <h2>最近任务额度</h2>
                <p>最近 50 条额度记录，包含历史日期；任务内容请在对应项目中查看。</p>
              </div>
            </div>
            {!summary.records.length ? (
              <div className="usage-empty">
                <ChartNoAxesCombined size={28} />
                <h3>还没有任务额度记录</h3>
                <p>创建 AI 生成任务后，可以在这里查看预占和消耗情况。</p>
              </div>
            ) : (
              <Table className="usage-table">
                <TableCaption className="sr-only">最近任务额度状态</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>任务编号</TableHead>
                    <TableHead>额度日期</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>最后更新</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.records.map((record) => (
                    <TableRow key={record.taskId}>
                      <TableCell>
                        <TaskId id={record.taskId} />
                      </TableCell>
                      <TableCell>{record.period}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`usage-state usage-state-${record.state}`}
                        >
                          {stateNames[record.state]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <time dateTime={record.updatedAt}>
                          {dateFormatter.format(new Date(record.updatedAt))}
                        </time>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card className="usage-panel">
            <div className="usage-panel-heading">
              <div>
                <h2>额度变更记录</h2>
                <p>保留最近 50 条预占、核对与额度调整记录。</p>
              </div>
            </div>
            {!summary.events.length ? (
              <div className="usage-empty">
                <h3>还没有额度变更</h3>
                <p>生成任务和管理操作产生的变更会显示在这里。</p>
              </div>
            ) : (
              <ol className="usage-events">
                {summary.events.map((event) => (
                  <li key={event.id}>
                    <span className="usage-event-dot" aria-hidden="true" />
                    <div>
                      <div className="usage-event-title">
                        <strong>{eventNames[event.action]}</strong>
                        <time dateTime={event.createdAt}>
                          {dateFormatter.format(new Date(event.createdAt))}
                        </time>
                      </div>
                      {event.action === 'set_limit' && (
                        <p className="usage-event-limit">
                          {event.previousLimit} 次 → {event.limit} 次 / 日
                        </p>
                      )}
                      <p className="usage-event-reason">{event.reason}</p>
                      <div className="usage-event-meta">
                        <span>额度日期 {event.period}</span>
                        {event.taskId && <TaskId id={event.taskId} />}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      ) : (
        <Card className="usage-empty">
          <ErrorBox>当前服务尚未提供额度信息，请确认 API 已更新后刷新。</ErrorBox>
        </Card>
      )}

      {edit && summary && (
        <ConfirmModal
          title={edit.kind === 'limit' ? '调整每日任务额度' : '确认任务额度的核对结果'}
          description={
            edit.kind === 'limit'
              ? `正在修改「${workspaceName}」的每日额度，新上限同时适用于今天和后续日期。`
              : '请先检查服务商执行结果或账单，再选择处理方式。此操作只变更任务额度。'
          }
          onClose={() => {
            if (!saving) setEdit(undefined);
          }}
        >
          <form className="usage-edit-form" onSubmit={save}>
            {edit.kind === 'limit' ? (
              <div className="usage-field">
                <Label htmlFor="usage-limit">每日任务上限</Label>
                <Input
                  id="usage-limit"
                  type="number"
                  inputMode="numeric"
                  min={summary.consumed + summary.reserved}
                  max={1_000_000}
                  step={1}
                  required
                  disabled={saving}
                  value={limit}
                  aria-describedby="usage-limit-hint"
                  onChange={(event) => setLimit(event.target.value)}
                />
                <p id="usage-limit-hint">
                  今天已消耗与预占合计 {summary.consumed + summary.reserved}{' '}
                  次，新上限不能小于此值。设为 0 将暂停新建生成任务。
                </p>
              </div>
            ) : (
              <>
                <div className="usage-review-task">
                  <Label>任务编号</Label>
                  <TaskId id={edit.record.taskId} />
                  <p>额度日期 {edit.record.period}。核对历史日期的任务，不会补充今天的可用额度。</p>
                </div>
                <fieldset className="usage-resolution-options" disabled={saving}>
                  <legend>核对结果（必选）</legend>
                  <label>
                    <input
                      type="radio"
                      name="resolution"
                      value="consume"
                      required
                      checked={action === 'consume'}
                      onChange={() => setAction('consume')}
                    />
                    <span>
                      <strong>确认消耗 1 次额度</strong>
                      <span>服务商已执行任务，将预占转为已消耗。</span>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="resolution"
                      value="release"
                      required
                      checked={action === 'release'}
                      onChange={() => setAction('release')}
                    />
                    <span>
                      <strong>释放 1 次额度</strong>
                      <span>已核实可退回此任务的预占；不代表服务商退款。</span>
                    </span>
                  </label>
                </fieldset>
              </>
            )}
            <div className="usage-field">
              <Label htmlFor="usage-reason">
                {edit.kind === 'limit' ? '修改原因' : '核对依据'}（必填）
              </Label>
              <Textarea
                id="usage-reason"
                required
                minLength={1}
                maxLength={500}
                rows={3}
                disabled={saving}
                value={reason}
                aria-describedby="usage-reason-hint"
                placeholder={
                  edit.kind === 'limit'
                    ? '例如：本周活动素材需求增加，调整每日额度'
                    : '例如：已在服务商控制台核实该任务未开始执行'
                }
                onChange={(event) => setReason(event.target.value)}
              />
              <p id="usage-reason-hint">
                1–500 字，填写一段说明。操作与原因将保存到额度变更记录中。
              </p>
            </div>
            {editError && <ErrorBox>{editError}</ErrorBox>}
            <div className="usage-form-actions">
              <AlertDialogCancel type="button" className="button secondary" disabled={saving}>
                取消
              </AlertDialogCancel>
              <Button
                type="submit"
                className="button primary"
                disabled={saving || !reason.trim() || (edit.kind === 'resolve' && !action)}
              >
                {saving ? (
                  <Spinner label="正在保存" />
                ) : edit.kind === 'limit' ? (
                  '确认调整额度'
                ) : action === 'release' ? (
                  '确认释放额度'
                ) : (
                  '确认核对结果'
                )}
              </Button>
            </div>
          </form>
        </ConfirmModal>
      )}
    </div>
  );
}
