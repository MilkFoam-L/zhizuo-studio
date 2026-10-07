import { useEffect, useState } from 'react';
import { Archive, Check, Edit3, ImagePlus, Palette, Plus, RotateCcw } from 'lucide-react';
import type { BrandInput, BrandKit } from '../../../packages/shared/src/index';
import { api, ApiError, json, message } from './api';
import { AlertDialogAction, AlertDialogCancel } from './components/ui/alert-dialog';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Textarea } from './components/ui/textarea';
import { ConfirmModal, ErrorBox, Modal, Spinner, Tag, type Notify } from './ui';
import './brands.css';

const EMPTY: BrandInput = {
  name: '',
  primaryColor: '#244b3c',
  secondaryColor: '#e8efde',
  tone: '自然、清晰、有细节',
  bannedTerms: [],
  fontFamily: 'sans',
};
const fontName = { sans: '思源黑体', serif: '思源宋体' };
function fields(brand: BrandInput): BrandInput {
  return {
    name: brand.name,
    primaryColor: brand.primaryColor,
    secondaryColor: brand.secondaryColor,
    tone: brand.tone,
    bannedTerms: [...brand.bannedTerms],
    fontFamily: brand.fontFamily,
  };
}

export function Brands({ notify }: { notify: Notify }) {
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<BrandKit | 'new' | null>(null);
  const [form, setForm] = useState<BrandInput>(EMPTY);
  const [terms, setTerms] = useState('');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [formError, setFormError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [archiving, setArchiving] = useState<BrandKit | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<BrandKit[]>(`/brands${showArchived ? '?archived=true' : ''}`, { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setBrands(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, showArchived]);

  function edit(brand?: BrandKit) {
    setEditing(brand ?? 'new');
    setForm(fields(brand ?? EMPTY));
    setTerms(brand?.bannedTerms.join('\n') ?? '');
    setLogoFile(null);
    setFormError('');
    setConflict(false);
  }
  function field<K extends keyof BrandInput>(key: K, value: BrandInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const bannedTerms = terms
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (bannedTerms.length > 100 || bannedTerms.some((term) => term.length > 80)) {
      setFormError('禁用词最多 100 个，每个最多 80 字。');
      return;
    }
    setBusy(true);
    setFormError('');
    let saved: BrandKit | undefined;
    try {
      const payload = { ...form, name: form.name.trim(), tone: form.tone.trim(), bannedTerms };
      saved = await api<BrandKit>(
        editing === 'new' ? '/brands' : `/brands/${editing.id}`,
        json(
          editing === 'new' ? 'POST' : 'PUT',
          editing === 'new' ? payload : { ...payload, revision: editing.revision },
        ),
      );
      setEditing(saved);
      if (logoFile) {
        const body = new FormData();
        body.append('file', logoFile);
        saved = await api<BrandKit>(`/brands/${saved.id}/logo`, { method: 'POST', body });
      }
      setEditing(null);
      setLogoFile(null);
      notify('品牌资料已保存');
      setRefresh((value) => value + 1);
    } catch (e) {
      setFormError(saved ? `品牌文字资料已保存，Logo 上传未完成：${message(e)}` : message(e));
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      setRefresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!archiving || busy) return;
    setBusy(true);
    try {
      await api(
        `/brands/${archiving.id}/archive`,
        json('PATCH', { archived: !archiving.archivedAt }),
      );
      notify(archiving.archivedAt ? '品牌已恢复，可以重新应用' : '品牌已归档');
      setArchiving(null);
      setRefresh((value) => value + 1);
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-container settings-page brands-page">
      <header className="page-topbar">
        <div className="breadcrumbs">
          工作空间<span>/</span>品牌资料库
        </div>
        <span className="workspace-status">
          <i />
          当前空间专属
        </span>
      </header>
      <section className="page-heading">
        <div>
          <h1>品牌资料库</h1>
          <p className="muted">保存 Logo、颜色与表达习惯，在内容简报中按需应用。</p>
        </div>
        <Button className="button primary" onClick={() => edit()}>
          <Plus size={18} />
          新建品牌
        </Button>
      </section>
      <div className="brands-toolbar">
        <p>品牌更新后，已保存的项目和作品保留原样。</p>
        <label className="brands-archive-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          显示已归档品牌
        </label>
      </div>
      {loading ? (
        <div className="panel-loading">
          <Spinner label="正在载入品牌" />
        </div>
      ) : error ? (
        <div className="brands-error">
          <ErrorBox>{error}</ErrorBox>
          <Button className="button secondary" onClick={() => setRefresh((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      ) : !brands.length ? (
        <Card className="brands-empty">
          <Palette size={30} />
          <h2>{showArchived ? '还没有品牌资料' : '还没有可用品牌'}</h2>
          <p>建立一份品牌资料，让每次创作使用一致的颜色和语气。</p>
          <Button className="button primary" onClick={() => edit()}>
            <Plus size={17} />
            新建品牌
          </Button>
        </Card>
      ) : (
        <div className="brands-grid">
          {brands.map((brand) => (
            <Card
              role="article"
              className={`brand-card ${brand.archivedAt ? 'brand-card-archived' : ''}`}
              key={brand.id}
            >
              <div className="brand-card-heading">
                <div className="brand-logo">
                  {brand.logoAssetId ? (
                    <img
                      src={`/api/brands/${brand.id}/logo?v=${brand.revision}`}
                      alt={`${brand.name} Logo`}
                    />
                  ) : (
                    <Palette size={25} />
                  )}
                </div>
                <div className="brand-card-title">
                  <h2>{brand.name}</h2>
                  <Tag>{brand.archivedAt ? '已归档' : fontName[brand.fontFamily]}</Tag>
                </div>
              </div>
              <div className="brand-colors">
                <span>
                  <i style={{ backgroundColor: brand.primaryColor }} />
                  主色 {brand.primaryColor}
                </span>
                <span>
                  <i style={{ backgroundColor: brand.secondaryColor }} />
                  辅助色 {brand.secondaryColor}
                </span>
              </div>
              <p className="brand-tone">{brand.tone || '暂未设置品牌语气'}</p>
              <p className="brand-terms-summary">
                {brand.bannedTerms.length
                  ? `${brand.bannedTerms.length} 个禁用词 · ${brand.bannedTerms.slice(0, 3).join('、')}`
                  : '暂未设置禁用词'}
              </p>
              <div className="brand-card-actions">
                <Button className="button secondary" onClick={() => edit(brand)}>
                  <Edit3 size={15} />
                  编辑资料
                </Button>
                <Button className="button ghost" onClick={() => setArchiving(brand)}>
                  {brand.archivedAt ? <RotateCcw size={15} /> : <Archive size={15} />}
                  {brand.archivedAt ? '恢复' : '归档'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <Modal
          wide
          title={editing === 'new' ? '新建品牌资料' : `编辑 ${editing.name}`}
          description="保存后，可在项目简报中选择应用这个品牌。"
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form className="brand-form" onSubmit={save}>
            <Label htmlFor="brand-name">
              品牌名称
              <Input
                id="brand-name"
                required
                maxLength={80}
                value={form.name}
                onChange={(e) => field('name', e.target.value)}
                placeholder="例如：山间日常"
                disabled={busy}
              />
            </Label>
            <div className="brand-color-fields">
              {(['primaryColor', 'secondaryColor'] as const).map((key) => (
                <Label htmlFor={`brand-${key}`} key={key}>
                  {key === 'primaryColor' ? '品牌主色' : '辅助色'}
                  <div className="brand-color-input">
                    <Input
                      aria-label={`${key === 'primaryColor' ? '主色' : '辅助色'}拾色器`}
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(form[key]) ? form[key] : '#000000'}
                      onChange={(e) => field(key, e.target.value)}
                      disabled={busy}
                    />
                    <Input
                      id={`brand-${key}`}
                      required
                      pattern="#[0-9a-fA-F]{6}"
                      maxLength={7}
                      value={form[key]}
                      onChange={(e) => field(key, e.target.value)}
                      disabled={busy}
                      placeholder="#244b3c"
                    />
                  </div>
                </Label>
              ))}
            </div>
            <Label htmlFor="brand-font">
              品牌字体
              <select
                id="brand-font"
                value={form.fontFamily}
                onChange={(e) => field('fontFamily', e.target.value as BrandInput['fontFamily'])}
                disabled={busy}
              >
                <option value="sans">思源黑体 · 清晰现代</option>
                <option value="serif">思源宋体 · 温和典雅</option>
              </select>
            </Label>
            <Label htmlFor="brand-tone">
              表达语气
              <Textarea
                id="brand-tone"
                rows={3}
                maxLength={1000}
                value={form.tone}
                onChange={(e) => field('tone', e.target.value)}
                disabled={busy}
                placeholder="例如：自然、清晰；以日常使用细节表达价值。"
              />
            </Label>
            <Label htmlFor="brand-banned-terms">
              禁用词
              <Textarea
                id="brand-banned-terms"
                rows={4}
                maxLength={8099}
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                disabled={busy}
                aria-describedby="brand-terms-help"
                placeholder={'每行一个，例如：\n绝对有效\n全网最低'}
              />
              <span className="hint" id="brand-terms-help">
                每行一个，最多 100 个，每个最多 80 字。生成文案时会带入这些约束。
              </span>
            </Label>
            <div className="brand-logo-field">
              {editing !== 'new' && editing.logoAssetId && (
                <div className="brand-logo">
                  <img
                    src={`/api/brands/${editing.id}/logo?v=${editing.revision}`}
                    alt="当前品牌 Logo"
                  />
                </div>
              )}
              <Label htmlFor="brand-logo-file">
                <span className="brand-file-label">
                  <ImagePlus size={17} />
                  {editing !== 'new' && editing.logoAssetId ? '替换 Logo' : '上传 Logo'}
                </span>
                <Input
                  id="brand-logo-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  disabled={busy}
                  aria-describedby="brand-logo-help"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    if (file && file.size > 4 * 1024 * 1024) {
                      setFormError('Logo 不能超过 4 MiB。');
                      e.target.value = '';
                      setLogoFile(null);
                      return;
                    }
                    setLogoFile(file);
                    setFormError('');
                  }}
                />
                <span className="hint" id="brand-logo-help">
                  静态 PNG、JPG、WebP 或 AVIF，最多 4 MiB；建议使用透明底图。
                  {logoFile ? `已选择：${logoFile.name}` : ''}
                </span>
              </Label>
            </div>
            {formError && <ErrorBox>{formError}</ErrorBox>}
            {conflict && (
              <p className="brand-conflict-note">
                输入仍保留在此表单中。请先复制需要保留的修改，再关闭弹窗并重新打开最新资料。
              </p>
            )}
            <div className="modal-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                className="button primary"
                disabled={busy || conflict || !form.name.trim()}
              >
                {busy ? (
                  <Spinner label="正在保存" />
                ) : (
                  <>
                    <Check size={17} />
                    保存品牌
                  </>
                )}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {archiving && (
        <ConfirmModal
          title={
            archiving.archivedAt ? `恢复「${archiving.name}」？` : `归档「${archiving.name}」？`
          }
          description={
            archiving.archivedAt
              ? '恢复后，这个品牌会重新出现在项目的品牌选择列表中。'
              : '归档后无法再应用到新项目。已经使用它的项目和作品会保留，可以随时恢复品牌。'
          }
          onClose={() => {
            if (!busy) setArchiving(null);
          }}
        >
          <div className="modal-actions">
            <AlertDialogCancel className="button secondary" disabled={busy}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="button primary"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void archive();
              }}
            >
              {busy ? <Spinner label="正在保存" /> : archiving.archivedAt ? '确认恢复' : '确认归档'}
            </AlertDialogAction>
          </div>
        </ConfirmModal>
      )}
    </div>
  );
}
