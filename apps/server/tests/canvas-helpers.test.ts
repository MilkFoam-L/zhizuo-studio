import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_BRIEF,
  initialBoard,
  type Board,
  type BoardNode,
  type GenerationTask,
} from '../../../packages/shared/src/index';
import {
  absolutePosition,
  cleanBoard,
  createGroup,
  generationNodeState,
  mergeProjectFields,
  mergeBoards,
  orderedNodes,
  removeNodes,
  withTaskNodes,
} from '../../web/src/canvas-helpers';

function fixture(): Board {
  return {
    ...initialBoard(),
    nodes: [
      ...initialBoard().nodes,
      {
        id: 'prompt',
        type: 'content',
        position: { x: 410, y: 240 },
        data: { kind: 'prompt', label: '方向', text: '自然光，保留外观', color: '#b1ccad' },
      },
      {
        id: 'note',
        type: 'content',
        position: { x: 800, y: 280 },
        data: { kind: 'annotation', label: '核对', text: '请确认商品价格', reviewStatus: 'open' },
      },
    ],
    edges: [{ id: 'review', source: 'prompt', target: 'note', kind: 'reviewed_by' }],
  };
}

test('grouping and moving preserves relative layout; ungrouping restores moved absolute positions', () => {
  const original = fixture();
  const snapshot = structuredClone(original);
  const grouped = createGroup(original, ['prompt', 'note'], 'group');
  assert.deepEqual(original, snapshot, 'history snapshot must remain unchanged');
  assert.equal(grouped.nodes[0].data.kind, 'group');
  for (const id of ['prompt', 'note']) {
    const node = grouped.nodes.find((n) => n.id === id)!;
    assert.equal(node.parentId, 'group');
    assert.deepEqual(
      absolutePosition(node, grouped.nodes),
      original.nodes.find((n) => n.id === id)!.position,
    );
  }
  const moved = {
    ...grouped,
    nodes: grouped.nodes.map((n) =>
      n.id === 'group' ? { ...n, position: { x: n.position.x + 150, y: n.position.y - 80 } } : n,
    ),
  };
  const restored = removeNodes(moved, ['group']);
  assert.equal(restored.nodes.length, original.nodes.length);
  assert.deepEqual(restored.nodes.find((n) => n.id === 'prompt')!.position, { x: 560, y: 160 });
  assert.deepEqual(restored.nodes.find((n) => n.id === 'note')!.position, { x: 950, y: 200 });
  assert.ok(restored.nodes.every((n) => !n.parentId));
  assert.deepEqual(restored.edges, original.edges);
});

test('expanded group deletion keeps children, the brief and their relationships', () => {
  const grouped = createGroup(fixture(), ['brief', 'prompt', 'note'], 'group');
  const deleted = removeNodes(grouped, ['group', 'brief', 'prompt', 'note']);
  assert.deepEqual(deleted.nodes.map((n) => n.id).sort(), ['brief', 'note', 'prompt']);
  assert.equal(deleted.edges[0].kind, 'reviewed_by');
  assert.deepEqual(removeNodes(deleted, ['brief']).nodes, deleted.nodes);
  assert.equal(removeNodes(deleted, ['note']).edges.length, 0);
});

test('serialization keeps editable data and group geometry while stripping React Flow state', () => {
  const grouped = createGroup(fixture(), ['prompt', 'note'], 'group');
  const dirty = {
    ...grouped,
    nodes: grouped.nodes.map((node) => ({
      ...node,
      selected: true,
      dragging: true,
      measured: { width: 258, height: 340 },
      style: { cursor: 'grabbing' },
    })),
    edges: grouped.edges.map((edge) => ({ ...edge, selected: true, markerEnd: 'display-only' })),
  };
  const saved = cleanBoard(dirty);
  const json = JSON.parse(JSON.stringify(saved)) as Board;
  assert.equal(json.nodes[0].width, grouped.nodes[0].width);
  assert.equal(json.nodes[0].height, grouped.nodes[0].height);
  assert.equal(json.nodes.find((n) => n.id === 'prompt')!.parentId, 'group');
  assert.deepEqual(json.nodes.find((n) => n.id === 'note')!.data, fixture().nodes[2].data);
  assert.deepEqual(json.edges, fixture().edges);
  assert.equal(JSON.stringify(json).includes('selected'), false);
  assert.equal(JSON.stringify(json).includes('measured'), false);
  assert.equal(JSON.stringify(json).includes('dragging'), false);
  assert.deepEqual(cleanBoard(json), json);
});

