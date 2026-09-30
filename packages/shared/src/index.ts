export type ProviderKind = 'openai' | 'gemini' | 'async-json';
export interface AsyncMapping {
  submitPath: string;
  pollPath: string;
  taskIdPath: string;
  statusPath: string;
  successValue: string;
  failureValue: string;
  resultUrlPath: string;
}
export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  textModel: string;
  imageModel: string;
  timeoutSeconds: number;
  asyncMapping?: AsyncMapping;
}
export interface Provider extends Omit<ProviderInput, 'apiKey'> {
  id: string;
  hasKey: boolean;
  createdAt: string;
}
export interface Brief {
  productName: string;
  sellingPoints: string;
  audience: string;
  price: string;
  brand: string;
  brandColor: string;
  tone: string;
  platform: 'xiaohongshu' | 'commerce' | 'douyin';
  confirmed: boolean;
}
export interface BoardNode {
  id: string;
  type: 'content';
  position: { x: number; y: number };
  data: {
    kind: 'brief' | 'asset' | 'copy' | 'poster' | 'image';
    label: string;
    assetId?: string;
    versionId?: string;
  };
}
export interface BoardEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}
export interface Board {
  schemaVersion: 1;
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport: { x: number; y: number; zoom: number };
}
export interface Project {
  id: string;
  title: string;
  brief: Brief;
  board: Board;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface Asset {
  id: string;
  projectId: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  url: string;
  thumbnailUrl: string;
  createdAt: string;
}
export interface CopyDraft {
  titles: string[];
  body: string;
  tags: string[];
  pages: { headline: string; body: string }[];
  warnings: string[];
}
export interface PosterText {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color: string;
  fontWeight: number;
  align: 'left' | 'center' | 'right';
}
export interface Poster {
  width: number;
  height: number;
  background: string;
  accent: string;
  assetId?: string;
  imageBox: { x: number; y: number; width: number; height: number };
  texts: PosterText[];
  templateId: string;
}
export interface ContentVersion {
  id: string;
  projectId: string;
  kind: 'copy' | 'poster' | 'image';
  label: string;
  parentVersionId?: string;
  taskId?: string;
  copy?: CopyDraft;
  poster?: Poster;
  assetId?: string;
  inputSnapshot?: unknown;
  createdAt: string;
}
export type TaskStatus =
  'queued' | 'running' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
export interface GenerationTask {
  id: string;
  projectId: string;
  providerId: string;
  kind: 'copy' | 'image';
  status: TaskStatus;
  prompt: string;
  referenceAssetId?: string;
  parentVersionId?: string;
  attempts: number;
  upstreamTaskId?: string;
  error?: string;
  resultVersionId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectDetail {
  project: Project;
  assets: Asset[];
  versions: ContentVersion[];
  tasks: GenerationTask[];
}
export interface Template {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  color: string;
  category: string;
}
export const TEMPLATES: Template[] = [
  {
    id: 'xhs-editorial',
    name: '小红书种草图文',
    description: '封面 · 使用场景 · 产品细节',
    width: 1080,
    height: 1440,
    color: '#e8efde',
    category: '小红书',
  },
  {
    id: 'commerce-product',
    name: '商品推广主图',
    description: '清晰产品展示，突出已确认卖点',
    width: 1080,
    height: 1080,
    color: '#f4e6d6',
    category: '电商',
  },
  {
    id: 'campaign-poster',
    name: '活动预告海报',
    description: '竖版封面，品牌与活动信息',
    width: 1080,
    height: 1920,
    color: '#e8e4f4',
    category: '内容创作',
  },
];
export const EMPTY_BRIEF: Brief = {
  productName: '',
  sellingPoints: '',
  audience: '',
  price: '',
  brand: '',
  brandColor: '#244b3c',
  tone: '自然、清晰、有细节',
  platform: 'xiaohongshu',
  confirmed: false,
};
export function initialBoard(): Board {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'brief',
        type: 'content',
        position: { x: 60, y: 120 },
        data: { kind: 'brief', label: '内容简报' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 0.85 },
  };
}
export function makePoster(templateId: string, brief: Brief, assetId?: string): Poster {
  const t = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  return {
    width: t.width,
    height: t.height,
    background: t.color,
    accent: brief.brandColor,
    assetId,
    templateId: t.id,
    imageBox: { x: 90, y: 440, width: 900, height: t.height - 660 },
    texts: [
      {
        id: 'brand',
        text: brief.brand || '织作 · 日常灵感',
        x: 90,
        y: 85,
        width: 900,
        fontSize: 30,
        color: brief.brandColor,
        fontWeight: 500,
        align: 'left',
      },
      {
        id: 'headline',
        text: brief.productName || '把日常，过成喜欢的样子',
        x: 90,
        y: 180,
        width: 900,
        fontSize: 76,
        color: '#202721',
        fontWeight: 700,
        align: 'left',
      },
      {
        id: 'subline',
        text: brief.sellingPoints.split('\n')[0] || '你的产品故事，从这里开始',
        x: 90,
        y: 330,
        width: 900,
        fontSize: 34,
        color: '#586157',
        fontWeight: 400,
        align: 'left',
      },
      {
        id: 'footer',
        text: brief.price ? `价格信息：${brief.price}` : '发现值得分享的日常',
        x: 90,
        y: t.height - 130,
        width: 900,
        fontSize: 32,
        color: brief.brandColor,
        fontWeight: 500,
        align: 'left',
      },
    ],
  };
}
