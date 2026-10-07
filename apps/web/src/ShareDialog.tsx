import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Link2, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import type { ContentVersion, ShareLink } from '../../../packages/shared/src/index';
import { api, json, message } from './api';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { ErrorBox, Modal, Spinner, formatTime, type Notify } from './ui';
import './sharing.css';

export function ShareDialog({
  projectId,
  versions,
  onClose,
  notify,
}: {
  projectId: string;
  versions: ContentVersion[];
  onClose: () => void;
  notify: Notify;
}) {
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState('24');
  const [confirmed, setConfirmed] = useState(false);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [clock, setClock] = useState(Date.now());
  const listRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const linkInputs = useRef(new Map<string, HTMLInputElement>());
  const path = `/projects/${encodeURIComponent(projectId)}/shares`;
  const localOnly = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const load = useCallback(() => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setLoadError('');
    void api<ShareLink[]>(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setLinks(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [path]);
  useEffect(() => {
    load();
    return () => listRequest.current?.abort();
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      mutationRequest.current?.abort();
    };
  }, []);

  function toggleVersion(id: string) {
    setSelected((value) =>
      value.includes(id) ? value.filter((item) => item !== id) : [...value, id],
    );
    setConfirmed(false);
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationRequest.current || loading || !confirmed) return;
    const expiresHours = Number(hours);
    if (!title.trim() || title.trim().length > 120 || /\p{Cc}/u.test(title)) {
      setError('请填写 1–120 字公开标题，不含换行或控制字符。');
      return;
    }
    if (
      selected.length < 1 ||
      selected.length > 20 ||
      selected.some((id) => !versions.some((version) => version.id === id))
    ) {
      setError('请选择 1–20 个当前项目中的已保存版本。');
      return;
    }
    if (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 168) {
      setError('有效时长须为 1–168 小时的整数。');
      return;
    }
    const controller = new AbortController();
    mutationRequest.current = controller;
    setBusy('create');
    setError('');
    try {
      const link = await api<ShareLink>(path, {
        ...json('POST', { title: title.trim(), versionIds: selected, expiresHours }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      listRequest.current?.abort();
      setLoading(false);
      setLoadError('');
      setLinks((current) => [link, ...current]);
      setConfirmed(false);
      notify('只读链接已生成，可复制给需要查看的人');
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(`${message(error)}。如果请求中断，请刷新链接列表确认结果后再操作。`);
        setConfirmed(false);
      }
    } finally {
      if (!controller.signal.aborted) {
        mutationRequest.current = null;
        setBusy('');
      }
    }
  }
  async function revoke(link: ShareLink) {
    if (mutationRequest.current) return;
    const controller = new AbortController();
    mutationRequest.current = controller;
    setBusy(link.id);
    setError('');
    try {
      const updated = await api<ShareLink>(`${path}/${encodeURIComponent(link.id)}/revoke`, {
        ...json('POST'),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      listRequest.current?.abort();
      setLoading(false);
      setLoadError('');
      setLinks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      notify('分享链接已撤销');
    } catch (error) {
      if (!controller.signal.aborted) setError(`${message(error)}。请刷新链接列表确认状态。`);
    } finally {
      if (!controller.signal.aborted) {
        mutationRequest.current = null;
        setBusy('');
      }
    }
  }
  async function copy(link: ShareLink) {
    if (link.revokedAt || Date.parse(link.expiresAt) <= Date.now()) {
      setClock(Date.now());
      return;
    }
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${link.urlPath}`);
      if (mounted.current) notify('链接已复制');
    } catch {
      if (!mounted.current) return;
      linkInputs.current.get(link.id)?.focus();
      linkInputs.current.get(link.id)?.select();
      notify('请复制已选中的链接', 'error');
    }
  }

  return (
    <Modal
      title="只读分享"
      description="持有链接的人可在有效期内查看所选内容快照。"
      onClose={onClose}
      wide
    >
      <div className="share-dialog">
        <div className="share-notice">
          <ShieldCheck aria-hidden="true" size={20} />
          <p>仅展示你选定的版本。公开标题和版本内容将对持链接者可见，请先确认内容适合分享。</p>
        </div>
        {localOnly && (
          <p className="share-local-note">
            当前为本机地址，链接仅能在本机打开。供他人访问需要已配置可访问的私有部署地址。
          </p>
        )}
        <form onSubmit={create} className="share-form">
          <div className="share-field">
            <Label htmlFor="share-title">公开标题</Label>
            <Input
              id="share-title"
              value={title}
              maxLength={120}
              required
              placeholder="例如：秋季新品视觉方案"
              disabled={!!busy}
              onChange={(event) => {
                setTitle(event.target.value);
                setConfirmed(false);
              }}
            />
          </div>
          <fieldset className="share-versions" disabled={!!busy}>
            <legend>
              选择已保存版本 <span>（{selected.length}/20）</span>
            </legend>
            {versions.length ? (
              <div className="share-version-options">
                {versions.map((version) => (
                  <label key={version.id} className="share-version-option">
                    <input
                      type="checkbox"
                      checked={selected.includes(version.id)}
                      disabled={!selected.includes(version.id) && selected.length >= 20}
                      onChange={() => toggleVersion(version.id)}
                    />
                    <span>
                      <strong>{version.label}</strong>
                      <span>
                        {version.kind === 'copy'
                          ? '文案'
                          : version.kind === 'poster'
                            ? '海报'
                            : '图片'}{' '}
                        · {formatTime(version.createdAt)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="share-local-note">还没有已保存版本，请先完成并保存一份作品。</p>
            )}
          </fieldset>
          <div className="share-field share-hours">
            <Label htmlFor="share-hours">有效时长（小时）</Label>
            <Input
              id="share-hours"
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              step={1}
              required
              value={hours}
              disabled={!!busy}
              onChange={(event) => {
                setHours(event.target.value);
                setConfirmed(false);
              }}
            />
            <p>1–168 小时，最多 7 天。可随时撤销。</p>
          </div>
          <label className="share-consent">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!!busy || selected.length === 0}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>我已确认公开标题与所选版本，知晓持链接者可查看这些快照。</span>
          </label>
          {error && <ErrorBox>{error}</ErrorBox>}
          <Button
            type="submit"
            className="share-create"
            disabled={!!busy || loading || !confirmed || !selected.length || !title.trim()}
          >
            {busy === 'create' ? (
              <Spinner label="正在生成" />
            ) : (
              <>
                <Link2 aria-hidden="true" />
                生成只读链接
              </>
            )}
          </Button>
        </form>
        <section className="share-history" aria-label="已创建的分享链接">
          <div className="share-history-heading">
            <h3>已创建的链接</h3>
            <Button type="button" variant="ghost" disabled={loading || !!busy} onClick={load}>
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
          {loading ? (
            <Spinner label="正在读取链接" />
          ) : loadError ? (
            <ErrorBox>{loadError}</ErrorBox>
          ) : links.length === 0 ? (
            <p className="share-local-note">还没有创建分享链接。</p>
          ) : (
            <ul className="share-link-list">
              {links.map((link) => {
                const inactive = !!link.revokedAt || Date.parse(link.expiresAt) <= clock;
                const status = link.revokedAt ? '已撤销' : inactive ? '已过期' : '有效';
                return (
                  <li key={link.id}>
                    <div className="share-link-heading">
                      <strong>{link.title}</strong>
                      <Badge variant="outline">{status}</Badge>
                    </div>
                    <p>
                      {link.versionIds.length} 个版本 · {formatTime(link.expiresAt)} 到期
                    </p>
                    {!inactive && (
                      <Input
                        aria-label={`${link.title}的只读链接`}
                        readOnly
                        value={`${window.location.origin}${link.urlPath}`}
                        ref={(element) => {
                          if (element) linkInputs.current.set(link.id, element);
                          else linkInputs.current.delete(link.id);
                        }}
                        onFocus={(event) => event.target.select()}
                      />
                    )}
                    <div className="share-link-actions">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={inactive || !!busy}
                        onClick={() => void copy(link)}
                      >
                        <Copy aria-hidden="true" />
                        复制链接
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={inactive || !!busy}
                        onClick={() => void revoke(link)}
                      >
                        {busy === link.id ? (
                          <Spinner label="正在撤销" />
                        ) : (
                          <>
                            <Unlink aria-hidden="true" />
                            撤销链接
                          </>
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
