import { createContext, memo, useContext, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { FileText, Image, Layers3, Maximize2, ScrollText } from 'lucide-react';
import type {
  Asset,
  Board,
  BoardEdge,
  BoardNode,
  Brief,
  ContentVersion,
} from '../../../packages/shared/src/index';
const ContentContext = createContext<{ assets: Asset[]; versions: ContentVersion[]; brief: Brief }>(
  { assets: [], versions: [], brief: {} as Brief },
);
const kindLabel = {
  brief: '内容简报',
  asset: '原始素材',
  copy: '图文文案',
  poster: '模板海报',
  image: 'AI 图片',
};
function ContentNode({ data: rawData, selected }: NodeProps) {
  const data = rawData as BoardNode['data'];
  const { assets, versions, brief } = useContext(ContentContext);
  const version = versions.find((v) => v.id === data.versionId);
  const asset = assets.find((a) => a.id === (data.assetId || version?.assetId));
  const Icon =
    data.kind === 'brief'
      ? ScrollText
      : data.kind === 'copy'
        ? FileText
        : data.kind === 'poster'
          ? Layers3
          : Image;
  return (
    <div className={`canvas-node node-${data.kind} ${selected ? 'node-selected' : ''}`}>
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
      {data.kind === 'brief' ? (
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
          {data.kind === 'brief'
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
}: {
  board: Board;
  assets: Asset[];
  versions: ContentVersion[];
  brief: Brief;
  onChange: (b: Board, persist?: boolean) => void;
  onHistory: () => void;
  onSelect: (data: BoardNode['data'] | null) => void;
  fitSignal: number;
}) {
  const flow = useRef<ReactFlowInstance<BoardNode, BoardEdge>>(null);
  const content = useMemo(() => ({ assets, versions, brief }), [assets, versions, brief]);
  useEffect(() => {
    if (fitSignal) flow.current?.fitView({ padding: 0.22, duration: 0, maxZoom: 1 });
  }, [fitSignal]);
  return (
    <ContentContext.Provider value={content}>
      <div className="canvas-area">
        <ReactFlow<BoardNode, BoardEdge>
          nodes={board.nodes}
          edges={board.edges}
          nodeTypes={nodeTypes}
          defaultViewport={board.viewport}
          minZoom={0.15}
          maxZoom={1.8}
          onInit={(instance) => {
            flow.current = instance;
          }}
          onNodesChange={(changes) => {
            const filtered = changes.filter((c) => !(c.type === 'remove' && c.id === 'brief'));
            if (filtered.some((c) => c.type === 'remove')) onHistory();
            const persist = filtered.some((c) => c.type === 'position' || c.type === 'remove');
            const nodes = applyNodeChanges(filtered, board.nodes);
            const ids = new Set(nodes.map((n) => n.id));
            onChange(
              {
                ...board,
                nodes,
                edges: board.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
              },
              persist,
            );
          }}
          onEdgesChange={(changes) => {
            if (changes.some((c) => c.type === 'remove')) onHistory();
            onChange(
              { ...board, edges: applyEdgeChanges<BoardEdge>(changes, board.edges) },
              changes.some((c) => c.type === 'remove'),
            );
          }}
          onNodeDragStart={onHistory}
          onConnect={(connection) => {
            if (connection.source === connection.target) return;
            onHistory();
            onChange({
              ...board,
              edges: [
                ...board.edges,
                {
                  id: `edge-${crypto.randomUUID()}`,
                  source: connection.source,
                  target: connection.target,
                },
              ],
            });
          }}
          onNodeClick={(_, node) => onSelect(node.data)}
          onPaneClick={() => onSelect(null)}
          onMoveEnd={(_, viewport) => onChange({ ...board, viewport })}
          deleteKeyCode={['Backspace', 'Delete']}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Meta', 'Control']}
          panOnScroll
          selectionOnDrag
          panOnDrag={[1, 2]}
          zoomOnScroll={false}
          fitView={false}
          attributionPosition="bottom-right"
        >
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