test('merge retains local ungrouping and gives new remote children absolute positions', () => {
  const base = createGroup(fixture(), ['prompt', 'note'], 'group');
  const group = base.nodes.find((n) => n.id === 'group')!;
  const local = removeNodes(base, ['group']);
  local.nodes.find((n) => n.id === 'note')!.data = {
    ...local.nodes.find((n) => n.id === 'note')!.data,
    reviewStatus: 'resolved',
  };
  const remoteChild: BoardNode = {
    id: 'remote-note',
    type: 'content',
    parentId: 'group',
    position: { x: 40, y: 90 },
    data: { kind: 'annotation', label: '新增审阅' },
  };
  const remote = { ...base, nodes: [...base.nodes, remoteChild] };
  const merged = mergeBoards(local, remote, base);
  assert.equal(
    merged.nodes.some((n) => n.id === 'group'),
    false,
  );
  assert.deepEqual(merged.nodes.find((n) => n.id === remoteChild.id)!.position, {
    x: group.position.x + 40,
    y: group.position.y + 90,
  });
  assert.equal(merged.nodes.find((n) => n.id === remoteChild.id)!.parentId, undefined);
  assert.equal(merged.nodes.find((n) => n.id === 'note')!.data.reviewStatus, 'resolved');
});

test('invalid self, missing and cyclic parent links are detached; nested groups are not created', () => {
  const nodes: BoardNode[] = [
    {
      id: 'a',
      type: 'content',
      parentId: 'b',
      position: { x: 1, y: 2 },
      data: { kind: 'group', label: 'A' },
    },
    {
      id: 'b',
      type: 'content',
      parentId: 'a',
      position: { x: 3, y: 4 },
      data: { kind: 'group', label: 'B' },
    },
    {
      id: 'self',
      type: 'content',
      parentId: 'self',
      position: { x: 5, y: 6 },
      data: { kind: 'annotation', label: 'self' },
    },
    {
      id: 'missing',
      type: 'content',
      parentId: 'gone',
      position: { x: 7, y: 8 },
      data: { kind: 'prompt', label: 'missing' },
    },
  ];
  assert.ok(orderedNodes(nodes).every((n) => !n.parentId));
  const grouped = createGroup(fixture(), ['prompt', 'note'], 'group');
  assert.equal(createGroup(grouped, ['group', 'prompt'], 'nested'), grouped);
});

test('only recorded tasks gain nodes and result edges, without duplicating or embedding private provider fields', () => {
  const task: GenerationTask = {
    id: 'recorded',
    projectId: 'project',
    providerId: 'provider',
    kind: 'image',
    status: 'succeeded',
    prompt: '柔光',
    attempts: 1,
    resultVersionId: 'version',
    upstreamTaskId: 'private-upstream',
    createdAt: '',
    updatedAt: '',
  };
  const board: Board = {
    ...fixture(),
    nodes: [
      ...fixture().nodes,
      {
        id: 'output',
        type: 'content',
        position: { x: 900, y: 0 },
        data: { kind: 'image', label: '生成图', versionId: 'version' },
      },
    ],
  };
  const populated = withTaskNodes(board, [task], []);
  assert.equal(populated.nodes.filter((n) => n.data.kind === 'generation').length, 1);
  assert.deepEqual(
    populated.edges.find((e) => e.source === 'task-recorded'),
    {
      id: 'task-output-recorded-output',
      source: 'task-recorded',
      target: 'output',
      kind: 'derived_from',
      label: '生成结果',
    },
  );
  assert.equal(withTaskNodes(populated, [task], []), populated);
  assert.equal(withTaskNodes(board, [], []), board);
  assert.equal(JSON.stringify(populated).includes('private-upstream'), false);
  assert.equal(JSON.stringify(populated).includes('providerId'), false);
});

