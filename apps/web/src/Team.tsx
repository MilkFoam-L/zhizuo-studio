import { useCallback, useEffect, useState } from 'react';
import { Check, Link2Off, UserPlus, UsersRound } from 'lucide-react';
import type { SessionInfo, WorkspaceMembership } from './api';
import { api, json, message } from './api';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { ErrorBox, Spinner, formatTime, type Notify } from './ui';
import './accounts.css';
import './team.css';

interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'member';
  joinedAt: string;
}
interface InviteLink {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  urlPath: string;
}

export function Team({
  session,
  notify,
  onSessionRefresh,
}: {
  session: SessionInfo;
  notify: Notify;
  onSessionRefresh: () => void;
}) {
  const active = session.workspaces?.find((w) => w.id === session.activeWorkspaceId);
  const isOwner = active?.role === 'owner';
  const [members, setMembers] = useState<WorkspaceMember[]>();
  const [invites, setInvites] = useState<InviteLink[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinToken, setJoinToken] = useState('');
  const [copied, setCopied] = useState('');
  const workspaceId = session.activeWorkspaceId ?? '';

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      if (isOwner) {
        setMembers(await api<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`));
        setInvites(await api<InviteLink[]>(`/workspaces/${workspaceId}/invites`));
      }
    } catch (e) {
      setError(message(e));
    }
  }, [workspaceId, isOwner]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function switchWorkspace(id: string) {
    if (busy || id === session.activeWorkspaceId) return;
    setBusy(true);
    setError('');
    try {
      await api('/workspaces/switch', json('POST', { workspaceId: id }));
      onSessionRefresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function createInvite() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const link = await api<InviteLink>(
        `/workspaces/${workspaceId}/invites`,
        json('POST', { expiresHours: 72 }),
      );
      const url = `${location.origin}${location.pathname}${link.urlPath}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      setCopied(link.id);
      notify('邀请链接已生成并复制，72 小时内有效');
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api(
        `/workspaces/${workspaceId}/invites/${encodeURIComponent(id)}/revoke`,
        json('POST'),
      );
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`, json('DELETE'));
      notify('成员已移除，其访问随即失效');
      await reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    const token = joinToken.trim().split('/').pop() ?? '';
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const joined = await api<WorkspaceMembership>('/invites/accept', json('POST', { token }));
      setJoinToken('');
      notify(`已加入「${joined.name}」，可在此切换工作空间`);
      onSessionRefresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (!session.workspaces)
    return (
      <div className="screen-center">
        <ErrorBox>团队协作仅在账号模式下可用。</ErrorBox>
      </div>
    );

  return (
    <div className="team-page">
      <header className="page-heading">
        <h1>团队协作</h1>
        <p>把成员加入同一个工作空间，项目、素材与版本即时共享。移除成员后其访问立即失效。</p>
      </header>
      {error && <ErrorBox>{error}</ErrorBox>}
      <Card className="team-card">
        <h2>
          <UsersRound size={18} aria-hidden="true" />
          我的工作空间
        </h2>
        <ul className="team-workspaces" aria-label="可切换的工作空间">
          {session.workspaces.map((w) => (
            <li key={w.id}>
              <span>
                <strong>{w.name}</strong>
                <small>{w.role === 'owner' ? '我拥有的空间' : '受邀加入'}</small>
              </span>
              {w.id === session.activeWorkspaceId ? (
                <span className="team-current">当前</span>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => switchWorkspace(w.id)}>
                  切换
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {isOwner && (
        <Card className="team-card">
          <h2>
            <UserPlus size={18} aria-hidden="true" />
            成员
          </h2>
          {members ? (
            <ul className="team-members">
              {members.map((m) => (
                <li key={m.userId}>
                  <span>
                    <strong>{m.displayName}</strong>
                    <small>{m.email}</small>
                  </span>
                  <span className="team-member-side">
                    <em>{m.role === 'owner' ? '所有者' : '成员'}</em>
                    {m.role === 'member' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => removeMember(m.userId)}
                      >
                        移除
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Spinner label="正在载入成员" />
          )}
          <div className="team-invite-row">
            <Button className="button primary" disabled={busy} onClick={createInvite}>
              生成邀请链接
            </Button>
            <p className="muted">链接 72 小时内有效，持链接登录的账号可加入。已在剪贴板复制。</p>
          </div>
          {invites && invites.length > 0 && (
            <ul className="team-invites" aria-label="邀请记录">
              {invites.map((i) => (
                <li key={i.id}>
                  <span>
                    创建于 {formatTime(i.createdAt)} ·{' '}
                    {i.revokedAt
                      ? '已撤销'
                      : Date.parse(i.expiresAt) > Date.now()
                        ? `有效期至 ${formatTime(i.expiresAt)}`
                        : '已过期'}
                  </span>
                  {copied === i.id && (
                    <em className="team-copied">
                      <Check size={14} aria-hidden="true" /> 已复制
                    </em>
                  )}
                  {!i.revokedAt && Date.parse(i.expiresAt) > Date.now() && (
                    <Button variant="ghost" disabled={busy} onClick={() => revokeInvite(i.id)}>
                      <Link2Off size={15} aria-hidden="true" />
                      撤销
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <Card className="team-card">
        <h2>使用邀请加入</h2>
        <form className="team-join" onSubmit={join}>
          <Label className="sr-only" htmlFor="join-token">
            邀请链接或邀请码
          </Label>
          <Input
            id="join-token"
            placeholder="粘贴收到的邀请链接或邀请码"
            value={joinToken}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setJoinToken(e.target.value)}
          />
          <Button className="button primary" disabled={busy || !joinToken.trim()}>
            加入工作空间
          </Button>
        </form>
      </Card>
    </div>
  );
}
