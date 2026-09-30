import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  FolderOpen,
  LayoutTemplate,
  LogOut,
  Settings2,
  Sparkles,
  Sprout,
} from 'lucide-react';
import { api, json, message } from './api';
const Dashboard = lazy(() =>
  import('./Dashboard').then((module) => ({ default: module.Dashboard })),
);
const Providers = lazy(() =>
  import('./Providers').then((module) => ({ default: module.Providers })),
);
const ProjectEditor = lazy(() =>
  import('./ProjectEditor').then((module) => ({ default: module.ProjectEditor })),
);
import { ErrorBox, Modal, Spinner, Toast } from './ui';
const currentRoute = () => window.location.hash.slice(1) || '/';
export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [session, setSession] = useState<{ authenticated: boolean; requiresPassword: boolean }>();
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: string; id: number }>();
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
    api<{ authenticated: boolean; requiresPassword: boolean }>('/session')
      .then(setSession)
      .catch((e) => setError(message(e)));
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
    try {
      await api('/session', json('POST', { password }));
      setSession({ authenticated: true, requiresPassword: true });
      setPassword('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api('/session', json('DELETE'));
      setSession({ authenticated: false, requiresPassword: true });
    } catch (e) {
      notify(message(e), 'error');
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
          <p className="muted">输入此工作台的访问密码，继续创作。</p>
          <Label>
            访问密码
            <Input
              required
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Label>
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
  const page =
    route === '/settings' ? 'settings' : route === '/templates' ? 'templates' : 'projects';
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
      <aside className="sidebar">
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
            <Button className="nav-button" onClick={logout}>
              <LogOut size={17} />
              退出工作台
            </Button>
          )}
          <div className="profile">
            <span>织</span>
            <div>
              <strong>我的工作台</strong>
              <small>ZHIZUO STUDIO</small>
            </div>
            <span className="online-dot" title="已连接" />
          </div>
        </div>
      </aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
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
