import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerationTask } from '../../../packages/shared/src/index';
import { openDatabase } from '../src/db';
import { QuotaService, quotaPeriod } from '../src/quotas';

function task(
  id: string,
  status: GenerationTask['status'],
  extra: Partial<GenerationTask> & {
    submissionStarted?: boolean;
    submissionStartedAt?: string;
  } = {},
): GenerationTask & { submissionStarted?: boolean; submissionStartedAt?: string } {
  return {
    id,
    projectId: 'project',
    providerId: 'provider',
    kind: 'copy',
    prompt: '已确认的商品事实',
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
    ...extra,
  };
}

async function fixture(limit = 3) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-quotas-'));
  const db = await openDatabase(dir);
  const quotas = new QuotaService(db, limit);
  await quotas.initialize();
  return {
    db,
    quotas,
    dir,
    async close() {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('quota periods follow Shanghai midnight independently of host timezone', () => {
  assert.equal(quotaPeriod(new Date('2026-09-30T15:59:59.999Z')), '2026-09-30');
  assert.equal(quotaPeriod(new Date('2026-09-30T16:00:00.000Z')), '2026-10-01');
  assert.equal(quotaPeriod(new Date('2026-12-31T16:00:00.000Z')), '2027-01-01');
});

test('concurrent reservations cannot exceed the persisted workspace limit', async () => {
  const f = await fixture(3);
  try {
    const otherService = new QuotaService(f.db, 999);
    const first = await f.quotas.summary('bounded');
    assert.equal(first.limit, 3);
    const bounded = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? f.quotas : otherService).reserve(`bounded-${i}`, 'bounded'),
      ),
    );
    assert.equal(bounded.filter((r) => r.status === 'fulfilled').length, 3);
    for (const result of bounded) {
      if (result.status === 'rejected') {
        assert.equal(result.reason.code, 'QUOTA_EXCEEDED');
        assert.equal(result.reason.statusCode, 429);
      }
    }
    const last = await otherService.summary('bounded');
    assert.equal(last.limit, 3);
    assert.equal(last.reserved, 3);
    assert.equal(last.consumed, 0);
    assert.equal(last.available, 0);
    assert.equal(last.records.length, 3);
    // 3 次 reserve + 一次 100% 用量告警（80% 与 100% 同次越过只记一次）。
    assert.equal(last.events.length, 4);
    assert.equal(last.events.filter((e) => e.action === 'reserve').length, 3);
    assert.equal(last.events.filter((e) => e.action === 'notice').length, 1);
    assert.equal((await f.db.query('SELECT task_id FROM quota_reservations')).length, 3);
  } finally {
    await f.close();
  }
});

test('duplicate task reservations are idempotent across instances and cannot cross namespaces', async () => {
  const f = await fixture(1);
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => f.quotas.reserve('one-task', 'first-space')),
    );
    assert.ok(outcomes.every((r) => r.state === 'reserved'));
    let summary = await f.quotas.summary('first-space');
    assert.equal(summary.reserved, 1);
    // 1 次 reserve + 一次 100% 用量告警（限额 1 时首次预占即用满）。
    assert.equal(summary.events.length, 2);
    assert.equal(summary.events.filter((e) => e.action === 'notice').length, 1);
    await assert.rejects(f.quotas.reserve('one-task', 'second-space'), {
      code: 'QUOTA_CONFLICT',
      statusCode: 409,
    });
    const second = await f.quotas.summary('second-space');
    assert.equal(second.available, 1);
    assert.deepEqual(second.records, []);
    assert.deepEqual(second.events, []);
    await f.quotas.settle(task('one-task', 'succeeded'));
    const duplicate = await new QuotaService(f.db, 20).reserve('one-task', 'first-space');
    assert.equal(duplicate.state, 'consumed');
    summary = await f.quotas.summary('first-space');
    assert.equal(summary.reserved, 0);
    assert.equal(summary.consumed, 1);
    // reserve + 100% 告警 + consume。
    assert.equal(summary.events.length, 3);
    assert.equal(summary.events.filter((e) => e.action === 'consume').length, 1);
  } finally {
    await f.close();
  }
});

