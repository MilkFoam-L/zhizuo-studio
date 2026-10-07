import { z } from 'zod';
const short = z.string().max(300);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
export const briefSchema = z.object({
  productName: short,
  sellingPoints: z.string().max(4000),
  audience: short,
  price: short,
  brand: short,
  brandColor: color,
  tone: z.string().max(1000),
  platform: z.enum(['xiaohongshu', 'commerce', 'douyin']),
  confirmed: z.boolean(),
  brandKitId: z.string().uuid().optional(),
  brandKitRevision: z.number().int().positive().optional(),
  logoAssetId: z.string().uuid().optional(),
  fontFamily: z.enum(['sans', 'serif']).optional(),
  bannedTerms: z.array(z.string().min(1).max(80)).max(100).optional(),
});
export const boardSchema = z
  .object({
    schemaVersion: z.literal(1),
    viewport: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.05).max(10),
    }),
    nodes: z
      .array(
        z.object({
          id: short,
          type: z.literal('content'),
          parentId: short.optional(),
          width: z.number().min(100).max(6000).optional(),
          height: z.number().min(100).max(6000).optional(),
          position: z.object({ x: z.number().finite(), y: z.number().finite() }),
          data: z.object({
            kind: z.enum([
              'brief',
              'asset',
              'copy',
              'poster',
              'image',
              'prompt',
              'generation',
              'annotation',
              'group',
            ]),
            label: short,
            assetId: short.optional(),
            versionId: short.optional(),
            taskId: z.string().uuid().optional(),
            taskSnapshot: z
              .object({
                kind: z.enum(['copy', 'image']),
                status: z.enum([
                  'queued',
                  'running',
                  'reconciling',
                  'succeeded',
                  'failed',
                  'cancelled',
                ]),
                createdAt: z.string().datetime(),
                resultVersionId: z.string().uuid().optional(),
              })
              .optional(),
            text: z.string().max(8000).optional(),
            color: color.optional(),
            reviewStatus: z.enum(['open', 'resolved']).optional(),
          }),
        }),
      )
      .max(2000),
    edges: z
      .array(
        z.object({
          id: short,
          source: short,
          target: short,
          label: short.optional(),
          kind: z.enum(['uses', 'derived_from', 'variant_of', 'reviewed_by']).optional(),
        }),
      )
      .max(5000),
  })
  .superRefine((board, ctx) => {
    const nodes = new Map(board.nodes.map((n) => [n.id, n]));
    if (nodes.size !== board.nodes.length) ctx.addIssue({ code: 'custom', message: '节点ID重复' });
    if (new Set(board.edges.map((e) => e.id)).size !== board.edges.length)
      ctx.addIssue({ code: 'custom', message: '连线ID重复' });
    for (const node of board.nodes) {
      if (node.parentId) {
        const parent = nodes.get(node.parentId);
        if (
          !parent ||
          parent.id === node.id ||
          parent.data.kind !== 'group' ||
          parent.parentId ||
          node.data.kind === 'group'
        )
          ctx.addIssue({ code: 'custom', message: '仅支持单层分组，父节点必须为根分组' });
      }
      if (node.data.kind === 'generation' && !node.data.taskId && !node.data.taskSnapshot)
        ctx.addIssue({ code: 'custom', message: '任务节点需要真实任务或历史记录' });
    }
    if (board.edges.some((e) => !nodes.has(e.source) || !nodes.has(e.target)))
      ctx.addIssue({ code: 'custom', message: '连线引用不存在的节点' });
  });
export const copySchema = z.object({
  titles: z.array(z.string().max(500)).min(1).max(10),
  body: z.string().max(20000),
  tags: z.array(z.string().max(100)).max(30),
  pages: z.array(z.object({ headline: z.string().max(500), body: z.string().max(3000) })).max(20),
  warnings: z.array(z.string().max(1000)).max(40),
});
export const posterSchema = z.object({
  fontFamily: z.enum(['sans', 'serif']).optional(),
  logoAssetId: z.string().uuid().optional(),
  logoBox: z
    .object({
      x: z.number().min(0).max(2160),
      y: z.number().min(0).max(3840),
      width: z.number().min(1).max(2160),
      height: z.number().min(1).max(3840),
    })
    .optional(),
  width: z.number().int().min(200).max(2160),
  height: z.number().int().min(200).max(3840),
  background: color,
  accent: color,
  assetId: short.optional(),
  templateId: short,
  imageBox: z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(1).max(2160),
    height: z.number().min(1).max(3840),
  }),
  texts: z
    .array(
      z.object({
        id: short,
        text: z.string().max(3000),
        x: z.number().finite().min(0),
        y: z.number().finite().min(0),
        width: z.number().min(1).max(2160),
        fontSize: z.number().min(10).max(200),
        color,
        fontWeight: z.number().min(100).max(900),
        align: z.enum(['left', 'center', 'right']),
      }),
    )
    .max(30),
});
