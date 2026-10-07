import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, RefreshCw, Send } from 'lucide-react';
import type { AutomationRun, ProjectDetail, Provider } from '../../../packages/shared/src/index';
import { api, json, message } from './api';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { ErrorBox, Modal, Spinner, Tag, formatTime, type Notify } from './ui';

const statusLabels: Record<AutomationRun['status'], string> = {
  reviewing: '草稿待确认',
  generating: '图片生成中',
  ready: '待发布确认',
  publishing: '正在发布',
  published: '已发布',
  failed: '失败',
  cancelled: '已取消',
};
const imageStatusLabels: Record<AutomationImage['status'], string> = {
  pending: '等待中',
  generating: '生成中',
  done: '已完成',
  failed: '失败',
};
interface AutomationImage {
  id: string;
  prompt: string;
  taskId?: string;
  versionId?: string;
  attempts: number;
  status: 'pending' | 'generating' | 'done' | 'failed';
  feedback?: string;
}

export function AutomationPanel({
  project,
  providers,
  detail,
  notify,
  onClose,
  onResultAdded,
}: {
  project: { id: string };
  providers: Provider[];
  detail?: ProjectDetail;
  notify: Notify;
  onClose: () => void;
  onResultAdded: () => void;
}) {
  const assistantProviders = providers.filter((p) => p.assistantModel);
  const [idea, setIdea] = useState('');
  const [imageCount, setImageCount] = useState(1);
  const [providerId, setProviderId] = useState(assistantProviders[0]?.id ?? '');
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string; enabled: boolean }[]>(
    [],
  );
  const [mcpServerId, setMcpServerId] = useState('');
  const [visibility, setVisibility] = useState('公开可见');
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const loadRuns = useCallback(async () => {
    try {
      const runs = await api<AutomationRun[]>(`/projects/${project.id}/automation`);
      const active =
        runs.find((item) => !['published', 'cancelled'].includes(item.status)) ?? runs[0] ?? null;
      setRun(active);
      if (active?.status === 'generating') {
        clearInterval(pollRef.current);
        pollRef.current = setInterval(() => void loadRuns(), 2500);
      } else clearInterval(pollRef.current);
      if (active && active.status === 'ready' && !run) onResultAdded();
    } catch (e) {
      setError(message(e));
    }
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadRuns();
    api<{ id: string; name: string; enabled: boolean }[]>('/mcp-servers')
      .then((servers) => {
        setMcpServers(servers);
        setMcpServerId((current) => current || servers.find((s) => s.enabled)?.id || '');
      })
      .catch(() => {});
    return () => clearInterval(pollRef.current);
  }, [loadRuns]);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<AutomationRun>(
        `/projects/${project.id}/automation`,
        json('POST', {
          idea,
          imageCount,
          providerId,
        }),
      );
      setRun(created);
      notify('自动化已启动，生图任务创建后可关闭页面等待');
      await loadRuns();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function regenerate(image: AutomationImage) {
    if (busy || !run) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<AutomationRun>(
        `/projects/${project.id}/automation/${run.id}/regenerate`,
        json('POST', {
          imageId: image.id,
          ...(feedback[image.id] ? { feedback: feedback[image.id] } : {}),
          providerId: run.providerId,
        }),
      );
      setRun(updated);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (busy || !run) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<AutomationRun>(
        `/projects/${project.id}/automation/${run.id}/publish`,
        json('POST', { mcpServerId, visibility }),
      );
      setRun(updated);
      notify(`已发布：${updated.publish?.response || '完成'}`);
      onResultAdded();
    } catch (e) {
      setError(message(e));
      await loadRuns();
    } finally {
      setBusy(false);
    }
  }
  async function cancelRun() {
    if (busy || !run) return;
    setBusy(true);
    try {
      const updated = await api<AutomationRun>(
        `/projects/${project.id}/automation/${run.id}`,
        json('DELETE'),
      );
      setRun(updated);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const versionById = new Map((detail?.versions ?? []).map((v) => [v.id, v]));
  const assetById = new Map((detail?.assets ?? []).map((a) => [a.id, a]));
  const hasAssistant = assistantProviders.length > 0;

  return (
    <Modal
      wide
      title="自动化：想法 → 生图 → 发布"
      description="助手模型生成文案与配图提示词并自动生图；发布前需要你确认。需在「模型接入」配置助手模型，并部署发布通道 (MCP)。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {!hasAssistant && (
        <ErrorBox>
          尚未配置助手模型：请在「模型接入」为服务商填写助手模型 ID（需支持工具调用）。
        </ErrorBox>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      {run ? (
        <div className="automation-run">
          <div className="automation-run-head">
            <Tag tone={run.status === 'published' ? 'green' : run.status === 'failed' ? 'red' : ''}>
              {statusLabels[run.status]}
            </Tag>
            <span>创建于 {formatTime(run.createdAt)}</span>
            {['reviewing', 'ready', 'generating', 'failed'].includes(run.status) && (
              <Button variant="ghost" className="text-button" disabled={busy} onClick={cancelRun}>
                取消流程
              </Button>
            )}
          </div>
          <Card className="automation-card">
            <h3>想法</h3>
            <p>{run.idea}</p>
            <h3>文案草稿</h3>
            <p className="automation-title">{run.draft.title}</p>
            <p className="automation-content">{run.draft.content}</p>
            {run.draft.tags.length > 0 && (
              <p className="automation-tags">{run.draft.tags.map((tag) => `#${tag}`).join('  ')}</p>
            )}
          </Card>
          <Card className="automation-card">
            <h3>配图（{run.draft.images.length}）</h3>
            {run.draft.images.map((image) => {
              const version = image.versionId ? versionById.get(image.versionId) : undefined;
              const asset = version?.assetId ? assetById.get(version.assetId) : undefined;
              return (
                <div key={image.id} className="automation-image">
                  {asset ? (
                    <img
                      src={asset.thumbnailUrl}
                      alt={image.prompt.slice(0, 20)}
                      width={72}
                      height={72}
                    />
                  ) : (
                    <div className="automation-image-placeholder">
                      {image.status === 'generating' ? <Spinner label="生成中" /> : '—'}
                    </div>
                  )}
                  <div className="automation-image-info">
                    <Tag
                      tone={
                        image.status === 'done' ? 'green' : image.status === 'failed' ? 'red' : ''
                      }
                    >
                      {imageStatusLabels[image.status]} · 第 {image.attempts} 次
                    </Tag>
                    <p>{image.prompt.slice(0, 80)}…</p>
                    {image.status === 'done' && (
                      <Input
                        placeholder="调整要求（可选），如：颜色再浅一点"
                        value={feedback[image.id] ?? ''}
                        maxLength={500}
                        onChange={(e) =>
                          setFeedback((current) => ({ ...current, [image.id]: e.target.value }))
                        }
                      />
                    )}
                  </div>
                  {image.status === 'done' && run.status === 'ready' && (
                    <Button variant="outline" disabled={busy} onClick={() => regenerate(image)}>
                      <RefreshCw size={14} />
                      重新生成
                    </Button>
                  )}
                </div>
              );
            })}
          </Card>
          {run.status === 'ready' && (
            <Card className="automation-card">
              <h3>发布确认</h3>
              <p className="hint">
                发布通过你部署的小红书发布通道 (MCP)
                执行，使用你的登录态操作真实账号；发布后不可撤回。
              </p>
              <div className="form-grid">
                <Label>
                  发布通道
                  <select value={mcpServerId} onChange={(e) => setMcpServerId(e.target.value)}>
                    <option value="">选择发布通道</option>
                    {mcpServers.map((server) => (
                      <option key={server.id} value={server.id} disabled={!server.enabled}>
                        {server.name}
                        {server.enabled ? '' : '（已停用）'}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label>
                  可见范围
                  <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    <option>公开可见</option>
                    <option>仅自己可见</option>
                    <option>仅互关好友可见</option>
                  </select>
                </Label>
              </div>
              <Button className="button primary" disabled={busy || !mcpServerId} onClick={publish}>
                {busy ? <Spinner label="正在发布" /> : <Send size={15} />}
                确认发布
              </Button>
              {!mcpServers.length && (
                <p className="hint">尚未配置发布通道：请在「模型接入 → 发布通道 (MCP)」添加。</p>
              )}
            </Card>
          )}
          {run.publish && (
            <Card className="automation-card">
              <h3>发布回执</h3>
              <p>
                {formatTime(run.publish.at)} · {run.publish.serverName} · {run.publish.visibility}
              </p>
              <p>{run.publish.response}</p>
            </Card>
          )}
          <div className="modal-actions">
            <Button className="button secondary" onClick={onClose} disabled={busy}>
              关闭
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={start}>
          {!assistantProviders.length && null}
          <Label>
            你的想法
            <Input
              required
              minLength={2}
              maxLength={2000}
              placeholder="例如：给这款棉布包写一篇秋日上新笔记，温馨家居风配图"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
            />
          </Label>
          <div className="form-grid">
            <Label>
              助手模型（服务商）
              <select required value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                <option value="">选择已配置助手模型的服务商</option>
                {assistantProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.assistantModel}
                  </option>
                ))}
              </select>
            </Label>
            <Label>
              配图数量
              <select value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))}>
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count} 张
                  </option>
                ))}
              </select>
            </Label>
          </div>
          <p className="hint">
            自动化会按当前简报生成文案草稿并创建生图任务（每张预占 1
            次额度）；完成后回到这里确认发布。
            {hasAssistant ? '' : ' 需要先配置助手模型。'}
          </p>
          <div className="modal-actions">
            <Button type="button" className="button secondary" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button className="button primary" disabled={busy || !idea.trim() || !providerId}>
              {busy ? <Spinner label="正在编排" /> : <Bot size={16} />}
              启动自动化
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
