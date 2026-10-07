import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  FileText,
  Image,
  Layers3,
  Maximize2,
  ScrollText,
  MessageSquare,
  Sparkles,
  Group,
  StickyNote,
} from 'lucide-react';
import type {
  Asset,
  Board,
  BoardEdge,
  BoardNode,
  Brief,
  ContentVersion,
  GenerationTask,
} from '../../../packages/shared/src/index';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Label } from './components/ui/label';
import { generationNodeState, orderedNodes, relationLabels, removeNodes } from './canvas-helpers';
import './canvas-extras.css';
const ContentContext = createContext<{
  assets: Asset[];
  versions: ContentVersion[];
  brief: Brief;
  tasks: GenerationTask[];
  onHistory: () => void;
  onCancelTask: (task: GenerationTask) => void;
  onViewResult: (versionId: string) => void;
  onUsePrompt: (text: string) => void;
}>({
  assets: [],
  versions: [],
  brief: {} as Brief,
  tasks: [],
  onHistory: () => {},
  onCancelTask: () => {},
  onViewResult: () => {},
  onUsePrompt: () => {},
});
const kindLabel = {
  brief: '内容简报',
  asset: '原始素材',
  copy: '图文文案',
  poster: '模板海报',
  image: 'AI 图片',
  prompt: '提示词',
  generation: '生成任务',
  annotation: '审阅备注',
  group: '内容分组',
};
function ContentNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as BoardNode['data'];
  const { assets, versions, brief, tasks, onHistory, onCancelTask, onViewResult, onUsePrompt } =
    useContext(ContentContext);
  const taskState = generationNodeState(data, tasks);
  const { task, snapshot } = taskState;
  const version = versions.find((v) => v.id === data.versionId);
  const asset = assets.find((a) => a.id === (data.assetId || version?.assetId));
  const Icon =
    data.kind === 'prompt'
      ? MessageSquare
      : data.kind === 'annotation'
        ? StickyNote
        : data.kind === 'generation'
          ? Sparkles
          : data.kind === 'brief'
            ? ScrollText
            : data.kind === 'copy'
              ? FileText
              : data.kind === 'poster'
                ? Layers3
                : Image;
  if (data.kind === 'group')
    return (
      <div
        className={`canvas-group ${selected ? 'node-selected' : ''}`}
        style={{ '--node-color': data.color || '#cbd9c5' } as CSSProperties}
      >
        <NodeResizer
          isVisible={selected}
          minWidth={320}
          minHeight={160}
          maxWidth={6000}
          maxHeight={6000}
          onResizeStart={onHistory}
          handleClassName="group-resize-handle"
        />
        <div className="group-heading">
          <Group size={18} />
          <strong>{data.label}</strong>
          <span>拖动标题移动分组</span>
        </div>
      </div>
    );
  return (
    <div
      style={data.color ? { borderColor: data.color } : undefined}
      className={`canvas-node node-${data.kind} ${selected ? 'node-selected' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-topline">
        <span>
          <Icon size={14} />
          {kindLabel[data.kind]}
        </span>
        {version && (
          <span className="node-version">{version.parentVersionId ? '迭代版' : '初始版'}</span>
        )}
      </div>
      {data.kind === 'prompt' || data.kind === 'annotation' ? (
        <div className="node-note">
          <h3>{data.label}</h3>
          <p>
            {data.text ||
              (data.kind === 'prompt' ? '选择节点填写创作方向' : '选择节点填写审阅意见')}
          </p>
          {data.kind === 'annotation' ? (
            <span
              className={`annotation-state ${data.reviewStatus === 'resolved' ? 'resolved' : ''}`}
            >
              {data.reviewStatus === 'resolved' ? '已解决' : '待处理'}
            </span>
          ) : (
            <Button
              className="text-button nodrag nopan"
              disabled={!data.text?.trim()}
              onClick={(e) => {
                e.stopPropagation();
                onUsePrompt(data.text || '');
              }}
            >
              用于创作
            </Button>
          )}
        </div>
      ) : data.kind === 'generation' ? (
        <div className="node-task">
          <strong
            className={`canvas-task-status task-${taskState.historical ? 'history' : task?.status || 'unknown'}`}
            role="status"
          >
            {taskState.statusLabel}
          </strong>
          <p>{snapshot ? '历史记录，不会恢复执行' : task?.prompt || '根据已确认的商品简报生成'}</p>
          {task?.error && <p className="task-error">{task.error}</p>}
          {task?.status === 'reconciling' && (
            <p className="task-error">请核对服务商结果与费用后再决定是否重新创作。</p>
          )}
          <div className="canvas-task-actions nodrag nopan">
            {task && taskState.canCancel && (
              <Button
                className="text-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancelTask(task);
                }}
              >
                {task.status === 'queued' ? '取消任务' : '停止本地等待'}
              </Button>
            )}
            {taskState.resultVersionId && (
              <Button
                className="text-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewResult(taskState.resultVersionId!);
                }}
              >
                查看结果
              </Button>
            )}
          </div>
        </div>
      ) : data.kind === 'brief' ? (
        <div className="node-brief">
          <h3>{brief.productName || '告诉我们你的产品'}</h3>
          <p>{brief.sellingPoints || '从产品名称、卖点与受众开始，给创作一个清晰方向。'}</p>
          <div className={`brief-status ${brief.confirmed ? 'confirmed' : ''}`}>
            <i />
            {brief.confirmed ? '商品事实已确认' : '等待填写与确认'}
          </div>
        </div>
      ) : data.kind === 'copy' ? (
        <div className="node-copy">
          <h3>{version?.copy?.titles[0] || data.label}</h3>
          <p>{version?.copy?.body || '点击查看和编辑文案'}</p>
          <div className="node-tags">
            {version?.copy?.tags.slice(0, 3).map((tag, i) => (
              <span key={i}>#{tag.replace(/^#/, '')}</span>
            ))}
          </div>
        </div>
      ) : (
        <div className="node-image">
          {data.kind === 'poster' ? (
            <img src={`/api/versions/${data.versionId}/preview`} alt={data.label} loading="lazy" />
          ) : asset ? (
            <img
              src={asset.thumbnailUrl || `/api/assets/${asset.id}/thumbnail`}
              alt={asset.name}
              loading="lazy"
            />
          ) : (
            <div className="node-placeholder">
              <Image size={34} />
              <span>素材准备中</span>
            </div>
          )}
        </div>
      )}
      <div className="node-bottom">
        <strong>{data.label}</strong>
        <span>
          {data.kind === 'prompt'
            ? '预填创作表单'
            : data.kind === 'annotation'
              ? '审阅意见'
              : data.kind === 'generation'
                ? taskState.historical
                  ? '备份历史记录'
                  : '真实任务记录'
                : data.kind === 'brief'
                  ? '创作起点'
                  : version?.copy
                    ? `${version.copy.pages.length} 页大纲`
                    : asset
                      ? `${asset.width}×${asset.height}`
                      : version?.poster
                        ? `${version.poster.width}×${version.poster.height}`
                        : '选择查看'}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { content: memo(ContentNode) };
export function Canvas({
  board,
  assets,
  versions,
  brief,
  onChange,
  onHistory,
  onSelect,
  fitSignal,
  tasks,
  onCancelTask,
  onViewResult,
  onUsePrompt,
}: {
  board: Board;
  assets: Asset[];
  versions: ContentVersion[];
  brief: Brief;
  onChange: (b: Board, persist?: boolean) => void;
  onHistory: () => void;
  onSelect: (data: BoardNode['data'] | null, id?: string) => void;
  fitSignal: number;
  tasks: GenerationTask[];
  onCancelTask: (task: GenerationTask) => void;
  onViewResult: (versionId: string) => void;
  onUsePrompt: (text: string) => void;
}) {
  const flow = useRef<ReactFlowInstance<BoardNode, BoardEdge>>(null);
  const boardRef = useRef(board);
  boardRef.current = board;
  function changeBoard(next: Board, persist = true) {
    boardRef.current = next;
    onChange(next, persist);
  }
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const selectedEdge = board.edges.find((edge) => edge.id === selectedEdgeId);
  const content = useMemo(
    () => ({ assets, versions, brief, tasks, onHistory, onCancelTask, onViewResult, onUsePrompt }),
    [assets, versions, brief, tasks, onHistory, onCancelTask, onViewResult, onUsePrompt],
  );
  const nodes = useMemo(
    () =>
      orderedNodes(board.nodes).map((node) => ({
        ...node,
        deletable:
          node.id !== 'brief' && node.data.kind !== 'brief' && node.data.kind !== 'generation',
        ...(node.data.kind === 'group'
          ? {
              style: { width: node.width ?? 600, height: node.height ?? 400 },
              dragHandle: '.group-heading',
            }
          : {}),
      })),
    [board.nodes],
  );
  const edges = useMemo(
    () =>
      board.edges.map((edge) => ({
        ...edge,
        label: edge.label || relationLabels[edge.kind || 'uses'],
        ariaLabel: edge.label || relationLabels[edge.kind || 'uses'],
      })),
    [board.edges],
  );
  useEffect(() => {
    if (fitSignal) flow.current?.fitView({ padding: 0.22, duration: 0, maxZoom: 1 });
  }, [fitSignal]);
  return (
    <ContentContext.Provider value={content}>
      <div className="canvas-area">
        <ReactFlow<BoardNode, BoardEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={board.viewport}
          minZoom={0.15}
          maxZoom={1.8}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onNodesChange={(changes) => {
            const board = boardRef.current;
            const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
            if (removed.length) onHistory();
            const changed = applyNodeChanges(
              changes.filter((c) => c.type !== 'remove'),
              board.nodes,
            );
            const next = removeNodes({ ...board, nodes: changed }, removed);
            const persist =
              removed.length > 0 ||
              changes.some(
                (c) =>
                  c.type === 'position' ||
                  (c.type === 'dimensions' &&
                    c.setAttributes &&
                    board.nodes.find((n) => n.id === c.id)?.data.kind === 'group'),
              );
            changeBoard(next, persist);
          }}
          onBeforeDelete={async ({ nodes: deletedNodes, edges: deletedEdges }) => {
            const board = boardRef.current;
            const next = removeNodes(
              board,
              deletedNodes.map((n) => n.id),
            );
            const selectedEdges = new Set(
              deletedEdges
                .filter((edge) => (edge as BoardEdge & { selected?: boolean }).selected)
                .map((edge) => edge.id),
            );
            next.edges = next.edges.filter((edge) => !selectedEdges.has(edge.id));
            if (
              next.nodes.length !== board.nodes.length ||
              next.edges.length !== board.edges.length
            ) {
              onHistory();
              changeBoard(next);
            }
            // Commit removal once so a single undo restores both nodes and their edges.
            return false;
          }}
          onEdgesChange={(changes) => {
            const board = boardRef.current;
            if (changes.some((c) => c.type === 'remove')) onHistory();
            changeBoard(
              { ...board, edges: applyEdgeChanges<BoardEdge>(changes, board.edges) },
              changes.some((c) => c.type === 'remove'),
            );
          }}
          onNodeDragStart={onHistory}
          onSelectionDragStart={onHistory}
          onConnect={(connection) => {
            const board = boardRef.current;
            if (connection.source === connection.target) return;
            onHistory();
            changeBoard({
              ...board,
              edges: [
                ...board.edges,
                {
                  id: `edge-${crypto.randomUUID()}`,
                  source: connection.source,
                  target: connection.target,
                  kind: 'uses',
                },
              ],
            });
          }}
          onNodeClick={(_, node) => {
            setSelectedEdgeId(undefined);
            onSelect(node.data, node.id);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            onSelect(null);
          }}
          onPaneClick={() => {
            setSelectedEdgeId(undefined);
            onSelect(null);
          }}
          onMoveEnd={(_, viewport) => changeBoard({ ...boardRef.current, viewport })}
          deleteKeyCode={['Backspace', 'Delete']}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          panOnScroll
          selectionOnDrag
          panOnDrag={[1, 2]}
          zoomOnScroll={false}
          fitView={false}
          attributionPosition="bottom-right"
        >
          {selectedEdge && (
            <div className="edge-inspector nodrag nopan nowheel" role="group" aria-label="连线关系">
              <Label>
                连线关系
                <select
                  value={selectedEdge.kind || 'uses'}
                  onChange={(event) => {
                    onHistory();
                    changeBoard({
                      ...board,
                      edges: board.edges.map((edge) =>
                        edge.id === selectedEdge.id
                          ? {
                              ...edge,
                              kind: event.target.value as BoardEdge['kind'],
                              label:
                                relationLabels[event.target.value as keyof typeof relationLabels],
                            }
                          : edge,
                      ),
                    });
                  }}
                >
                  {Object.entries(relationLabels).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
              </Label>
              <p>连线记录内容来源与审阅关系。</p>
              <Button
                className="text-button danger-text"
                onClick={() => {
                  onHistory();
                  changeBoard({
                    ...boardRef.current,
                    edges: boardRef.current.edges.filter((edge) => edge.id !== selectedEdge.id),
                  });
                  setSelectedEdgeId(undefined);
                }}
              >
                删除连线
              </Button>
            </div>
          )}
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d9ddd5" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            nodeColor="#d5e0d5"
            maskColor="rgba(247,248,244,.75)"
            pannable
            zoomable
            position="bottom-right"
          />
          <div className="canvas-tip">
            <Maximize2 size={12} />
            滚动平移 · 双指缩放 · Shift 框选 · 拖动端点连接
          </div>
        </ReactFlow>
      </div>
    </ContentContext.Provider>
  );
}

export function CanvasNodeEditor({
  node,
  onSave,
  onUsePrompt,
  onUngroup,
}: {
  node: BoardNode;
  onSave: (data: BoardNode['data'], size?: { width: number; height: number }) => void;
  onUsePrompt: (text: string) => void;
  onUngroup: () => void;
}) {
  const [data, setData] = useState(node.data);
  const [width, setWidth] = useState(node.width || 600);
  const [height, setHeight] = useState(node.height || 400);
  useEffect(() => {
    setData(node.data);
    setWidth(node.width || 600);
    setHeight(node.height || 400);
  }, [node.id, node.data, node.width, node.height]);
  const note = data.kind === 'prompt' || data.kind === 'annotation';
  return (
    <form
      className="canvas-node-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          { ...data, label: data.label.trim() },
          data.kind === 'group' ? { width, height } : undefined,
        );
      }}
    >
      <Label>
        节点名称
        <Input
          required
          maxLength={120}
          value={data.label}
          onChange={(e) => setData({ ...data, label: e.target.value })}
        />
      </Label>
      {note && (
        <Label>
          {data.kind === 'prompt' ? '创作方向' : '审阅意见'}
          <Textarea
            rows={5}
            maxLength={8000}
            value={data.text || ''}
            onChange={(e) => setData({ ...data, text: e.target.value })}
          />
        </Label>
      )}
      <Label className="color-field">
        节点颜色
        <input
          type="color"
          value={data.color || '#cbd9c5'}
          onChange={(e) => setData({ ...data, color: e.target.value })}
        />
      </Label>
      {data.kind === 'annotation' && (
        <Label>
          处理状态
          <select
            value={data.reviewStatus || 'open'}
            onChange={(e) =>
              setData({ ...data, reviewStatus: e.target.value as 'open' | 'resolved' })
            }
          >
            <option value="open">待处理</option>
            <option value="resolved">已解决</option>
          </select>
        </Label>
      )}
      {data.kind === 'group' && (
        <>
          <p className="hint">拖动标题移动整个分组。拖动边角或输入尺寸调整范围。</p>
          <div className="group-size-fields">
            <Label>
              宽度
              <Input
                type="number"
                min={320}
                max={6000}
                required
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              />
            </Label>
            <Label>
              高度
              <Input
                type="number"
                min={160}
                max={6000}
                required
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
              />
            </Label>
          </div>
        </>
      )}
      <Button className="button primary full" disabled={!data.label.trim()}>
        保存节点
      </Button>
      {data.kind === 'prompt' && (
        <Button
          type="button"
          className="button secondary full"
          disabled={!data.text?.trim()}
          onClick={() => {
            onSave({ ...data, label: data.label.trim() || '提示词' });
            onUsePrompt(data.text || '');
          }}
        >
          用于创作
        </Button>
      )}
      {data.kind === 'group' && (
        <Button type="button" className="button secondary full" onClick={onUngroup}>
          解除分组，保留内容
        </Button>
      )}
    </form>
  );
}
