import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import type { BrandKit, Project } from '../../../packages/shared/src/index';
import { api, json, message } from './api';
import { AlertDialogAction, AlertDialogCancel } from './components/ui/alert-dialog';
import { Button } from './components/ui/button';
import { Label } from './components/ui/label';
import { ConfirmModal, ErrorBox, Spinner, type Notify } from './ui';
import './brands.css';

export function BrandPicker({
  projectId,
  revision,
  beforeApply,
  onApplied,
  notify,
}: {
  projectId: string;
  revision: number;
  beforeApply?: () => Promise<number>;
  onApplied: (project: Project) => void;
  notify: Notify;
}) {
  const [brands, setBrands] = useState<BrandKit[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [confirming, setConfirming] = useState<BrandKit | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<BrandKit[]>('/brands', { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setBrands(rows);
          setSelected((id) => (rows.some((brand) => brand.id === id) ? id : ''));
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, refresh]);
  async function apply() {
    if (!confirming || busy) return;
    setBusy(true);
    try {
      const currentRevision = beforeApply ? await beforeApply() : revision;
      const project = await api<Project>(
        `/projects/${projectId}/apply-brand`,
        json('POST', { brandId: confirming.id, revision: currentRevision }),
      );
      onApplied(project);
      setConfirming(null);
      notify('品牌已应用到简报，请重新确认商品事实');
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="brand-picker">
      <div className="brand-picker-heading">
        <Palette size={17} />
        <strong>应用品牌资料</strong>
      </div>
      {loading ? (
        <Spinner label="正在载入品牌" />
      ) : error ? (
        <>
          <ErrorBox>{error}</ErrorBox>
          <Button
            type="button"
            className="button secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新加载
          </Button>
        </>
      ) : !brands.length ? (
        <p>还没有可用品牌。可先在「品牌资料库」建立资料，或继续手动编辑简报。</p>
      ) : (
        <>
          <div className="brand-picker-controls">
            <Label className="sr-only" htmlFor={`project-brand-${projectId}`}>
              选择品牌
            </Label>
            <select
              id={`project-brand-${projectId}`}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy}
            >
              <option value="">选择已保存的品牌</option>
              {brands.map((brand) => (
                <option value={brand.id} key={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              className="button secondary"
              disabled={!selected || busy}
              onClick={() => setConfirming(brands.find((brand) => brand.id === selected) ?? null)}
            >
              应用
            </Button>
          </div>
          <p>应用会更新简报中的品牌信息，并要求重新确认事实。</p>
        </>
      )}
      {confirming && (
        <ConfirmModal
          title={`应用「${confirming.name}」？`}
          description="简报中的品牌、主色、Logo、字体、语气和禁用词将更新，商品事实需要重新确认。已保存的版本与导出作品会保留。"
          onClose={() => {
            if (!busy) setConfirming(null);
          }}
        >
          <div className="brand-apply-preview">
            <i style={{ backgroundColor: confirming.primaryColor }} />
            <span>
              {confirming.name} · {confirming.fontFamily === 'serif' ? '思源宋体' : '思源黑体'}
            </span>
          </div>
          <div className="modal-actions">
            <AlertDialogCancel className="button secondary" disabled={busy}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="button primary"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void apply();
              }}
            >
              {busy ? <Spinner label="正在应用" /> : '确认应用'}
            </AlertDialogAction>
          </div>
        </ConfirmModal>
      )}
    </div>
  );
}
