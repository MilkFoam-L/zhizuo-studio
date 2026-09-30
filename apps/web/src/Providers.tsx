import { Card } from './components/ui/card';
import { Field, FieldLabel, FieldDescription, FieldError } from './components/ui/field';
import { AlertDialogAction, AlertDialogCancel } from './components/ui/alert-dialog';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  CircleDot,
  Edit3,
  KeyRound,
  Link2,
  Plus,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  AsyncMapping,
  Provider,
  ProviderInput,
  ProviderKind,
} from '../../../packages/shared/src/index';
import { api, json, message } from './api';
import { ErrorBox, Modal, ConfirmModal, Spinner, Tag, type Notify } from './ui';
const MAPPING: AsyncMapping = {
  submitPath: '/images/generations',
  pollPath: '/tasks/{taskId}',
  taskIdPath: 'id',
  statusPath: 'status',
  successValue: 'succeeded',
  failureValue: 'failed',
  resultUrlPath: 'result.url',
};
const EMPTY: ProviderInput = {
  name: '',
  kind: 'openai',
  baseUrl: '',
  apiKey: '',
  textModel: '',
  imageModel: '',
  timeoutSeconds: 180,
  asyncMapping: { ...MAPPING },
};
const LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI 兼容',
  gemini: 'Gemini 原生',
  'async-json': '异步中转 JSON',
};
export function Providers({ notify }: { notify: Notify }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [form, setForm] = useState<ProviderInput>(EMPTY);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const refresh = () => {
    setLoading(true);
    api<Provider[]>('/providers')
      .then(setProviders)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);
  function edit(provider?: Provider) {
    setEditing(provider || 'new');
    setForm(
      provider
        ? { ...provider, apiKey: '', asyncMapping: provider.asyncMapping || { ...MAPPING } }
        : { ...EMPTY, asyncMapping: { ...MAPPING } },
    );
    setFormError('');
  }
  function field<K extends keyof ProviderInput>(key: K, value: ProviderInput[K]) {
    setForm((p) => ({ ...p, [key]: value }));
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      const payload: ProviderInput = {
        name: form.name.trim(),
        kind: form.kind,
        baseUrl: form.baseUrl.trim().replace(/\/$/, ''),
        textModel: form.textModel.trim(),
        imageModel: form.imageModel.trim(),
        timeoutSeconds: Number(form.timeoutSeconds),
        ...(form.apiKey?.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(form.kind === 'async-json' ? { asyncMapping: form.asyncMapping } : {}),
      };
      await api(
        `/providers${editing !== 'new' && editing ? `/${editing.id}` : ''}`,
        json(editing === 'new' ? 'POST' : 'PUT', payload),
      );
      setEditing(null);
      setForm(EMPTY);
      notify('模型服务已保存');
      refresh();
    } catch (e) {
      setFormError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function test(provider: Provider) {
    setTesting(provider.id);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        `/providers/${provider.id}/test`,
        json('POST'),
      );
      setTestResults((p) => ({ ...p, [provider.id]: result }));
      notify(result.message, result.ok ? 'success' : 'error');
    } catch (e) {
      const result = { ok: false, message: message(e) };
      setTestResults((p) => ({ ...p, [provider.id]: result }));
      notify(result.message, 'error');
    } finally {
      setTesting('');
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/providers/${deleting.id}`, json('DELETE'));
      setDeleting(null);
      notify('服务商已删除');
      refresh();
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-container settings-page">
      <header className="page-topbar">
        <div className="breadcrumbs">
          工作空间<span>/</span>模型接入
        </div>
        <span className="workspace-status">
          <i />
          密钥保存在服务端
        </span>
      </header>
      <section className="page-heading">
        <div>
          <p className="eyebrow">YOUR MODELS, YOUR WORKFLOW</p>
          <h1>连接你的创作能力</h1>
          <p className="muted">官方接口、自建服务或中转平台，选择适合你的模型。</p>
        </div>
        <Button className="button primary" onClick={() => edit()}>
          <Plus size={18} />
          添加服务商
        </Button>
      </section>
      <div className="connection-note">
        <span>
          <Link2 size={22} />
        </span>
        <div>
          <h3>一个工作台，多种模型选择</h3>
          <p>兼容文本与图片生成。每次创作都可以选择不同的服务商，模型费用由对应服务商收取。</p>
        </div>
        <Tag>3 种接入协议</Tag>
      </div>
      {loading ? (
        <div className="panel-loading">
          <Spinner />
        </div>
      ) : error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : !providers.length ? (
        <div className="provider-empty">
          <span className="empty-icon">
            <Zap size={28} strokeWidth={1.4} />
          </span>
          <h2>给灵感，接上电源</h2>
          <p>
            添加第一个模型服务商，即可从商品简报生成文案与图片。
            <br />
            暂时没有密钥？模板海报与手工文案仍然可以使用。
          </p>
          <Button className="button primary" onClick={() => edit()}>
            <Plus size={17} />
            添加第一个服务商
          </Button>
          <div className="protocol-chips">
            <span>OpenAI 兼容</span>
            <span>Gemini 原生</span>
            <span>异步中转 JSON</span>
          </div>
        </div>
      ) : (
        <div className="provider-grid">
          {providers.map((p) => (
            <Card role="article" className="provider-card" key={p.id}>
              <div className="provider-card-heading">
                <span className={`provider-icon kind-${p.kind}`}>
                  <Zap size={23} />
                </span>
                <div>
                  <h3>{p.name}</h3>
                  <Tag>{LABELS[p.kind]}</Tag>
                </div>
                <Button
                  className="icon-button"
                  aria-label={`编辑 ${p.name}`}
                  onClick={() => edit(p)}
                >
                  <Edit3 size={17} />
                </Button>
              </div>
              <dl>
                <div>
                  <dt>接口地址</dt>
                  <dd title={p.baseUrl}>{p.baseUrl}</dd>
                </div>
                <div>
                  <dt>文本模型</dt>
                  <dd>{p.textModel || '未配置'}</dd>
                </div>
                <div>
                  <dt>图片模型</dt>
                  <dd>{p.imageModel || '未配置'}</dd>
                </div>
                <div>
                  <dt>密钥状态</dt>
                  <dd>
                    <KeyRound size={13} />
                    {p.hasKey ? '已安全保存' : '未配置密钥'}
                  </dd>
                </div>
              </dl>
              {testResults[p.id] && (
                <div className={`test-result ${testResults[p.id].ok ? 'ok' : 'failed'}`}>
                  <CircleDot size={14} />
                  {testResults[p.id].message}
                </div>
              )}
              <div className="provider-actions">
                <Button
                  className="button secondary small"
                  onClick={() => test(p)}
                  disabled={!!testing}
                >
                  {testing === p.id ? (
                    <Spinner label="正在连接" />
                  ) : (
                    <>
                      <Zap size={14} />
                      测试连接
                    </>
                  )}
                </Button>
                <Button
                  className="icon-button danger-text"
                  onClick={() => setDeleting(p)}
                  aria-label={`删除 ${p.name}`}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <div className="settings-footnote">
        <ShieldCheck size={20} />
        <div>
          <strong>密钥只用于你配置的接口</strong>
          <p>
            前端不会读取已保存的完整密钥。接入前请确认服务商可信、API
            协议和模型名称正确；不同中转商的图片编辑能力可能不同。
          </p>
        </div>
      </div>
      {editing && (
        <Modal
          wide
          title={editing === 'new' ? '添加模型服务商' : `编辑 ${editing.name}`}
          description="使用服务商提供的完整 API 基础地址和模型 ID。"
          onClose={() => {
            if (!busy) {
              setEditing(null);
              setForm(EMPTY);
            }
          }}
        >
          <form onSubmit={save} className="provider-form">
            <div className="form-grid">
              <Label>
                服务商名称
                <Input
                  required
                  maxLength={80}
                  placeholder="例如：我的图片服务"
                  value={form.name}
                  onChange={(e) => field('name', e.target.value)}
                />
              </Label>
              <Label>
                接入协议
                <select
                  value={form.kind}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      kind: e.target.value as ProviderKind,
                      ...(e.target.value === 'async-json' ? { textModel: '' } : {}),
                    }))
                  }
                >
                  {Object.entries(LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </Label>
            </div>
            <Field className="provider-field">
              <FieldLabel htmlFor="provider-url">API 基础地址</FieldLabel>
              <Input
                id="provider-url"
                aria-describedby="provider-url-description"
                required
                type="url"
                placeholder={
                  form.kind === 'gemini'
                    ? 'https://generativelanguage.googleapis.com/v1beta'
                    : 'https://api.example.com/v1'
                }
                value={form.baseUrl}
                onChange={(e) => field('baseUrl', e.target.value)}
              />
              <FieldDescription id="provider-url-description">
                填到 API 版本路径，例如 /v1；不要添加 /chat/completions。
              </FieldDescription>
            </Field>
            <Label>
              API Key{editing !== 'new' && <small>留空会保留原密钥</small>}
              <Input
                type="password"
                required={editing === 'new'}
                autoComplete="new-password"
                placeholder={
                  editing !== 'new' && editing.hasKey
                    ? '•••••••• 已保存，填写可替换'
                    : '粘贴服务商密钥'
                }
                value={form.apiKey}
                onChange={(e) => field('apiKey', e.target.value)}
              />
            </Label>
            <div className="form-grid">
              <Label>
                文本模型 ID
                <Input
                  disabled={form.kind === 'async-json'}
                  placeholder={
                    form.kind === 'async-json' ? '此协议只支持图片任务' : '服务商的文本模型 ID'
                  }
                  value={form.textModel}
                  onChange={(e) => field('textModel', e.target.value)}
                />
              </Label>
              <Label>
                图片模型 ID
                <Input
                  placeholder="服务商的图片模型 ID"
                  value={form.imageModel}
                  onChange={(e) => field('imageModel', e.target.value)}
                />
              </Label>
            </div>
            <Label>
              请求超时（秒）
              <Input
                type="number"
                min={10}
                max={300}
                required
                value={form.timeoutSeconds}
                onChange={(e) => field('timeoutSeconds', Number(e.target.value))}
              />
            </Label>
            {form.kind === 'async-json' && (
              <details open className="advanced-settings">
                <summary>
                  异步任务字段映射
                  <ChevronDown size={15} />
                </summary>
                <p className="hint">
                  提交 JSON 包含 model、prompt，可选 image（完整 data
                  URL）。用点路径读取返回值；轮询路径中的 {'{taskId}'} 会替换为服务商任务
                  ID。请按服务商文档填写。
                </p>
                <div className="form-grid">
                  {(
                    [
                      'submitPath',
                      'pollPath',
                      'taskIdPath',
                      'statusPath',
                      'successValue',
                      'failureValue',
                      'resultUrlPath',
                    ] as const
                  ).map((key) => (
                    <Label key={key}>
                      {
                        {
                          submitPath: '任务提交路径',
                          pollPath: '状态轮询路径',
                          taskIdPath: '任务 ID 字段',
                          statusPath: '状态字段',
                          successValue: '成功状态值',
                          failureValue: '失败状态值',
                          resultUrlPath: '结果图片 URL 字段',
                        }[key]
                      }
                      <Input
                        required
                        value={form.asyncMapping?.[key] || ''}
                        onChange={(e) =>
                          field('asyncMapping', {
                            ...MAPPING,
                            ...form.asyncMapping,
                            [key]: e.target.value,
                          })
                        }
                      />
                    </Label>
                  ))}
                </div>
              </details>
            )}
            {formError && <FieldError className="error-box">{formError}</FieldError>}
            <div className="modal-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY);
                }}
              >
                取消
              </Button>
              <Button
                className="button primary"
                disabled={busy || (!form.textModel.trim() && !form.imageModel.trim())}
              >
                {busy ? (
                  <Spinner label="正在保存" />
                ) : (
                  <>
                    <Check size={17} />
                    保存服务商
                  </>
                )}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <ConfirmModal
          title={`删除「${deleting.name}」？`}
          description="历史内容会保留。已排队的任务使用提交时的配置继续处理；如需停止，请在项目生成记录中取消任务。"
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <div className="modal-actions">
            <AlertDialogCancel className="button secondary" disabled={busy}>
              保留
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="button danger"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              确认删除
            </AlertDialogAction>
          </div>
        </ConfirmModal>
      )}
    </div>
  );
}
