import type { Poster } from './index';
export interface TextLine {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  fontWeight: number;
  anchor: 'start' | 'middle' | 'end';
}
// CJK-aware conservative advances. Browser and PNG export share identical wrapping.
export function textUnits(text: string) {
  return [...text].reduce((n, c) => n + (/[\u0000-\u007f]/.test(c) ? 0.58 : 1), 0);
}
export function layoutPoster(poster: Poster): { lines: TextLine[]; warnings: string[] } {
  const lines: TextLine[] = [];
  const warnings: string[] = [];
  for (const t of poster.texts) {
    const rows: string[] = [];
    for (const paragraph of t.text.split('\n')) {
      let current = '';
      for (const char of [...paragraph]) {
        if (current && textUnits(current + char) * t.fontSize > t.width) {
          rows.push(current);
          current = char;
        } else current += char;
      }
      rows.push(current);
    }
    for (let i = 0; i < rows.length; i++) {
      const y = t.y + t.fontSize + i * t.fontSize * 1.35;
      if (y > poster.height - 32 || t.x < 32 || t.x + t.width > poster.width - 32)
        warnings.push(`${t.id} 文本超出建议安全区域`);
      lines.push({
        id: `${t.id}-${i}`,
        text: rows[i],
        x: t.align === 'center' ? t.x + t.width / 2 : t.align === 'right' ? t.x + t.width : t.x,
        y,
        fontSize: t.fontSize,
        color: t.color,
        fontWeight: t.fontWeight,
        anchor: t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start',
      });
    }
    if (rows.length > 4) warnings.push(`${t.id} 文本过长，建议精简`);
  }
  return { lines, warnings: [...new Set(warnings)] };
}
export function contentWarnings(text: string, bannedTerms: string[] = []): string[] {
  const words = ['全网最低', '第一', '最好', '顶级', '100%有效', '根治', '治愈', '稳赚', '零风险'];
  return [...new Set([...words, ...bannedTerms.filter(Boolean)])]
    .filter((w) => text.includes(w))
    .map((w) => `请核实“${w}”的事实依据和适用规则`);
}