test('restored task snapshots stay historical and retain only the public snapshot fields', () => {
  const snapshot = {
    kind: 'image' as const,
    status: 'running' as const,
    createdAt: '2026-09-30T02:00:00.000Z',
    resultVersionId: 'restored-result',
    upstreamTaskId: 'private-upstream',
    providerId: 'private-provider',
  };
  const data: BoardNode['data'] = { kind: 'generation', label: '备份任务', taskSnapshot: snapshot };
  const board: Board = {
    ...fixture(),
    nodes: [
      ...fixture().nodes,
      { id: 'history', type: 'content', position: { x: 100, y: 100 }, data },
    ],
  };
  assert.equal(
    withTaskNodes(board, [], []),
    board,
    'history never creates an executable task node',
  );
  for (const status of [
    'queued',
    'running',
    'reconciling',
    'succeeded',
    'failed',
    'cancelled',
  ] as const) {
    const state = generationNodeState({ ...data, taskSnapshot: { ...snapshot, status } }, []);
    assert.equal(state.task, undefined);
    assert.equal(state.historical, true);
    assert.equal(state.canCancel, false);
    assert.equal(state.resultVersionId, 'restored-result');
    assert.match(state.statusLabel, /^备份时：/);
  }
  const saved = cleanBoard(createGroup(board, ['prompt', 'history'], 'group'));
  const restored = removeNodes(saved, ['group']).nodes.find((node) => node.id === 'history')!;
  assert.deepEqual(restored.data.taskSnapshot, {
    kind: 'image',
    status: 'running',
    createdAt: snapshot.createdAt,
    resultVersionId: 'restored-result',
  });
  assert.equal(JSON.stringify(saved).includes('private-'), false);
  const live: GenerationTask = {
    id: 'current',
    projectId: 'project',
    providerId: 'provider',
    kind: 'copy',
    status: 'queued',
    prompt: '',
    attempts: 0,
    createdAt: '',
    updatedAt: '',
  };
  const liveState = generationNodeState({ ...data, taskId: live.id }, [live]);
  assert.equal(liveState.task, live);
  assert.equal(liveState.historical, false);
  assert.equal(liveState.canCancel, true);
  assert.equal(
    liveState.resultVersionId,
    undefined,
    'a live task must not show an unrelated snapshot result',
  );
});

test('field merge preserves newly applied server brand when local edits only move the layout', () => {
  const base = {
    title: '原项目名',
    brief: {
      ...EMPTY_BRIEF,
      productName: '马克杯',
      brand: '旧品牌',
      bannedTerms: ['旧词'],
      logoAssetId: 'old-logo',
      confirmed: true,
    },
  };
  const stored = JSON.parse(
    JSON.stringify({ ...base, baseBrief: base.brief, baseTitle: base.title }),
  ) as typeof base & { baseBrief: typeof base.brief; baseTitle: string };
  const remote = {
    title: '云端项目名',
    brief: {
      ...base.brief,
      brand: '新品牌',
      brandColor: '#663344',
      bannedTerms: ['新词'],
      logoAssetId: undefined,
      fontFamily: 'serif' as const,
      brandKitId: 'kit',
      confirmed: false,
    },
  };
  const merged = mergeProjectFields(stored, remote, {
    title: stored.baseTitle,
    brief: stored.baseBrief,
  });
  assert.equal(merged.title, remote.title);
  assert.deepEqual(merged.brief, remote.brief);
  assert.equal(merged.brief.productName, '马克杯');
  assert.deepEqual(stored.brief.bannedTerms, ['旧词'], 'baseline and local history stay immutable');
});

test('field merge keeps local facts and titles when both sides edited the same field', () => {
  const base = {
    title: '原项目名',
    brief: {
      ...EMPTY_BRIEF,
      productName: '原商品',
      sellingPoints: '原卖点',
      brand: '旧品牌',
      confirmed: true,
    },
  };
  const local = {
    title: '我的项目名',
    brief: {
      ...base.brief,
      productName: '正在编辑的商品',
      sellingPoints: '本地核对的卖点',
      confirmed: false,
    },
  };
  const remote = {
    title: '远端项目名',
    brief: {
      ...base.brief,
      productName: '远端商品',
      brand: '新品牌',
      brandKitId: 'new-kit',
      confirmed: false,
    },
  };
  const merged = mergeProjectFields(local, remote, base);
  assert.equal(merged.title, local.title);
  assert.equal(merged.brief.productName, local.brief.productName);
  assert.equal(merged.brief.sellingPoints, local.brief.sellingPoints);
  assert.equal(merged.brief.brand, remote.brief.brand);
  assert.equal(merged.brief.brandKitId, remote.brief.brandKitId);
  assert.equal(merged.brief.confirmed, false);
  assert.deepEqual(
    mergeProjectFields(local, remote, {}),
    local,
    'legacy drafts without a baseline must not lose local facts',
  );
});
