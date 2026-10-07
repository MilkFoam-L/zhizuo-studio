import { Card } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock3,
  FolderOpen,
  Plus,
  Search,
} from 'lucide-react';
import {
  PROMPT_LIBRARY,
  PROMPT_LIBRARY_CATEGORIES,
  TEMPLATES,
  type Project,
  type ProjectDetail,
} from '../../../packages/shared/src/index';
import { api, json, message } from './api';
import { ErrorBox, Modal, Spinner, Tag, TemplateArt, formatTime, type Notify } from './ui';
export function Dashboard({ templatesOnly, notify }: { templatesOnly: boolean; notify: Notify }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [create, setCreate] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [promptCategory, setPromptCategory] =
    useState<(typeof PROMPT_LIBRARY_CATEGORIES)[number]>('小红书封面');
  const [copiedPrompt, setCopiedPrompt] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => {
    setLoading(true);
    setError('');
    api<Project[]>('/projects')
      .then(setProjects)
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);
  function openCreate(template = '') {
    setTitle('');
    setFormError('');
    setCreate(template);
  }
  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setFormError('');
    try {
      const result = await api<ProjectDetail>(
        '/projects',
        json('POST', { title: title.trim(), ...(create ? { templateId: create } : {}) }),
      );
      window.location.hash = `/project/${result.project.id}`;
    } catch (e) {
      setFormError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function importProject(f?: File) {
    if (!f) return;
    setBusy(true);
    try {
      const data = new FormData();
      data.append('file', f);
      const result = await api<ProjectDetail>('/import', { method: 'POST', body: data });
      notify('项目与素材已恢复');
      window.location.hash = `/project/${result.project.id}`;
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }
  const filtered = projects.filter((p) =>
    `${p.title} ${p.brief.productName}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="dashboard page-container">
      <header className="page-topbar">
        <div className="breadcrumbs">
          工作空间<span>/</span>
          {templatesOnly ? '灵感模板' : '全部项目'}
        </div>
        <span className="workspace-status">
          <i />
          已连接工作台
        </span>
      </header>
      <section className="page-heading">
        <div>
          <p className="eyebrow">
            {templatesOnly ? 'A GOOD PLACE TO START' : 'YOUR CREATIVE WORKSPACE'}
          </p>
          <h1>
            {templatesOnly
              ? '好内容，从好模板开始。'
              : projects.length
                ? '继续你的创作。'
                : '从素材，开始一份好内容。'}
          </h1>
          <p className="muted">
            {templatesOnly
              ? '为不同场景准备的创作起点，每一处都可以改成你的风格。'
              : '整理商品素材、编辑文案与海报，让每一版创作都有来处。'}
          </p>
        </div>
        <Button className="button primary" onClick={() => openCreate()}>
          <Plus size={18} />
          新建项目
        </Button>
      </section>
      {!templatesOnly && (
        <section className="projects-section" aria-label="最近项目" aria-busy={loading}>
          <div className="section-heading">
            <div>
              <h2>
                最近项目 <span className="count">{projects.length}</span>
              </h2>
              <span>你的每一次创作，都在这里</span>
            </div>
            <div className="section-actions">
              <Label className="search-field">
                <Search size={16} />
                <Input
                  aria-label="搜索项目"
                  placeholder="搜索项目…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </Label>
              <Button
                className="button secondary small"
                disabled={busy}
                onClick={() => file.current?.click()}
              >
                <ArrowDownToLine size={16} />
                恢复备份
              </Button>
              <input
                ref={file}
                hidden
                type="file"
                accept=".zip"
                onChange={(e) => importProject(e.target.files?.[0])}
              />
            </div>
          </div>
          {loading ? (
            <div className="panel-loading">
              <Spinner />
            </div>
          ) : error ? (
            <>
              <ErrorBox>{error}</ErrorBox>
              <Button className="button secondary" onClick={refresh}>
                重新加载
              </Button>
            </>
          ) : !filtered.length ? (
            <Card className="empty-projects">
              <span className="empty-icon">
                <FolderOpen size={26} strokeWidth={1.4} />
              </span>
              <h3>{search ? '还没有匹配的项目' : '从你的第一份商品素材开始'}</h3>
              <p>
                {search
                  ? '试试其他项目名称或商品关键词。'
                  : '创建项目 → 上传素材 → 编辑内容 → 导出成品'}
              </p>
              {!search && (
                <Button className="button secondary" onClick={() => openCreate()}>
                  <Plus size={16} />
                  创建我的第一个项目
                </Button>
              )}
            </Card>
          ) : (
            <div className="project-grid">
              {filtered
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((p) => (
                  <Card key={p.id} className="project-card">
                    <a href={`#/project/${p.id}`} className="project-card-link">
                      <div
                        className="project-cover"
                        style={
                          {
                            '--project-color': p.brief.brandColor || '#244b3c',
                          } as React.CSSProperties
                        }
                      >
                        <span>{p.brief.productName || p.title}</span>
                        <div className="project-cover-shape" />
                        <Tag>
                          {p.brief.platform === 'xiaohongshu'
                            ? '小红书'
                            : p.brief.platform === 'commerce'
                              ? '电商'
                              : '抖音'}
                        </Tag>
                      </div>
                      <div className="project-info">
                        <h3 title={p.title}>{p.title}</h3>
                        <p>
                          <Clock3 size={13} />
                          {formatTime(p.updatedAt)} 更新<span>{p.board.nodes.length} 个节点</span>
                        </p>
                      </div>
                    </a>
                  </Card>
                ))}
            </div>
          )}
        </section>
      )}
      <section className="template-section">
        <div className="section-heading">
          <div>
            <h2>{templatesOnly ? '选择你的创作场景' : '从灵感模板开始'}</h2>
            <span>
              {templatesOnly
                ? '3 个精选模板 · 支持文案和版式编辑'
                : '版式示意 · 可编辑文字、商品图与品牌颜色'}
            </span>
          </div>
          {!templatesOnly && (
            <a className="text-button subtle" href="#/templates">
              全部模板
              <ArrowRight size={16} />
            </a>
          )}
        </div>
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <Button key={t.id} className="template-card" onClick={() => openCreate(t.id)}>
              <TemplateArt kind={t.id} />
              <div className="template-info">
                <div>
                  <h3>{t.name}</h3>
                  <p>{t.description}</p>
                </div>
                <span className="round-arrow">
                  <ArrowUpRight size={18} />
                </span>
              </div>
              <div className="template-meta">
                <Tag>{t.category}</Tag>
                <span>
                  {t.width} × {t.height}
                </span>
              </div>
            </Button>
          ))}
        </div>
      </section>
      <section className="template-section">
        <div className="section-heading">
          <div>
            <h2>提示词库</h2>
            <span>AI 生图提示词模板 · 替换 [方括号] 变量后用于「AI 创作」的图片生成</span>
          </div>
        </div>
        <div className="prompt-categories" role="tablist" aria-label="提示词分类">
          {PROMPT_LIBRARY_CATEGORIES.map((category) => (
            <Button
              key={category}
              className={`prompt-category ${promptCategory === category ? 'active' : ''}`}
              aria-pressed={promptCategory === category}
              onClick={() => setPromptCategory(category)}
            >
              {category}
            </Button>
          ))}
        </div>
        <div className="prompt-grid">
          {PROMPT_LIBRARY.filter((entry) => entry.category === promptCategory).map((entry) => (
            <Card key={entry.id} className="prompt-card">
              <div className="prompt-card-heading">
                <h3>{entry.title}</h3>
                <span>{entry.scenario}</span>
              </div>
              <details>
                <summary>查看提示词</summary>
                <p className="prompt-text">{entry.prompt}</p>
              </details>
              <div className="prompt-card-footer">
                <Button
                  className="text-button"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(entry.prompt)
                      .then(() => {
                        setCopiedPrompt(entry.id);
                        notify('提示词已复制，可在 AI 创作中粘贴使用');
                        setTimeout(() => setCopiedPrompt(''), 2500);
                      })
                      .catch(() => notify('复制失败，请手动选择文本复制', 'error'));
                  }}
                >
                  {copiedPrompt === entry.id ? '已复制' : '复制提示词'}
                </Button>
                <a
                  className="prompt-source"
                  href={entry.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`来源：${entry.source}`}
                >
                  来源
                </a>
              </div>
            </Card>
          ))}
        </div>
        <p className="hint prompt-license">
          提示词精选自 CC BY 4.0 开源仓库 （gpt-img-2/ai-image-prompt-cookbook ·
          ai-xiaohongshu-chuanda-prompt-cookbook），已按许可标注来源；生成图片请遵守目标平台规范。
        </p>
      </section>
      <footer className="dashboard-footer">
        每个好想法，都值得被好好织作。<span>织作 ZhiZuo Studio</span>
      </footer>
      {create !== null && (
        <Modal
          title="开始一份新的创作"
          description={
            create
              ? `使用「${TEMPLATES.find((t) => t.id === create)?.name}」作为起点`
              : '给项目一个名字，稍后可以补充素材与商品信息。'
          }
          onClose={() => {
            if (!busy) setCreate(null);
          }}
        >
          <form onSubmit={createProject}>
            <Label>
              项目名称
              <Input
                autoFocus
                required
                maxLength={100}
                placeholder="例如：秋日新品 · 小红书种草内容"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Label>
            {formError && <ErrorBox>{formError}</ErrorBox>}
            <div className="modal-actions">
              <Button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCreate(null)}
              >
                取消
              </Button>
              <Button className="button primary" disabled={busy || !title.trim()}>
                {busy ? (
                  <Spinner label="正在创建" />
                ) : (
                  <>
                    创建项目
                    <ArrowRight size={16} />
                  </>
                )}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
