import type {
  Board,
  BoardEdge,
  BoardNode,
  Brief,
  ContentVersion,
  GenerationTask,
} from '../../../packages/shared/src/index';

export const relationLabels: Record<NonNullable<BoardEdge['kind']>, string> = {
  uses: '使用素材',
  derived_from: '生成来源',
  variant_of: '版本迭代',
  reviewed_by: '审阅备注',
};
export const taskStatusLabels: Record<GenerationTask['status'], string> = {
  queued: '等待执行',
  running: '正在生成',
  reconciling: '需要核对',
  succeeded: '生成完成',
  failed: '生成失败',
  cancelled: '已取消',
};

export function absolutePosition(node: BoardNode, nodes: BoardNode[]): BoardNode['position'] {
  const position = { ...node.position };
  const seen = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) break;
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

// React Flow requires parents before children. Only a root group may be a parent.
export function orderedNodes(nodes: BoardNode[]): BoardNode[] {
  const roots = new Map(nodes.map((n) => [n.id, n]));
  const valid = nodes.map((node) => {
    if (!node.parentId) return node;
    const parent = roots.get(node.parentId);
    if (
      node.data.kind !== 'group' &&
      parent?.data.kind === 'group' &&
      !parent.parentId &&
      parent.id !== node.id
    )
      return node;
    const { parentId: _parent, ...detached } = node;
    return { ...detached, position: absolutePosition(node, nodes) };
  });
  return [...valid.filter((n) => !n.parentId), ...valid.filter((n) => n.parentId)];
}

