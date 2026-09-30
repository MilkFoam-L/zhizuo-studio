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
  tone: short,
  platform: z.enum(['xiaohongshu', 'commerce', 'douyin']),
  confirmed: z.boolean(),
});
export const boardSchema = z.object({
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
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        data: z.object({
          kind: z.enum(['brief', 'asset', 'copy', 'poster', 'image']),
          label: short,
          assetId: short.optional(),
          versionId: short.optional(),
        }),
      }),
    )
    .max(2000),
  edges: z
    .array(z.object({ id: short, source: short, target: short, label: short.optional() }))
    .max(5000),
});
export const copySchema = z.object({
  titles: z.array(z.string().max(500)).min(1).max(10),
  body: z.string().max(20000),
  tags: z.array(z.string().max(100)).max(30),
  pages: z.array(z.object({ headline: z.string().max(500), body: z.string().max(3000) })).max(20),
  warnings: z.array(z.string().max(1000)).max(40),
});
export const posterSchema = z.object({
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
