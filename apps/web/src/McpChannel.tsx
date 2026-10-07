import { useCallback, useEffect, useState } from 'react';
import { Plus, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import { api, json, message } from './api';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { ConfirmModal, ErrorBox, Modal, Spinner, Tag, type Notify } from './ui';
import './mcp-channel.css';

interface McpServer {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  hasToken: boolean;
}

/** 内置发布通道预设：Docker 部署走 compose 网络，本地开发走 loopback。 */
const PRESETS = [
  { label: '内置通道（Docker 部署）', endpoint: 'http://xiaohongshu-mcp:18060/mcp' },
  { label: '本机通道（本地运行 MCP）', endpoint: 'http://127.0.0.1:18060/mcp' },
];

export function McpChannel({ notify }: { notify: Notify }) {
  const [servers, setServers] = useState<McpServer[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [checkResult, setCheckResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [qr, setQr] = useState<{ server: McpServer; imageDataUrl?: string; text: string } | null>(
    null,
  );

  const reload = useCallback(async () => {
    try {
      setServers(await api<McpServer[]>('/mcp-servers'));
    } catch (e) {
      // 账号模式之外不可用：静默隐藏区块。
      setServers([]);
      setError('');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(
        '/mcp-servers',
        json('POST', {
          name: name.trim(),
          endpoint: endpoint.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
        }),
      );
      setCreating(false);
      setName('');
      setEndpoint('');
      setToken('');
      notify('发布通道已添加');
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(server: McpServer) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/mcp-servers/${encodeURIComponent(server.id)}`, json('DELETE'));
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function check(server: McpServer): Promise<{ ok: boolean; text: string }> {
    if (busy) return { ok: false, text: '忙' };
    setBusy(true);
    setCheckResult((current) => ({ ...current, [server.id]: { ok: false, text: '检查中…' } }));
    try {
      const result = await api<{ loggedIn: boolean; raw: string }>(
        `/mcp-servers/${encodeURIComponent(server.id)}/check`,
        json('POST'),
      );
      const value = {
        ok: result.loggedIn,
        text: result.loggedIn ? `已登录 · ${result.raw}` : result.raw || '未登录',
      };
      setCheckResult((current) => ({ ...current, [server.id]: value }));
      return value;
    } catch (e) {
      const value = { ok: false, text: message(e) };
      setCheckResult((current) => ({ ...current, [server.id]: value }));
      return value;
    } finally {
      setBusy(false);
    }
  }
  async function showQrcode(server: McpServer) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ imageDataUrl?: string; text: string }>(
        `/mcp-servers/${encodeURIComponent(server.id)}/login-qrcode`,
        json('POST'),
      );
      setQr({ server, imageDataUrl: result.imageDataUrl, text: result.text });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function recheckAfterScan() {
    if (!qr) return;
    const result = await check(qr.server);
    if (result.ok) {
      setQr(null);
      notify('发布通道登录成功');
    } else {
      notify('仍未登录，请用小红书 App 扫描二维码后再试', 'error');
    }
  }

  return (
    <section className="template-section">
      <div className="section-heading">
        <div>
          <h2>发布通道 (MCP)</h2>
          <span>
            自动化发布经由自部署的小红书发布通道执行。内置版本基于 xpzouying/xiaohongshu-mcp（CC
            授权，已获作者授权内置）。
          </span>
        </div>
        <Button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={18} />
          添加发布通道
        </Button>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {servers && servers.length > 0 && (
        <div className="prompt-grid">
          {servers.map((server) => {
            const result = checkResult[server.id];
            return (
              <Card key={server.id} className="prompt-card">
                <div className="prompt-card-heading">
                  <h3>{server.name}</h3>
                  <span>{server.endpoint}</span>
                </div>
                <div className="prompt-card-footer">
                  {result ? (
                    <Tag tone={result.ok ? 'green' : 'red'}>{result.text.slice(0, 40)}</Tag>
                  ) : (
                    <Tag>{server.enabled ? '已启用' : '已停用'}</Tag>
                  )}
                </div>
                <div className="prompt-card-footer">
                  <Button variant="outline" disabled={busy} onClick={() => check(server)}>
                    <RefreshCw size={14} />
                    检查登录状态
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => showQrcode(server)}>
                    <QrCode size={14} />
                    扫码登录
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-button danger-text"
                    disabled={busy}
                    onClick={() => remove(server)}
                  >
                    <Trash2 size={14} />
                    删除
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {creating && (
        <Modal
          title="添加发布通道 (MCP)"
          description="连接自部署的小红书发布通道。Docker 部署织作时内置通道已随 compose 启动，直接选用即可。"
          onClose={() => {
            if (!busy) setCreating(false);
          }}
        >
          <form onSubmit={create}>
            <Label>
              通道名称
              <Input
                required
                maxLength={80}
                placeholder="例如：本机小红书发布通道"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Label>
            <Label>
              MCP 端点
              <Input
                required
                type="url"
                placeholder="http://127.0.0.1:18060/mcp"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </Label>
            <div className="prompt-categories">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.endpoint}
                  type="button"
                  className="prompt-category"
                  onClick={() => setEndpoint(preset.endpoint)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <Label>
              访问令牌（可选，部署时启用鉴权才需要）
              <Input
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                placeholder="Bearer Token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Label>
            <div className="modal-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                取消
              </Button>
              <Button
                className="button primary"
                disabled={busy || !name.trim() || !endpoint.trim()}
              >
                添加通道
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {qr && (
        <Modal
          title={`扫码登录 · ${qr.server.name}`}
          description="用小红书 App 扫描二维码完成登录；登录态保存在发布通道本机，不会上传。"
          onClose={() => {
            if (!busy) setQr(null);
          }}
        >
          <div className="mcp-qrcode">
            {qr.imageDataUrl ? (
              <img src={qr.imageDataUrl} alt="小红书登录二维码" width={220} height={220} />
            ) : (
              <p>{qr.text || '未获取到二维码'}</p>
            )}
            <p className="hint">扫码成功后点击「我已扫码」检查登录状态。</p>
            <div className="modal-actions">
              <Button className="button secondary" onClick={() => setQr(null)}>
                关闭
              </Button>
              <Button className="button primary" disabled={busy} onClick={recheckAfterScan}>
                我已扫码，检查登录
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
