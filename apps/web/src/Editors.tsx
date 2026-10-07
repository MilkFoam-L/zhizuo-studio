import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Label } from './components/ui/label';
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Save, Trash2 } from 'lucide-react';
import type {
  Asset,
  ContentVersion,
  CopyDraft,
  Poster,
  PosterText,
} from '../../../packages/shared/src/index';
import { contentWarnings, layoutPoster } from '../../../packages/shared/src/poster-layout';
import { ErrorBox, Modal, Spinner, Tag } from './ui';
import { message } from './api';
export function CopyEditor({
  version,
  bannedTerms,
  onClose,
  onSave,
}: {
  version?: ContentVersion;
  bannedTerms?: string[];
  onClose: () => void;
  onSave: (copy: CopyDraft, label: string, parentId?: string) => Promise<void>;
}) {
  const [copy, setCopy] = useState<CopyDraft>(
    version?.copy
      ? structuredClone(version.copy)
      : { titles: [''], body: '', tags: [], pages: [{ headline: '', body: '' }], warnings: [] },
  );
  const [label, setLabel] = useState(version ? `${version.label} · 修改版` : '手工文案 · 初稿');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const warnings = contentWarnings(
    `${copy.titles.join(' ')} ${copy.body} ${copy.pages.map((p) => `${p.headline} ${p.body}`).join(' ')}`,
    bannedTerms,
  );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (
        copy.titles.filter((t) => t.trim()).length > 10 ||
        copy.titles.some((t) => t.length > 500)
      )
        throw new Error('最多 10 个标题，每个标题不超过 500 字。');
      if (copy.tags.filter((t) => t.trim()).length > 30 || copy.tags.some((t) => t.length > 100))
        throw new Error('最多 30 个标签，每个标签不超过 100 字。');
      await onSave(
        {
          ...copy,
          titles: copy.titles.map((t) => t.trim()).filter(Boolean),
          tags: copy.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
          warnings,
        },
        label.trim(),
        version?.id,
      );
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={version ? '编辑文案，保存新的版本' : '写一份新的图文文案'}
      description="标题、正文和分页内容都可以修改。保存后会在画布上新增一个版本。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={save} className="copy-editor">
        <Label>
          版本名称
          <Input
            required
            maxLength={100}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Label>
        <Label>
          备选标题 <small>每行一个，可填写多个方向</small>
          <Textarea
            required
            rows={3}
            value={copy.titles.join('\n')}
            onChange={(e) => setCopy((p) => ({ ...p, titles: e.target.value.split('\n') }))}
          />
        </Label>
        <Label>
          正文 <small>{copy.body.length} 字</small>
          <Textarea
            required
            maxLength={20000}
            rows={8}
            placeholder="用真实体验和已确认的信息，讲清楚产品的价值。"
            value={copy.body}
            onChange={(e) => setCopy((p) => ({ ...p, body: e.target.value }))}
          />
        </Label>
        <Label>
          话题标签 <small>用空格分隔</small>
          <Input
            placeholder="生活好物 居家日常"
            value={copy.tags.join(' ')}
            onChange={(e) => setCopy((p) => ({ ...p, tags: e.target.value.split(/\s+/) }))}
          />
        </Label>
        <div className="inline-heading">
          <h3>图文分页大纲</h3>
          <Button
            type="button"
            className="text-button"
            disabled={copy.pages.length >= 20}
            onClick={() =>
              setCopy((p) => ({ ...p, pages: [...p.pages, { headline: '', body: '' }] }))
            }
          >
            <Plus size={15} />
            增加一页
          </Button>
        </div>
        {copy.pages.map((page, index) => (
          <div className="page-outline" key={index}>
            <div>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div className="page-order-actions">
                <Button
                  type="button"
                  className="icon-button"
                  disabled={index === 0}
                  aria-label={`第 ${index + 1} 页上移`}
                  onClick={() =>
                    setCopy((p) => {
                      const pages = [...p.pages];
                      [pages[index - 1], pages[index]] = [pages[index], pages[index - 1]];
                      return { ...p, pages };
                    })
                  }
                >
                  <ArrowUp size={14} />
                </Button>
                <Button
                  type="button"
                  className="icon-button"
                  disabled={index === copy.pages.length - 1}
                  aria-label={`第 ${index + 1} 页下移`}
                  onClick={() =>
                    setCopy((p) => {
                      const pages = [...p.pages];
                      [pages[index + 1], pages[index]] = [pages[index], pages[index + 1]];
                      return { ...p, pages };
                    })
                  }
                >
                  <ArrowDown size={14} />
                </Button>
                <Button
                  type="button"
                  aria-label={`删除第 ${index + 1} 页`}
                  className="icon-button"
                  onClick={() =>
                    setCopy((p) => ({ ...p, pages: p.pages.filter((_, i) => i !== index) }))
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
            <Label>
              本页标题
              <Input
                maxLength={500}
                value={page.headline}
                onChange={(e) =>
                  setCopy((p) => ({
                    ...p,
                    pages: p.pages.map((v, i) =>
                      i === index ? { ...v, headline: e.target.value } : v,
                    ),
                  }))
                }
              />
            </Label>
            <Label>
              本页内容
              <Textarea
                maxLength={3000}
                rows={2}
                value={page.body}
                onChange={(e) =>
                  setCopy((p) => ({
                    ...p,
                    pages: p.pages.map((v, i) =>
                      i === index ? { ...v, body: e.target.value } : v,
                    ),
                  }))
                }
              />
            </Label>
          </div>
        ))}
        {warnings.length > 0 && (
          <div className="quality-warning">
            <strong>发布前请核实</strong>
            {warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="modal-actions">
          <Button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            className="button primary"
            disabled={busy || !copy.titles.some((t) => t.trim()) || !copy.body.trim()}
          >
            {busy ? (
              <Spinner label="正在保存" />
            ) : (
              <>
                <Save size={16} />
                保存新版本
              </>
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function PosterPreview({
  poster,
  assets,
  selectedText,
  onSelect,
}: {
  poster: Poster;
  assets: Asset[];
  selectedText?: string;
  onSelect?: (id: string) => void;
}) {
  const layout = useMemo(() => layoutPoster(poster), [poster]);
  const asset = assets.find((a) => a.id === poster.assetId);
  const fontFamily =
    poster.fontFamily === 'serif' ? 'Noto Serif SC,serif' : 'Noto Sans SC,sans-serif';
  return (
    <svg
      className="poster-svg"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${poster.width} ${poster.height}`}
      role="img"
      aria-label="海报排版预览"
    >
      <rect width={poster.width} height={poster.height} fill={poster.background} />
      {asset ? (
        <image
          href={asset.url || `/api/assets/${asset.id}/content`}
          x={poster.imageBox.x}
          y={poster.imageBox.y}
          width={poster.imageBox.width}
          height={poster.imageBox.height}
          preserveAspectRatio="xMidYMid meet"
        />
      ) : null}
      {poster.logoAssetId && poster.logoBox ? (
        <image
          href={`/api/assets/${poster.logoAssetId}/content`}
          x={poster.logoBox.x}
          y={poster.logoBox.y}
          width={poster.logoBox.width}
          height={poster.logoBox.height}
          preserveAspectRatio="xMidYMid meet"
        />
      ) : null}
      {poster.texts.map((t) =>
        selectedText === t.id ? (
          <rect
            key={t.id}
            x={t.x - 8}
            y={t.y - 8}
            width={t.width + 16}
            height={Math.max(
              t.fontSize * 1.5,
              layout.lines.filter((l) => l.id.startsWith(`${t.id}-`)).length * t.fontSize * 1.35 +
                12,
            )}
            fill="transparent"
            stroke="#78689a"
            strokeDasharray="10 6"
            strokeWidth={3}
          />
        ) : null,
      )}
      {layout.lines.map((line) => (
        <text
          key={line.id}
          x={line.x}
          y={line.y}
          fontFamily={fontFamily}
          fontSize={line.fontSize}
          fontWeight={line.fontWeight}
          fill={line.color}
          textAnchor={line.anchor}
          style={{ cursor: onSelect ? 'pointer' : undefined }}
          onClick={() => onSelect?.(line.id.substring(0, line.id.lastIndexOf('-')))}
        >
          {line.text}
        </text>
      ))}
    </svg>
  );
}
export function PosterEditor({
  version,
  assets,
  onClose,
  onSave,
}: {
  version: ContentVersion;
  assets: Asset[];
  onClose: () => void;
  onSave: (poster: Poster, label: string, parentId: string) => Promise<void>;
}) {
  const [poster, setPoster] = useState<Poster>(structuredClone(version.poster!));
  const [active, setActive] = useState(poster.texts[0]?.id || '');
  const [label, setLabel] = useState(`${version.label} · 修改版`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const item = poster.texts.find((t) => t.id === active);
  const warnings = layoutPoster(poster).warnings;
  function patchText<K extends keyof PosterText>(key: K, value: PosterText[K]) {
    setPoster((p) => ({
      ...p,
      texts: p.texts.map((t) => (t.id === active ? { ...t, [key]: value } : t)),
    }));
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await onSave(poster, label.trim(), version.id);
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title="调整海报的每个细节"
      description="点击预览中的文字选择图层。预览与导出使用相同的换行规则。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="poster-editor">
        <div className="poster-edit-preview">
          <PosterPreview
            poster={poster}
            assets={assets}
            selectedText={active}
            onSelect={setActive}
          />
          <span>
            {poster.width} × {poster.height} px
          </span>
        </div>
        <div className="poster-edit-controls">
          <Label>
            版本名称
            <Input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Label>
          <Label>
            商品素材
            <select
              value={poster.assetId || ''}
              onChange={(e) => setPoster((p) => ({ ...p, assetId: e.target.value || undefined }))}
            >
              <option value="">不使用图片</option>
              {assets.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Label>
          <Label>
            海报字体
            <select
              value={poster.fontFamily ?? 'sans'}
              onChange={(e) =>
                setPoster((p) => ({ ...p, fontFamily: e.target.value as Poster['fontFamily'] }))
              }
            >
              <option value="sans">思源黑体</option>
              <option value="serif">思源宋体</option>
            </select>
          </Label>
          {poster.logoAssetId && poster.logoBox && (
            <>
              <div className="inline-heading">
                <h3>品牌 Logo</h3>
              </div>
              <div className="form-grid compact">
                <Label>
                  Logo X
                  <Input
                    type="number"
                    min={0}
                    max={poster.width}
                    value={poster.logoBox.x}
                    onChange={(e) =>
                      setPoster((p) => ({
                        ...p,
                        logoBox: p.logoBox && { ...p.logoBox, x: Number(e.target.value) },
                      }))
                    }
                  />
                </Label>
                <Label>
                  Logo Y
                  <Input
                    type="number"
                    min={0}
                    max={poster.height}
                    value={poster.logoBox.y}
                    onChange={(e) =>
                      setPoster((p) => ({
                        ...p,
                        logoBox: p.logoBox && { ...p.logoBox, y: Number(e.target.value) },
                      }))
                    }
                  />
                </Label>
                <Label>
                  Logo 宽
                  <Input
                    type="number"
                    min={24}
                    max={poster.width}
                    value={poster.logoBox.width}
                    onChange={(e) =>
                      setPoster((p) => ({
                        ...p,
                        logoBox: p.logoBox && { ...p.logoBox, width: Number(e.target.value) },
                      }))
                    }
                  />
                </Label>
                <Label>
                  Logo 高
                  <Input
                    type="number"
                    min={24}
                    max={poster.height}
                    value={poster.logoBox.height}
                    onChange={(e) =>
                      setPoster((p) => ({
                        ...p,
                        logoBox: p.logoBox && { ...p.logoBox, height: Number(e.target.value) },
                      }))
                    }
                  />
                </Label>
              </div>
            </>
          )}
          <Label className="color-field">
            背景颜色
            <input
              type="color"
              value={poster.background}
              onChange={(e) => setPoster((p) => ({ ...p, background: e.target.value }))}
            />
            <span>{poster.background}</span>
          </Label>
          <div className="inline-heading">
            <h3>文字图层</h3>
            <Button
              type="button"
              className="icon-button"
              aria-label="添加文字图层"
              onClick={() => {
                const id = `text-${crypto.randomUUID().slice(0, 8)}`;
                setPoster((p) => ({
                  ...p,
                  texts: [
                    ...p.texts,
                    {
                      id,
                      text: '新的文字',
                      x: 90,
                      y: 120,
                      width: 800,
                      fontSize: 40,
                      color: '#202721',
                      fontWeight: 400,
                      align: 'left',
                    },
                  ],
                }));
                setActive(id);
              }}
            >
              <Plus size={16} />
            </Button>
          </div>
          <div className="text-layer-list">
            {poster.texts.map((t) => (
              <Button
                key={t.id}
                className={active === t.id ? 'active' : ''}
                aria-pressed={active === t.id}
                onClick={() => setActive(t.id)}
              >
                T<span>{t.text || '空白文字'}</span>
              </Button>
            ))}
          </div>
          {item && (
            <>
              <Label>
                文字内容
                <Textarea
                  rows={3}
                  value={item.text}
                  onChange={(e) => patchText('text', e.target.value)}
                />
              </Label>
              <div className="form-grid compact">
                <Label>
                  X 位置
                  <Input
                    type="number"
                    min={0}
                    max={poster.width}
                    value={item.x}
                    onChange={(e) => patchText('x', Number(e.target.value))}
                  />
                </Label>
                <Label>
                  Y 位置
                  <Input
                    type="number"
                    min={0}
                    max={poster.height}
                    value={item.y}
                    onChange={(e) => patchText('y', Number(e.target.value))}
                  />
                </Label>
                <Label>
                  字号
                  <Input
                    type="number"
                    min={12}
                    max={200}
                    value={item.fontSize}
                    onChange={(e) => patchText('fontSize', Number(e.target.value))}
                  />
                </Label>
                <Label>
                  文字框宽
                  <Input
                    type="number"
                    min={50}
                    max={poster.width}
                    value={item.width}
                    onChange={(e) => patchText('width', Number(e.target.value))}
                  />
                </Label>
                <Label>
                  对齐
                  <select
                    value={item.align}
                    onChange={(e) => patchText('align', e.target.value as PosterText['align'])}
                  >
                    <option value="left">左对齐</option>
                    <option value="center">居中</option>
                    <option value="right">右对齐</option>
                  </select>
                </Label>
                <Label>
                  字重
                  <select
                    value={item.fontWeight}
                    onChange={(e) => patchText('fontWeight', Number(e.target.value))}
                  >
                    <option value={400}>常规</option>
                    <option value={500}>中等</option>
                    <option value={700}>加粗</option>
                  </select>
                </Label>
              </div>
              <Label className="color-field">
                文字颜色
                <input
                  type="color"
                  value={item.color}
                  onChange={(e) => patchText('color', e.target.value)}
                />
                <span>{item.color}</span>
              </Label>
              <Button
                className="text-button danger-text"
                onClick={() => {
                  setPoster((p) => ({ ...p, texts: p.texts.filter((t) => t.id !== active) }));
                  setActive('');
                }}
              >
                <Trash2 size={14} />
                删除这个文字图层
              </Button>
            </>
          )}
          {warnings.length > 0 && (
            <div className="quality-warning">
              {warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
        </div>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      <div className="modal-actions">
        <Button className="button secondary" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button className="button primary" onClick={save} disabled={busy || !label.trim()}>
          {busy ? (
            <Spinner label="正在保存" />
          ) : (
            <>
              <Check size={16} />
              保存新版本
            </>
          )}
        </Button>
      </div>
    </Modal>
  );
}
export function VersionCompare({
  current,
  parent,
  assets,
  onClose,
}: {
  current: ContentVersion;
  parent?: ContentVersion;
  assets: Asset[];
  onClose: () => void;
}) {
  return (
    <Modal
      wide
      title="版本对比"
      description="比较内容的来源版本与本次迭代。每一版独立保留，可分别导出。"
      onClose={onClose}
    >
      <div className="compare-grid">
        {[parent, current].map((v, index) => {
          const imageAsset = assets.find((asset) => asset.id === v?.assetId);
          return (
            <div className="compare-pane" key={index}>
              <div className="compare-heading">
                <Tag>{index === 0 ? '来源版本' : '当前版本'}</Tag>
                <h3>{v?.label || '这是初始版本'}</h3>
              </div>
              {v?.copy ? (
                <div className="compare-copy">
                  <strong>{v.copy.titles[0]}</strong>
                  <p>{v.copy.body}</p>
                  <div className="node-tags">
                    {v.copy.tags.map((t, i) => (
                      <span key={i}>#{t}</span>
                    ))}
                  </div>
                  {v.copy.pages.map((p, i) => (
                    <p key={i}>
                      <strong>
                        {i + 1}. {p.headline}
                      </strong>
                      <br />
                      {p.body}
                    </p>
                  ))}
                </div>
              ) : v?.poster ? (
                <img
                  src={`/api/versions/${v.id}/preview`}
                  alt={v.label}
                  width={v.poster.width}
                  height={v.poster.height}
                />
              ) : v?.assetId ? (
                <img
                  src={`/api/assets/${v.assetId}/content`}
                  alt={v.label}
                  width={imageAsset?.width}
                  height={imageAsset?.height}
                />
              ) : (
                <div className="empty-compare">后续修改将保留完整的版本来源。</div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