test('task creation and reservation share one rollback boundary', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.db.transaction(async () => {
        await f.quotas.reserve('rollback', 'space');
        await f.db.put('tasks', 'rollback', task('rollback', 'queued'));
        throw new Error('task creation failed');
      }),
      /task creation failed/,
    );
    assert.equal(await f.db.get('tasks', 'rollback'), undefined);
    let summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 0);
    assert.equal(summary.available, 3);
    assert.deepEqual(summary.records, []);
    assert.deepEqual(summary.events, []);
    await f.db.transaction(async () => {
      await f.quotas.reserve('committed', 'space');
      await f.db.put('tasks', 'committed', task('committed', 'queued'));
    });
    assert.ok(await f.db.get('tasks', 'committed'));
    summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 1);
  } finally {
    await f.close();
  }
});

test('success consumes exactly once and verified pre-submission failure or cancellation releases', async () => {
  const f = await fixture();
  try {
    for (const id of ['success', 'preflight', 'queued-cancel']) await f.quotas.reserve(id, 'space');
    const queued = await f.quotas.settle(task('success', 'queued'));
    assert.equal(queued?.state, 'reserved');
    const running = await f.quotas.settle(task('success', 'running', { attempts: 1 }));
    assert.equal(running?.state, 'reserved');
    await Promise.all(
      Array.from({ length: 5 }, () => f.quotas.settle(task('success', 'succeeded'))),
    );
    await f.quotas.settle(task('preflight', 'failed', { attempts: 1, submissionStarted: false }));
    await f.quotas.settle(task('queued-cancel', 'cancelled'));
    const summary = await f.quotas.summary('space');
    assert.equal(summary.consumed, 1);
    assert.equal(summary.reserved, 0);
    assert.equal(summary.available, 2);
    assert.equal(summary.reviewCount, 0);
    assert.equal(summary.events.filter((e) => e.action === 'consume').length, 1);
    assert.equal(summary.events.filter((e) => e.action === 'release').length, 2);
    assert.equal(await f.quotas.settle(task('legacy-no-reservation', 'succeeded')), undefined);
  } finally {
    await f.close();
  }
});

test('uncertain or attempted supplier requests retain their reservation until audited resolution', async () => {
  const f = await fixture(6);
  try {
    const inputs = [
      task('legacy-attempt', 'failed', { attempts: 1 }),
      task('explicit-submit', 'cancelled', { submissionStarted: true }),
      task('submission-time', 'failed', { submissionStartedAt: new Date().toISOString() }),
      task('upstream-id', 'cancelled', {
        submissionStarted: false,
        upstreamTaskId: 'supplier-job',
      }),
      task('reconciling', 'reconciling'),
    ];
    for (const input of inputs) {
      await f.quotas.reserve(input.id, 'space');
      assert.equal((await f.quotas.settle(input))?.state, 'review');
    }
    await f.quotas.settle(task('explicit-submit', 'failed', { submissionStarted: false }));
    let summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 5);
    assert.equal(summary.reviewCount, 5);
    assert.equal(summary.available, 1);
    assert.equal(summary.events.filter((e) => e.action === 'review').length, 5);
    await f.quotas.settle(task('reconciling', 'succeeded'));
    summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 4);
    assert.equal(summary.consumed, 1);
    assert.equal(summary.reviewCount, 4);
    await f.quotas.resolve(
      'legacy-attempt',
      'release',
      '已在供应商控制台核对未执行，恢复平台任务额度',
      'operator',
    );
    await f.quotas.resolve(
      'explicit-submit',
      'consume',
      '已在供应商控制台确认任务执行',
      'operator',
    );
    const duplicate = await f.quotas.resolve(
      'explicit-submit',
      'consume',
      '重复提交的同一确认',
      'operator',
    );
    assert.equal(duplicate.state, 'consumed');
    await assert.rejects(f.quotas.resolve('explicit-submit', 'release', '相反决定', 'operator'), {
      code: 'QUOTA_NOT_REVIEWABLE',
    });
    summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 2);
    assert.equal(summary.consumed, 2);
    assert.equal(summary.available, 2);
    assert.equal(summary.reviewCount, 2);
    const manual = summary.events.filter((e) => e.actorId === 'operator');
    assert.equal(manual.length, 2);
    assert.ok(
      manual.every((e) => e.previousState === 'review' && e.reason.includes('供应商控制台')),
    );
    // A late stale worker callback cannot undo the recorded manual resolution.
    await f.quotas.settle(task('legacy-attempt', 'succeeded'));
    assert.equal((await f.quotas.summary('space')).consumed, 2);
  } finally {
    await f.close();
  }
});

