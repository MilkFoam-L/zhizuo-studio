import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  ChartNoAxesCombined,
  ChevronRight,
  FolderOpen,
  LayoutTemplate,
  LogOut,
  Settings2,
  Sparkles,
  Sprout,
  UsersRound,
} from 'lucide-react';
import { api, json, message, SESSION_EXPIRED_EVENT, type SessionInfo } from './api';
import './accounts.css';
import './usage.css';
const Dashboard = lazy(() =>
  import('./Dashboard').then((module) => ({ default: module.Dashboard })),
);
const Providers = lazy(() =>
  import('./Providers').then((module) => ({ default: module.Providers })),
);
const ProjectEditor = lazy(() =>
  import('./ProjectEditor').then((module) => ({ default: module.ProjectEditor })),
);
const AccountAdmin = lazy(() =>
  import('./AccountAdmin').then((module) => ({ default: module.AccountAdmin })),
);
const Usage = lazy(() => import('./Usage').then((module) => ({ default: module.Usage })));
import { ErrorBox, Modal, Spinner, Toast } from './ui';
const currentRoute = () => window.location.hash.slice(1) || '/';
export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [session, setSession] = useState<SessionInfo>();
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: string; id: number }>();
  const sessionRevision = useRef(0);
  const notify = useCallback(
    (text: string, tone: 'success' | 'error' = 'success') =>
      setToast({ text, tone, id: Date.now() }),
    [],
  );
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const refresh = (expired = false) => {
      const revision = ++sessionRevision.current;
      controller?.abort();
      controller = new AbortController();
      if (expired) {
        setSession((current) =>
          current ? { ...current, authenticated: false, user: undefined } : current,
        );
        setPassword('');
        setHelp(false);
        setToast(undefined);
        setError('登录状态已过期，请重新登录。尚未保存的项目草稿会保留在此浏览器。');
      }
      api<SessionInfo>('/session', { signal: controller.signal })
        .then((next) => {
          if (active && revision === sessionRevision.current) {
            setSession(next);
            if (next.authenticated) setError('');
          }
        })
        .catch((e) => {
          if (active && revision === sessionRevision.current) setError(message(e));
        });
    };
    const expired = () => refresh(true);
    refresh();
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    ++sessionRevision.current;
    try {
      const request = json('POST', {
        password,
        ...(session?.mode === 'accounts' ? { email: email.trim() } : {}),
      });
      setPassword('');
      const result = await api<Partial<SessionInfo>>('/session', request);
      // Older single-workspace deployments return only authenticated on login.
      const next =
        typeof result.requiresPassword === 'boolean'
          ? (result as SessionInfo)
          : await api<SessionInfo>('/session');
      ++sessionRevision.current;
      setSession(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api('/session', json('DELETE'));
      ++sessionRevision.current;
      setSession((current) =>
        current ? { ...current, authenticated: false, user: undefined } : current,
      );
      setPassword('');
      setEmail('');
      setError('');
      setHelp(false);
      setToast(undefined);
      window.location.hash = '/';
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setLoggingOut(false);
    }
  }
  if (!session)
    return (
      <div className="screen-center">
        <Brand />
        {error ? (
          <>
            <ErrorBox>{error}</ErrorBox>
            <Button className="button" onClick={() => window.location.reload()}>
              重新连接
            </Button>
          </>
        ) : (
          <Spinner label="正在打开工作台" />
        )}
      </div>
    );
  if (!session.authenticated)
    return (
      <div className="login-page">
        <div className="login-story">
          <Brand />
          <p className="eyebrow">ZHIZUO CREATIVE STUDIO</p>
          <h1>
            好内容，
            <br />
            从一个想法开始。
          </h1>
          <p>
            让素材、灵感和每一版创作，
            <br />
            在同一个地方自然生长。
          </p>
          <Sprout size={160} strokeWidth={0.7} />
        </div>
        <form className="login-form" onSubmit={login}>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>进入你的创作空间</h2>
          <p className="muted">
            {session.mode === 'accounts'
              ? '使用管理员为你开通的账号，进入专属工作空间。'
              : '输入此工作台的访问密码，继续创作。'}
          </p>
          {session.mode === 'accounts' && (
            <div className="account-login-field">
              <Label htmlFor="login-email">邮箱</Label>
              <Input
                id="login-email"
                name="email"
                required
                autoFocus
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={254}
                disabled={busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          <div className="account-login-field">
            <Label htmlFor="login-password">
              {session.mode === 'accounts' ? '账号密码' : '访问密码'}
            </Label>
            <Input
              id="login-password"
              name="password"
              required
              autoFocus={session.mode !== 'accounts'}
              type="password"
              autoComplete="current-password"
              maxLength={session.mode === 'accounts' ? 256 : 1024}
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <Button className="button primary full" disabled={busy}>
            {busy ? (
              <Spinner label="正在验证" />
            ) : (
              <>
                进入工作台
                <ArrowRight size={17} />
              </>
            )}
          </Button>
        </form>
      </div>
    );
  const projectId = route.startsWith('/project/') ? route.split('/')[2] : undefined;
  const canManageAccounts = session.mode === 'accounts' && session.user?.role === 'admin';
  const page =
    route === '/usage'
      ? 'usage'
      : route === '/accounts'
        ? 'accounts'
        : route === '/settings'
          ? 'settings'
          : route === '/templates'
            ? 'templates'
            : 'projects';
  return (
    <div className={`app-shell ${projectId ? 'in-editor' : ''}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳到工作区
      </a>
      <aside className={`sidebar ${canManageAccounts ? 'sidebar-with-accounts' : ''}`}>
        <a href="#/" className="brand-link" aria-label="织作首页">
          <Brand />
        </a>
        <div className="sidebar-caption">你的创作空间</div>
        <nav aria-label="主导航">
          <a
            className={page === 'projects' ? 'active' : ''}
            href="#/"
            aria-current={page === 'projects' ? 'page' : undefined}
            aria-label="全部项目"
            title="全部项目"
          >
            <FolderOpen size={19} />
            全部项目{page === 'projects' && <ChevronRight size={15} className="nav-arrow" />}
          </a>
          <a
            className={page === 'templates' ? 'active' : ''}
            href="#/templates"
            aria-current={page === 'templates' ? 'page' : undefined}
            aria-label="灵感模板"
            title="灵感模板"
          >
            <LayoutTemplate size={19} />
            灵感模板
          </a>
          <a
            className={page === 'settings' ? 'active' : ''}
            href="#/settings"
            aria-current={page === 'settings' ? 'page' : undefined}
            aria-label="模型接入"
            title="模型接入"
          >
            <Settings2 size={19} />
            模型接入
          </a>
          <a
            className={page === 'usage' ? 'active' : ''}
            href="#/usage"
            aria-current={page === 'usage' ? 'page' : undefined}
            aria-label="用量与额度"
            title="用量与额度"
          >
            <ChartNoAxesCombined size={19} />
            用量与额度
          </a>
          {canManageAccounts && (
            <a
              className={page === 'accounts' ? 'active' : ''}
              href="#/accounts"
              aria-current={page === 'accounts' ? 'page' : undefined}
              aria-label="账号管理"
              title="账号管理"
            >
              <UsersRound size={19} />
              账号管理
            </a>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="mini-spark">
              <Sparkles size={17} />
            </span>
            <strong>让创作，再轻松一点</strong>
            <p>素材有序，灵感自由。</p>
          </div>
          <Button className="nav-button" onClick={() => setHelp(true)}>
            <BookOpen size={18} />
            使用指南
          </Button>
          {session.requiresPassword && (
            <Button className="nav-button" disabled={loggingOut} onClick={logout}>
              <LogOut size={17} />
              {loggingOut ? '正在退出' : '退出工作台'}
            </Button>
          )}
          <div className="profile">
            <span>{Array.from(session.user?.displayName || '织')[0]}</span>
            <div>
              <strong title={session.user?.displayName}>
                {session.user?.displayName || '我的工作台'}
              </strong>
              <small title={session.user?.workspace.name}>
                {session.user?.workspace.name || 'ZHIZUO STUDIO'}
              </small>
            </div>
            <span className="online-dot" title="已连接" />
          </div>
        </div>
      </aside>
      {session.requiresPassword && !projectId && (
        <div className="account-mobile-bar">
          <div>
            <strong>{session.user?.displayName || '我的工作台'}</strong>
            <span>{session.user?.workspace.name || '私有工作空间'}</span>
          </div>
          <Button
            variant="ghost"
            className="account-mobile-logout"
            disabled={loggingOut}
            onClick={logout}
          >
            <LogOut size={16} />
            {loggingOut ? '正在退出' : '退出'}
          </Button>
        </div>
      )}
      <main
        key={session.user?.id || session.mode || 'workspace'}
        id="main-content"
        className="main-content"
        tabIndex={-1}
      >
        <Suspense
          fallback={
            <div className="screen-center">
              <Spinner label="正在打开工作区" />
            </div>
          }
        >
          {projectId ? (
            <ProjectEditor key={projectId} id={projectId} notify={notify} />
          ) : page === 'settings' ? (
            <Providers notify={notify} />
          ) : page === 'usage' ? (
            <Usage session={session} notify={notify} />
          ) : page === 'accounts' ? (
            canManageAccounts && session.user ? (
              <AccountAdmin currentUser={session.user} notify={notify} />
            ) : (
              <div className="screen-center">
                <ErrorBox>此页面仅供工作台管理员管理账号。</ErrorBox>
                <Button asChild className="button secondary">
                  <a href="#/">返回我的项目</a>
                </Button>
              </div>
            )
          ) : (
            <Dashboard templatesOnly={page === 'templates'} notify={notify} />
          )}
        </Suspense>
      </main>
      {toast && <Toast key={toast.id} text={toast.text} tone={toast.tone} />}
      {help && (
        <Modal title="从素材到成品，只需几步" onClose={() => setHelp(false)}>
          <ol className="guide-list">
            <li>
              <strong>创建项目，填写内容简报</strong>
              <p>上传商品图片，填写真实卖点、受众和品牌。核对事实后勾选确认。</p>
            </li>
            <li>
              <strong>选择你习惯的模型服务</strong>
              <p>
                在「模型接入」填写服务商地址、模型和密钥，支持 OpenAI 兼容、Gemini 和异步中转接口。
              </p>
            </li>
            <li>
              <strong>生成、编辑，保留每一版</strong>
              <p>在画布组织素材；文案与海报可手动编辑并另存版本，生成任务关页后继续处理。</p>
            </li>
            <li>
              <strong>检查并导出</strong>
              <p>确认商品事实、版式和使用权后，导出 PNG 与文案包；完整备份可迁移素材及项目。</p>
            </li>
          </ol>
          <p className="hint">
            模板海报和手工文案可以直接使用。AI
            功能需要有效的服务商配置；织作不会自动发布到社交平台。
          </p>
        </Modal>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>
        织作<small>ZHIZUO</small>
      </span>
    </div>
  );
}
