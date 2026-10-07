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
  SwatchBook,
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
const Brands = lazy(() => import('./Brands').then((module) => ({ default: module.Brands })));
const Team = lazy(() => import('./Team').then((module) => ({ default: module.Team })));
const PublicShare = lazy(() =>
  import('./PublicShare').then((module) => ({ default: module.PublicShare })),
);
import { ErrorBox, Modal, Spinner, Toast } from './ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
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
  const sessionRefreshRef = useRef<() => void>(() => {});
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
    sessionRefreshRef.current = () => refresh();
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
  // 公开分享页在登录流程之前渲染：持链接访问者无需进入工作台。
  if (route.startsWith('/share/'))
    return (
      <Suspense
        fallback={
          <div className="screen-center">
            <Spinner label="正在打开分享" />
          </div>
        }
      >
        <PublicShare token={route.slice('/share/'.length)} />
      </Suspense>
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
      : route === '/team'
        ? 'team'
        : route === '/accounts'
          ? 'accounts'
          : route === '/settings'
            ? 'settings'
            : route === '/templates'
              ? 'templates'
              : route === '/brands'
                ? 'brands'
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
            className={page === 'brands' ? 'active' : ''}
            href="#/brands"
            aria-current={page === 'brands' ? 'page' : undefined}
            aria-label="品牌资料库"
            title="品牌资料库"
          >
            <SwatchBook size={19} />
            品牌资料库
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
          {session.mode === 'accounts' && (
            <a
              className={page === 'team' ? 'active' : ''}
              href="#/team"
              aria-current={page === 'team' ? 'page' : undefined}
              aria-label="团队协作"
              title="团队协作"
            >
              <UsersRound size={19} />
              团队协作
            </a>
          )}
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
          ) : page === 'team' ? (
            <Team
              session={session}
              notify={notify}
              onSessionRefresh={() => sessionRefreshRef.current()}
            />
          ) : page === 'brands' ? (
            <Brands notify={notify} />
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
        <Modal title="使用指南" onClose={() => setHelp(false)}>
          <Tabs defaultValue="start">
            <TabsList>
              <TabsTrigger value="start">开始上手</TabsTrigger>
              <TabsTrigger value="canvas">画布与节点</TabsTrigger>
              <TabsTrigger value="models">模型接入</TabsTrigger>
              <TabsTrigger value="team">品牌与协作</TabsTrigger>
              <TabsTrigger value="export">导出与备份</TabsTrigger>
            </TabsList>
            <TabsContent value="start">
              <ol className="guide-list">
                <li>
                  <strong>创建项目，填写内容简报</strong>
                  <p>上传商品图片，填写真实卖点、受众和品牌。核对事实后勾选确认。</p>
                </li>
                <li>
                  <strong>选择你习惯的模型服务</strong>
                  <p>
                    在「模型接入」填写服务商地址和密钥，点「获取模型列表」选择模型；支持 OpenAI
                    兼容、Gemini 和异步中转接口。
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
                <li>
                  <strong>分享或邀请协作</strong>
                  <p>
                    「分享预览」生成只读快照链接；账号模式可在「团队协作」邀请成员共用一个空间。
                  </p>
                </li>
              </ol>
              <p className="hint">
                模板海报和手工文案可以直接使用。AI
                功能需要有效的服务商配置；织作不会自动发布到社交平台。
              </p>
            </TabsContent>
            <TabsContent value="canvas">
              <ol className="guide-list">
                <li>
                  <strong>节点类型</strong>
                  <p>
                    简报、素材、文案、海报、图片是内容节点；「提示词」「备注」记录想法，「分组」把相关节点框在一起拖动。
                  </p>
                </li>
                <li>
                  <strong>连线与版本</strong>
                  <p>
                    节点之间连线记录来源关系；保存修改产生新版本，原版本保留，可随时对比或放回画布。
                  </p>
                </li>
                <li>
                  <strong>生成任务</strong>
                  <p>
                    每次创作在画布上生成一个任务节点，状态实时更新；关页后任务继续执行，结果自动回填。
                  </p>
                </li>
                <li>
                  <strong>处理记录</strong>
                  <p>
                    展开任务卡片的「处理记录」可查看入队、领取、发布或核对的时间线；标示"需人工核对"的任务请到服务商后台核对结果与费用。
                  </p>
                </li>
                <li>
                  <strong>快捷操作</strong>
                  <p>画布支持框选、平移缩放、撤销重做（约 40 步）；删除节点不会删除底层版本。</p>
                </li>
              </ol>
            </TabsContent>
            <TabsContent value="models">
              <ol className="guide-list">
                <li>
                  <strong>三种协议</strong>
                  <p>
                    OpenAI 兼容（文生文/文生图）、Gemini 原生、受限 JSON
                    异步中转（仅图片，凭任务编号恢复查询）。
                  </p>
                </li>
                <li>
                  <strong>获取模型列表</strong>
                  <p>
                    填好地址和密钥后点「获取模型列表」，织作读取服务商的模型目录供直接选择，无需手打模型名。
                  </p>
                </li>
                <li>
                  <strong>密钥安全</strong>
                  <p>
                    密钥由服务器 AES-GCM
                    加密存储，界面只显示"已配置"状态；文本与图片模型可来自不同服务商。
                  </p>
                </li>
                <li>
                  <strong>连接测试</strong>
                  <p>
                    测试只访问模型目录，不产生生成费用；异步协议没有免费探测，只能通过真实任务验证（可能计费）。
                  </p>
                </li>
              </ol>
            </TabsContent>
            <TabsContent value="team">
              <ol className="guide-list">
                <li>
                  <strong>品牌资料库</strong>
                  <p>
                    保存品牌名、主色、语气、禁用词、字体和
                    Logo；应用到项目会更新简报并将商品事实重置为未确认，Logo
                    会复制成项目独立副本，之后修改品牌不影响已应用的项目。
                  </p>
                </li>
                <li>
                  <strong>禁用词</strong>
                  <p>品牌禁用词会传入文案生成约束，并出现在导出的风险提示清单里。</p>
                </li>
                <li>
                  <strong>团队协作</strong>
                  <p>
                    所有者生成邀请链接（72
                    小时内有效、可撤销），成员登录后接受邀请即可共享项目与素材；移除成员立即失效。
                  </p>
                </li>
                <li>
                  <strong>只读分享</strong>
                  <p>
                    「分享预览」为选定的版本生成限时快照链接（1–168
                    小时），持链接者只能查看，后续编辑不会进入分享。
                  </p>
                </li>
              </ol>
            </TabsContent>
            <TabsContent value="export">
              <ol className="guide-list">
                <li>
                  <strong>导出内容</strong>
                  <p>
                    选择版本打包 PNG / Markdown / JSON
                    和风险提示清单，导出前需确认商品事实与使用权。
                  </p>
                </li>
                <li>
                  <strong>项目备份与恢复</strong>
                  <p>
                    「备份项目」导出含素材与版本的完整
                    ZIP；恢复会建立新项目并重映射引用，不会覆盖原项目。
                  </p>
                </li>
                <li>
                  <strong>账号数据</strong>
                  <p>
                    「团队协作 →
                    账号与安全」可导出账号下全部项目，也可修改密码或删除账号（删除不可恢复，建议先导出）。
                  </p>
                </li>
                <li>
                  <strong>额度与告警</strong>
                  <p>
                    每次创作预占 1 次任务额度，成功消耗、结果未知保留待核对；用量越过 80% / 100%
                    会有告警事件，超出限额的新任务会被拒绝。
                  </p>
                </li>
              </ol>
            </TabsContent>
          </Tabs>
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