test('competing manual resolutions are serialized and reserved active tasks cannot be resolved', async () => {
  const f = await fixture();
  try {
    await f.quotas.reserve('active', 'space');
    await assert.rejects(f.quotas.resolve('active', 'release', '仍在运行', 'operator'), {
      code: 'QUOTA_NOT_REVIEWABLE',
      statusCode: 409,
    });
    await assert.rejects(f.quotas.resolve('missing', 'release', '供应商核对完成', 'operator'), {
      code: 'QUOTA_NOT_FOUND',
    });
    await f.quotas.settle(task('active', 'reconciling'));
    const choices = await Promise.allSettled([
      f.quotas.resolve('active', 'consume', '确认已执行', 'operator-a'),
      f.quotas.resolve('active', 'release', '确认未执行', 'operator-b'),
    ]);
    assert.equal(choices.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(choices.filter((r) => r.status === 'rejected').length, 1);
    const summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 0);
    assert.equal(summary.reviewCount, 0);
    assert.equal(summary.events.filter((e) => e.actorId?.startsWith('operator')).length, 1);
  } finally {
    await f.close();
  }
});

test('invalid inputs and limits below current consumption leave counters and audit history intact', async () => {
  const f = await fixture();
  try {
    for (const limit of [-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001]) {
      assert.throws(() => new QuotaService(f.db, limit), { code: 'INVALID_QUOTA_INPUT' });
      await assert.rejects(f.quotas.setLimit('space', limit, '计划调整', 'admin'), {
        code: 'INVALID_QUOTA_INPUT',
      });
    }
    for (const reason of ['', '  ', 'a'.repeat(501), '原\u0000因']) {
      await assert.rejects(f.quotas.setLimit('space', 10, reason, 'admin'), {
        code: 'INVALID_QUOTA_INPUT',
      });
      await assert.rejects(f.quotas.resolve('task', 'release', reason, 'admin'), {
        code: 'INVALID_QUOTA_INPUT',
      });
    }
    await assert.rejects(f.quotas.reserve('', 'space'), { code: 'INVALID_QUOTA_INPUT' });
    await assert.rejects(f.quotas.summary(''), { code: 'INVALID_QUOTA_INPUT' });
    await f.quotas.reserve('used', 'space');
    await f.quotas.settle(task('used', 'succeeded'));
    await f.quotas.reserve('pending', 'space');
    await assert.rejects(f.quotas.setLimit('space', 1, '计划调整', 'admin'), {
      code: 'QUOTA_CONFLICT',
    });
    let summary = await f.quotas.summary('space');
    assert.equal(summary.limit, 3);
    assert.equal(summary.events.filter((e) => e.action === 'set_limit').length, 0);
    summary = await f.quotas.setLimit('space', 2, '内测额度设置', 'admin');
    assert.equal(summary.limit, 2);
    assert.equal(summary.available, 0);
    assert.equal(summary.events[0].actorId, 'admin');
    assert.equal(summary.events[0].previousLimit, 3);
    const disabled = await f.quotas.setLimit('zero-space', 0, '暂停新增生成任务', 'admin');
    assert.equal(disabled.available, 0);
    await assert.rejects(f.quotas.reserve('zero', 'zero-space'), { code: 'QUOTA_EXCEEDED' });
  } finally {
    await f.close();
  }
});