export function cleanBoard(board: Board): Board {
  return {
    schemaVersion: 1,
    nodes: orderedNodes(board.nodes).map((node) => {
      const { kind, label, assetId, versionId, taskId, taskSnapshot, text, color, reviewStatus } =
        node.data;
      return {
        id: node.id,
        type: 'content',
        position: { ...node.position },
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(kind === 'group' ? { width: node.width ?? 600, height: node.height ?? 400 } : {}),
        data: {
          kind,
          label,
          ...(assetId ? { assetId } : {}),
          ...(versionId ? { versionId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(taskSnapshot
            ? {
                taskSnapshot: {
                  kind: taskSnapshot.kind,
                  status: taskSnapshot.status,
                  createdAt: taskSnapshot.createdAt,
                  ...(taskSnapshot.resultVersionId
                    ? { resultVersionId: taskSnapshot.resultVersionId }
                    : {}),
                },
              }
            : {}),
          ...(text !== undefined ? { text } : {}),
          ...(color ? { color } : {}),
          ...(reviewStatus ? { reviewStatus } : {}),
        },
      };
    }),
    edges: board.edges.map(({ id, source, target, label, kind }) => ({
      id,
      source,
      target,
      ...(label ? { label } : {}),
      ...(kind ? { kind } : {}),
    })),
    viewport: { ...board.viewport },
  };
}

export function nodeSize(node: BoardNode): { width: number; height: number } {
  const measured = (node as BoardNode & { measured?: { width?: number; height?: number } })
    .measured;
  return {
    width: node.width ?? measured?.width ?? 258,
    height: node.height ?? measured?.height ?? 340,
  };
}

export function createGroup(board: Board, selectedIds: string[], id: string): Board {
  const selected = new Set(selectedIds);
  const children = board.nodes.filter(
    (n) => selected.has(n.id) && !n.parentId && n.data.kind !== 'group',
  );
  if (children.length < 2 || board.nodes.some((n) => n.id === id)) return board;
  const x = Math.min(...children.map((n) => n.position.x)) - 32;
  const y = Math.min(...children.map((n) => n.position.y)) - 64;
  const width = Math.max(...children.map((n) => n.position.x + nodeSize(n).width)) - x + 32;
  const height = Math.max(...children.map((n) => n.position.y + nodeSize(n).height)) - y + 32;
  if (width > 6000 || height > 6000) return board;
  const group: BoardNode = {
    id,
    type: 'content',
    position: { x, y },
    width,
    height,
    data: { kind: 'group', label: '内容分组', color: '#cbd9c5' },
  };
  const childIds = new Set(children.map((n) => n.id));
  return {
    ...board,
    nodes: orderedNodes([
      group,
      ...board.nodes.map((node) =>
        childIds.has(node.id)
          ? { ...node, parentId: id, position: { x: node.position.x - x, y: node.position.y - y } }
          : node,
      ),
    ]),
  };
}

export function removeNodes(board: Board, ids: string[]): Board {
  const requested = new Set(ids);
  const removedGroups = new Set(
    board.nodes.filter((n) => requested.has(n.id) && n.data.kind === 'group').map((n) => n.id),
  );
  // React Flow expands a parent deletion to its children. Preserve these children, including the brief.
  const removed = new Set(
    board.nodes
      .filter(
        (n) =>
          requested.has(n.id) &&
          n.id !== 'brief' &&
          n.data.kind !== 'brief' &&
          !(n.parentId && removedGroups.has(n.parentId)),
      )
      .map((n) => n.id),
  );
  const nodes = board.nodes
    .filter((n) => !removed.has(n.id))
    .map((node) => {
      if (!node.parentId || !removedGroups.has(node.parentId)) return node;
      const { parentId: _parent, ...detached } = node;
      return { ...detached, position: absolutePosition(node, board.nodes) };
    });
  return {
    ...board,
    nodes: orderedNodes(nodes),
    edges: board.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
  };
}

export function mergeBoards(local: Board, remote: Board, base?: Board): Board {
  const baseNodes = new Set(base?.nodes.map((n) => n.id));
  const baseEdges = new Set(base?.edges.map((e) => e.id));
  const localIds = new Set(local.nodes.map((n) => n.id));
  const localEdgeIds = new Set(local.edges.map((e) => e.id));
  let nodes = [
    ...local.nodes,
    ...remote.nodes.filter((n) => !localIds.has(n.id) && !baseNodes.has(n.id)),
  ];
  const ids = new Set(nodes.map((n) => n.id));
  nodes = nodes.map((node) => {
    if (!node.parentId || ids.has(node.parentId)) return node;
    const { parentId: _parent, ...detached } = node;
    return {
      ...detached,
      position: absolutePosition(node, localIds.has(node.id) ? local.nodes : remote.nodes),
    };
  });
  const edges = [
    ...local.edges,
    ...remote.edges.filter((e) => !localEdgeIds.has(e.id) && !baseEdges.has(e.id)),
  ].filter((e) => ids.has(e.source) && ids.has(e.target));
  return { ...local, nodes: orderedNodes(nodes), edges };
}

export function withTaskNodes(
  board: Board,
  tasks: GenerationTask[],
  versions: ContentVersion[],
): Board {
  const nodes = [...board.nodes];
  const edges = [...board.edges];
  let changed = false;
  for (const task of tasks) {
    let node = nodes.find((n) => n.data.kind === 'generation' && n.data.taskId === task.id);
    if (!node) {
      const id = `task-${task.id}`;
      if (nodes.some((n) => n.id === id)) continue;
      node = {
        id,
        type: 'content',
        position: {
          x: 400 + (nodes.length % 3) * 320,
          y: 120 + Math.floor(nodes.length / 3) * 400,
        },
        data: {
          kind: 'generation',
          label: task.kind === 'copy' ? '文案生成任务' : '图片生成任务',
          taskId: task.id,
        },
      };
      nodes.push(node);
      changed = true;
    }
    const output = nodes.find(
      (n) =>
        n.data.versionId ===
          (task.resultVersionId || versions.find((v) => v.taskId === task.id)?.id) &&
        n.data.versionId,
    );
    if (output && !edges.some((e) => e.source === node!.id && e.target === output.id)) {
      edges.push({
        id: `task-output-${task.id}-${output.id}`,
        source: node.id,
        target: output.id,
        kind: 'derived_from',
        label: '生成结果',
      });
      changed = true;
    }
  }
  return changed ? { ...board, nodes: orderedNodes(nodes), edges } : board;
}

export function generationNodeState(data: BoardNode['data'], tasks: GenerationTask[]) {
  const task = data.taskId ? tasks.find((item) => item.id === data.taskId) : undefined;
  const snapshot = task ? undefined : data.taskSnapshot;
  return {
    task,
    snapshot,
    historical: !!snapshot,
    canCancel: !!task && ['queued', 'running', 'reconciling'].includes(task.status),
    resultVersionId: task?.resultVersionId || snapshot?.resultVersionId,
    statusLabel: task
      ? taskStatusLabels[task.status]
      : snapshot
        ? `备份时：${taskStatusLabels[snapshot.status]}`
        : '任务记录待加载',
  };
}

export function mergeProjectFields(
  local: { title: string; brief: Brief },
  remote: { title: string; brief: Brief },
  base: { title?: string; brief?: Brief },
): { title: string; brief: Brief } {
  const keys = [
    ...new Set([
      ...Object.keys(local.brief),
      ...Object.keys(remote.brief),
      ...Object.keys(base.brief || {}),
    ]),
  ] as (keyof Brief)[];
  // Older drafts have no field baseline. Keep their local values rather than guessing which facts were edited.
  const brief = base.brief
    ? (Object.fromEntries(
        keys.map((key) => [
          key,
          JSON.stringify(local.brief[key]) === JSON.stringify(base.brief![key])
            ? remote.brief[key]
            : local.brief[key],
        ]),
      ) as unknown as Brief)
    : local.brief;
  return {
    title: base.title !== undefined && local.title === base.title ? remote.title : local.title,
    brief,
  };
}
