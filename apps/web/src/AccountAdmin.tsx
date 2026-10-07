import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CirclePause,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { api, download, json, message, type AccountUser } from './api';
import { AlertDialogAction, AlertDialogCancel } from './components/ui/alert-dialog';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';
import { ConfirmModal, ErrorBox, Modal, Spinner, Tag, type Notify } from './ui';

export function AccountAdmin({
  currentUser,
  notify,
}: {
  currentUser: AccountUser;
  notify: Notify;
}) {
  const [accounts, setAccounts] = useState<AccountUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [disabling, setDisabling] = useState<AccountUser | null>(null);
  const [statusError, setStatusError] = useState('');
  const [changingAccount, setChangingAccount] = useState('');
  const [resetting, setResetting] = useState<AccountUser | null>(null);
  const [deleting, setDeleting] = useState<AccountUser | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const requestController = useRef<AbortController | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError('');
    void api<AccountUser[]>('/admin/accounts', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setAccounts(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, []);
  useEffect(() => {
    refresh();
    return () => requestController.current?.abort();
  }, [refresh]);

  function closeCreate() {
    if (creatingAccount) return;
    if (passwordInput.current) passwordInput.current.value = '';
    setCreating(false);
    setCreateError('');
  }
  async function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingAccount) return;
    const fields = new FormData(event.currentTarget);
    const request = json('POST', {
      email: String(fields.get('email') || '').trim(),
      displayName: String(fields.get('displayName') || '').trim(),
      password: String(fields.get('password') || ''),
    });
    // Keep credentials out of component state and clear the field before the request settles.
    if (passwordInput.current) passwordInput.current.value = '';
    setCreatingAccount(true);
    setCreateError('');
    try {
      const created = await api<AccountUser>('/admin/accounts', request);
      setAccounts((current) => [
        ...current.filter((account) => account.id !== created.id),
        created,
      ]);
      setCreating(false);
      notify(`已为 ${created.displayName} 创建独立工作空间`);
    } catch (e) {
      setCreateError(`${message(e)}。请重新填写账号密码后重试。`);
    } finally {
      setCreatingAccount(false);
    }
  }
  async function changeStatus(account: AccountUser, disabled: boolean) {
    if (changingAccount) return;
    setChangingAccount(account.id);
    setStatusError('');
    try {
      const updated = await api<AccountUser>(
        `/admin/accounts/${encodeURIComponent(account.id)}`,
        json('PATCH', { disabled }),
      );
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDisabling(null);
      notify(disabled ? '账号已禁用，项目和素材仍然保留' : '账号已启用，可以重新登录');
    } catch (e) {
      if (disabled) setStatusError(message(e));
      else notify(message(e), 'error');
    } finally {
      setChangingAccount('');
    }
  }
  const enabled = accounts.filter((account) => !account.disabled).length;
  const busy = creatingAccount || !!changingAccount;

  async function exportAccount(account: AccountUser) {
    setLifecycleBusy(true);
    try {
      await download(
        `/admin/accounts/${encodeURIComponent(account.id)}/export`,
        `zhizuo-account-${account.id}.zip`,
      );
      notify('账号数据已导出为 ZIP');
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setLifecycleBusy(false);
    }
  }
  async function submitReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetting || lifecycleBusy) return;
    const value = String(new FormData(event.currentTarget).get('newPassword') || '');
    setLifecycleBusy(true);
    try {
      await api(
        `/admin/accounts/${encodeURIComponent(resetting.id)}/reset-password`,
        json('POST', { newPassword: value }),
      );
      setResetting(null);
      notify(`已重置 ${resetting.displayName} 的密码，其全部登录状态已失效`);
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setLifecycleBusy(false);
    }
  }
  async function submitDelete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleting || lifecycleBusy) return;
    const operatorPassword = String(
      new FormData(event.currentTarget).get('operatorPassword') || '',
    );
    setLifecycleBusy(true);
    setDeleteError('');
    try {
      const summary = await api<{ projects: number }>(
        `/admin/accounts/${encodeURIComponent(deleting.id)}`,
        json('DELETE', { password: operatorPassword }),
      );
      setAccounts((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null);
      notify(`已删除账号及其 ${summary.projects} 个项目，额度审计记录已保留`);
    } catch (e) {
      setDeleteError(message(e));
    } finally {
      setLifecycleBusy(false);
    }
  }

  return (
    <div className="page-container account-admin-page">
      <header className="page-topbar">
        <div className="breadcrumbs">
          工作空间<span>/</span>账号管理
        </div>
        <span className="workspace-status">
          <ShieldCheck size={15} />
          管理员
        </span>
      </header>
      <section className="page-heading">
        <div>
          <p className="eyebrow">SPACE FOR EVERY CREATOR</p>
          <h1>为每位创作者，留一方空间</h1>
          <p className="muted">开通账号、管理访问权限，让每个人安心保存自己的创作。</p>
        </div>
        <Button
          className="button primary"
          disabled={loading || busy || !!error}
          onClick={() => {
            setCreateError('');
            setCreating(true);
          }}
        >
          <Plus size={18} />
          创建账号
        </Button>
      </section>
      <div className="account-access-note">
        <span className="account-access-icon">
          <UsersRound size={22} />
        </span>
        <div>
          <h2>每个账号都有自己的工作空间</h2>
          <p>
            项目、素材和模型配置按账号隔离。管理员负责账号的开通与启停，各账号的创作内容由本人访问。
          </p>
        </div>
      </div>
      <Card className="account-directory">
        <div className="account-directory-heading">
          <div>
            <h2>工作台账号</h2>
            {!loading && !error && (
              <p>
                共 {accounts.length} 个账号<span aria-hidden="true"> · </span>
                {enabled} 个已启用<span aria-hidden="true"> · </span>
                {accounts.length - enabled} 个已禁用
              </p>
            )}
          </div>
          <Button
            variant="outline"
            className="button secondary"
            disabled={loading || busy}
            onClick={refresh}
          >
            <RefreshCw size={16} />
            刷新列表
          </Button>
        </div>
        {loading ? (
          <div className="account-directory-state">
            <Spinner label="正在读取账号" />
          </div>
        ) : error ? (
          <div className="account-directory-state">
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : accounts.length === 0 ? (
          <div className="account-directory-state">
            <UsersRound size={28} />
            <h3>还没有账号记录</h3>
            <p>刷新列表，或创建一个创作者账号。</p>
          </div>
        ) : (
          <Table className="account-table">
            <TableCaption className="sr-only">
              账号和工作空间列表；禁用操作保留账号已有项目与素材。
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">创作者</TableHead>
                <TableHead scope="col">工作空间</TableHead>
                <TableHead scope="col">角色 / 状态</TableHead>
                <TableHead scope="col">创建日期</TableHead>
                <TableHead scope="col" className="account-action-column">
                  操作
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => {
                const self = account.id === currentUser.id;
                return (
                  <TableRow key={account.id}>
                    <TableCell>
                      <div className="account-identity">
                        <span className="account-avatar" aria-hidden="true">
                          {Array.from(account.displayName || '织')[0]}
                        </span>
                        <div>
                          <strong>
                            {account.displayName}
                            {self && <span className="account-self">你</span>}
                          </strong>
                          <span className="account-email">{account.email}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="account-workspace">{account.workspace.name}</span>
                    </TableCell>
                    <TableCell>
                      <div className="account-state">
                        <span>{account.role === 'admin' ? '管理员' : '创作者'}</span>
                        <Tag tone={account.disabled ? 'account-disabled' : 'account-enabled'}>
                          {account.disabled ? <CirclePause size={12} /> : <Check size={12} />}
                          {account.disabled ? '已禁用' : '已启用'}
                        </Tag>
                      </div>
                    </TableCell>
                    <TableCell>
                      <time dateTime={account.createdAt}>
                        {new Date(account.createdAt).toLocaleDateString('zh-CN')}
                      </time>
                    </TableCell>
                    <TableCell className="account-action-column">
                      <Button
                        variant="ghost"
                        className="text-button"
                        disabled={busy || lifecycleBusy}
                        aria-label={`重置 ${account.displayName} 的密码`}
                        onClick={() => setResetting(account)}
                      >
                        <KeyRound size={14} />
                        重置密码
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-button"
                        disabled={lifecycleBusy}
                        onClick={() => exportAccount(account)}
                      >
                        导出数据
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-button danger-text"
                        disabled={lifecycleBusy}
                        aria-label={`删除 ${account.displayName}`}
                        onClick={() => {
                          setDeleteError('');
                          setDeleting(account);
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </Button>
                      <Button
                        variant="outline"
                        className="button secondary"
                        disabled={self || busy}
                        title={self ? '当前登录账号不能禁用' : undefined}
                        aria-label={`${account.disabled ? '启用' : '禁用'} ${account.displayName}`}
                        onClick={() => {
                          if (account.disabled) void changeStatus(account, false);
                          else {
                            setStatusError('');
                            setDisabling(account);
                          }
                        }}
                      >
                        {changingAccount === account.id
                          ? '正在更新'
                          : account.disabled
                            ? '启用账号'
                            : '禁用账号'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      {creating && (
        <Modal
          title="创建创作者账号"
          description="为创作者开通独立工作空间，请通过可信渠道告知本人邮箱与密码。"
          onClose={closeCreate}
        >
          <form className="account-create-form" onSubmit={createAccount}>
            <div className="account-form-field">
              <Label htmlFor="account-display-name">创作者名称</Label>
              <Input
                id="account-display-name"
                name="displayName"
                autoComplete="nickname"
                required
                minLength={1}
                maxLength={80}
                disabled={creatingAccount}
                placeholder="例如：小林的内容工作室"
              />
            </div>
            <div className="account-form-field">
              <Label htmlFor="account-email">登录邮箱</Label>
              <Input
                id="account-email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                disabled={creatingAccount}
                placeholder="creator@example.com"
              />
            </div>
            <div className="account-form-field">
              <Label htmlFor="account-password">账号密码</Label>
              <Input
                ref={passwordInput}
                id="account-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={256}
                aria-describedby="account-password-hint"
                disabled={creatingAccount}
              />
              <p id="account-password-hint" className="hint">
                使用 12–256 个字符。提交后清空密码输入，创建成功后无法查看原密码。
              </p>
            </div>
            {createError && <ErrorBox>{createError}</ErrorBox>}
            <div className="account-form-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={creatingAccount}
                onClick={closeCreate}
              >
                取消
              </Button>
              <Button type="submit" className="button primary" disabled={creatingAccount}>
                {creatingAccount ? <Spinner label="正在创建" /> : '创建账号与工作空间'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {disabling && (
        <ConfirmModal
          title={`禁用 ${disabling.displayName} 的账号？`}
          description="禁用后，该账号无法登录，现有登录状态会失效。已保存的项目与素材仍然保留，之后可重新启用账号。"
          onClose={() => {
            if (!changingAccount) setDisabling(null);
          }}
        >
          <p className="account-disable-note">
            尚未完成的本地任务会尝试停止；远程服务已接受的生成可能继续执行并产生费用。
          </p>
          {statusError && <ErrorBox>{statusError}</ErrorBox>}
          <div className="account-form-actions">
            <AlertDialogCancel className="button secondary" disabled={!!changingAccount}>
              保持启用
            </AlertDialogCancel>
            <AlertDialogAction
              className="button danger"
              disabled={!!changingAccount}
              onClick={(event) => {
                event.preventDefault();
                void changeStatus(disabling, true);
              }}
            >
              {changingAccount ? <Spinner label="正在禁用" /> : '确认禁用'}
            </AlertDialogAction>
          </div>
        </ConfirmModal>
      )}
      {resetting && (
        <Modal
          title={`重置 ${resetting.displayName} 的密码`}
          description="设置一次性临时密码并通过可信渠道告知本人；其全部登录状态将立即失效。"
          onClose={() => {
            if (!lifecycleBusy) setResetting(null);
          }}
        >
          <form className="account-create-form" onSubmit={submitReset}>
            <div className="account-form-field">
              <Label htmlFor="reset-new-password">临时密码（至少 12 个字符）</Label>
              <Input
                id="reset-new-password"
                name="newPassword"
                type="text"
                autoComplete="off"
                required
                minLength={12}
                maxLength={256}
                disabled={lifecycleBusy}
              />
            </div>
            <div className="account-form-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={lifecycleBusy}
                onClick={() => setResetting(null)}
              >
                取消
              </Button>
              <Button type="submit" className="button primary" disabled={lifecycleBusy}>
                {lifecycleBusy ? <Spinner label="正在重置" /> : '确认重置'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={`删除 ${deleting.displayName} 的账号？`}
          description="此操作不可恢复：项目、素材、版本、任务与模型配置将被永久删除。请先「导出数据」留存备份。额度审计记录将按合规要求保留。"
          onClose={() => {
            if (!lifecycleBusy) setDeleting(null);
          }}
        >
          <form className="account-create-form" onSubmit={submitDelete}>
            <div className="account-form-field">
              <Label htmlFor="delete-operator-password">输入你的管理员密码以确认</Label>
              <Input
                id="delete-operator-password"
                name="operatorPassword"
                type="password"
                autoComplete="current-password"
                required
                disabled={lifecycleBusy}
              />
            </div>
            {deleteError && <ErrorBox>{deleteError}</ErrorBox>}
            <div className="account-form-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={lifecycleBusy}
                onClick={() => setDeleting(null)}
              >
                取消
              </Button>
              <Button type="submit" className="button danger" disabled={lifecycleBusy}>
                {lifecycleBusy ? <Spinner label="正在删除" /> : '永久删除账号'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