test('settlements use the original day and new windows inherit the saved policy', async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T15:59:59.999Z') });
    await f.quotas.setLimit('space', 2, '每日两次', 'admin');
    const first = await f.quotas.reserve('cross-day', 'space');
    await f.quotas.reserve('old-review', 'space');
    await f.quotas.settle(task('old-review', 'reconciling'));
    assert.equal(first.period, '2026-09-30');
    t.mock.timers.setTime(new Date('2026-09-30T16:00:00.000Z').getTime());
    let summary = await f.quotas.summary('space');
    assert.equal(summary.period, '2026-10-01');
    assert.equal(summary.limit, 2);
    assert.equal(summary.available, 2);
    assert.equal(summary.reviewCount, 1);
    const repeat = await f.quotas.reserve('cross-day', 'space');
    assert.equal(repeat.period, first.period);
    assert.equal((await f.quotas.summary('space')).reserved, 0);
    await f.quotas.settle(task('cross-day', 'succeeded'));
    await f.quotas.reserve('today', 'space');
    await f.quotas.resolve('old-review', 'release', '已核对旧任务没有执行', 'admin');
    summary = await f.quotas.summary('space');
    assert.equal(summary.reserved, 1);
    assert.equal(summary.consumed, 0);
    assert.equal(summary.available, 1);
    assert.equal(summary.reviewCount, 0);
    const [oldWindow] = await f.db.query<{ reserved: number; consumed: number; limit: number }>(
      'SELECT reserved,consumed,"limit" FROM quota_windows WHERE workspace_id=$1 AND period=$2',
      ['space', '2026-09-30'],
    );
    assert.deepEqual(oldWindow, { reserved: 0, consumed: 1, limit: 2 });
    assert.equal(
      summary.events.find((e) => e.taskId === 'old-review' && e.action === 'release')?.period,
      '2026-09-30',
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('a failed audit write rolls back the reservation and counter settlement together', async () => {
  const f = await fixture();
  try {
    await f.quotas.reserve('audit-failure', 'space');
    await f.db.query(
      "ALTER TABLE quota_events ADD CONSTRAINT simulated_audit_failure CHECK (body->>'action' <> 'consume')",
    );
    await assert.rejects(f.quotas.settle(task('audit-failure', 'succeeded')));
    const summary = await f.quotas.summary('space');
    assert.equal(summary.consumed, 0);
    assert.equal(summary.reserved, 1);
    assert.equal(summary.records[0].state, 'reserved');
    assert.equal(summary.events.length, 1);
  } finally {
    await f.close();
  }
});

test('summary data stays inside its workspace and recent histories are bounded', async () => {
  const f = await fixture(60);
  try {
    await f.quotas.reserve('other-private-task', 'private-space');
    await f.quotas.settle(task('other-private-task', 'reconciling'));
    await f.db.transaction(async () => {
      for (let i = 0; i < 52; i++) await f.quotas.reserve(`item-${i}`, 'public-space');
    });
    const summary = await f.quotas.summary('public-space');
    assert.equal(summary.records.length, 50);
    assert.equal(summary.events.length, 50);
    assert.equal(summary.reviewCount, 0);
    assert.equal(summary.reserved, 52);
    assert.ok(summary.records.every((r) => r.workspaceId === 'public-space'));
    assert.ok(summary.events.every((e) => e.workspaceId === 'public-space'));
    assert.equal(JSON.stringify(summary).includes('other-private-task'), false);
    const privateSummary = await f.quotas.summary('private-space');
    assert.equal(privateSummary.records.length, 1);
    assert.equal(privateSummary.events.length, 2);
    assert.equal(privateSummary.reviewCount, 1);
  } finally {
    await f.close();
  }
});

test('review pages include old records beyond the recent summary and keep a stable tie order', async (t) => {
  const f = await fixture(150);
  try {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T10:00:00.000Z') });
    await f.db.transaction(async () => {
      for (let i = 62; i >= 0; i--) {
        const id = `review-${String(i).padStart(3, '0')}`;
        await f.quotas.reserve(id, 'space');
        await f.quotas.settle(task(id, 'reconciling'));
      }
      t.mock.timers.setTime(new Date('2026-09-30T11:00:00.000Z').getTime());
      for (let i = 0; i < 55; i++) {
        const id = `recent-${i}`;
        await f.quotas.reserve(id, 'space');
        await f.quotas.settle(task(id, 'succeeded'));
      }
    });
    const summary = await f.quotas.summary('space');
    assert.equal(summary.reviewCount, 63);
    assert.ok(summary.records.every((r) => r.state === 'consumed'));
    const all = await f.quotas.reviewRecords('space', { limit: 100 });
    assert.equal(all.records.length, 63);
    assert.equal(all.nextCursor, undefined);
    const first = await f.quotas.reviewRecords('space');
    assert.equal(first.records.length, 25);
    assert.ok(first.nextCursor);
    // Completing the anchor from the first page must not skip or reject later pages.
    for (const record of first.records)
      await f.quotas.resolve(record.taskId, 'consume', '已核对供应商执行结果', 'admin');
    const ids = first.records.map((r) => r.taskId);
    let cursor: string | undefined = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const next = await f.quotas.reviewRecords('space', { cursor });
      ids.push(...next.records.map((r) => r.taskId));
      cursor = next.nextCursor;
      assert.ok(++pages <= 3);
    }
    assert.equal(pages, 3);
    assert.deepEqual(
      ids,
      Array.from({ length: 63 }, (_, i) => `review-${String(i).padStart(3, '0')}`),
    );
    assert.equal(new Set(ids).size, 63);
    assert.deepEqual(await f.quotas.reviewRecords('empty-space'), { records: [] });
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test('review pagination rejects foreign and malformed cursors and invalid page sizes', async () => {
  const f = await fixture();
  try {
    for (const space of ['first-space', 'second-space']) {
      for (const suffix of ['a', 'b']) {
        const id = `${space}-${suffix}`;
        await f.quotas.reserve(id, space);
        await f.quotas.settle(task(id, 'reconciling'));
      }
    }
    const first = await f.quotas.reviewRecords('first-space', { limit: 1 });
    assert.equal(first.records.length, 1);
    assert.ok(first.nextCursor);
    await assert.rejects(f.quotas.reviewRecords('second-space', { cursor: first.nextCursor }), {
      code: 'INVALID_QUOTA_INPUT',
      statusCode: 400,
    });
    const payload = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'));
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      '',
      '!',
      'a'.repeat(2_001),
      first.nextCursor + '=',
      encoded(null),
      encoded([]),
      encoded({ ...payload, version: 2 }),
      encoded({ ...payload, createdAt: 'not-a-date' }),
      encoded({ ...payload, taskId: 'missing-task' }),
      encoded({ ...payload, createdAt: '2000-01-01T00:00:00.000Z' }),
      encoded({ ...payload, extra: 'unexpected' }),
    ])
      await assert.rejects(f.quotas.reviewRecords('first-space', { cursor }), {
        code: 'INVALID_QUOTA_INPUT',
        statusCode: 400,
      });
    // Editing only the space inside a borrowed cursor cannot reuse another space's anchor.
    await assert.rejects(
      f.quotas.reviewRecords('second-space', {
        cursor: encoded({ ...payload, workspaceId: 'second-space' }),
      }),
      { code: 'INVALID_QUOTA_INPUT', statusCode: 400 },
    );
    for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])
      await assert.rejects(f.quotas.reviewRecords('first-space', { limit }), {
        code: 'INVALID_QUOTA_INPUT',
        statusCode: 400,
      });
    const second = await f.quotas.reviewRecords('second-space');
    assert.equal(second.records.length, 2);
    assert.ok(second.records.every((r) => r.workspaceId === 'second-space'));
  } finally {
    await f.close();
  }
});

test('reservations, prior audit entries and policies survive service and database restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhizuo-quotas-persist-'));
  let db = await openDatabase(dir);
  try {
    const first = new QuotaService(db, 3);
    await first.initialize();
    await first.setLimit('space', 7, '长期内测额度', 'admin');
    await first.reserve('persistent', 'space');
    await first.settle(task('persistent', 'reconciling'));
    const before = await first.summary('space');
    await db.close();
    db = await openDatabase(dir);
    const next = new QuotaService(db, 999);
    await next.initialize();
    assert.deepEqual(await next.summary('space'), before);
    await next.resolve('persistent', 'consume', '重启后核对供应商任务已执行', 'admin');
    const after = await next.summary('space');
    assert.equal(after.limit, 7);
    assert.equal(after.reserved, 0);
    assert.equal(after.consumed, 1);
    assert.equal(after.available, 6);
    assert.deepEqual(after.events.slice(1), before.events);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('audit reasons preserve multiline structured notes without accepting control characters', async () => {
  const f = await fixture();
  try {
    const reason = '供应商记录已核对。\n保留说明以便复查。';
    await f.quotas.setLimit('space', 5, reason, 'admin');
    assert.equal((await f.quotas.summary('space')).events[0].reason, reason);
  } finally {
    await f.close();
  }
});
