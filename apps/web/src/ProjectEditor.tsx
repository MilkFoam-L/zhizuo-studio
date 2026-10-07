import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { AlertDialogAction, AlertDialogCancel } from './components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Label } from './components/ui/label';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock3,
  Copy,
  Download,
  Edit3,
  FileText,
  GitBranch,
  Group,
  MessageSquare,
  StickyNote,
  Share2,
  Image,
  Layers3,
  Maximize,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Redo2,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import {
  PROMPT_LIBRARY,
  PROMPT_LIBRARY_CATEGORIES,
  TEMPLATES,
  type BoardNode,
  type Brief,
  type ContentVersion,
  type CopyDraft,
  type GenerationTask,
  type Poster,
  type Provider,
} from '../../../packages/shared/src/index';
import { contentWarnings, layoutPoster } from '../../../packages/shared/src/poster-layout';
import { api, download, json, message } from './api';
import { Canvas, CanvasNodeEditor } from './Canvas';
import { createGroup, generationNodeState, removeNodes, withTaskNodes } from './canvas-helpers';
import { BrandPicker } from './BrandPicker';
import { ShareDialog } from './ShareDialog';
import { CopyEditor, PosterEditor, VersionCompare } from './Editors';
import {
  ErrorBox,
  Modal,
  ConfirmModal,
  Spinner,
  Tag,
  TemplateArt,
  formatTime,
  type Notify,
} from './ui';
import { useProject } from './useProject';
const statusText = {
  queued: '等待执行',
  running: '正在生成',
  reconciling: '核对服务商状态',
  succeeded: '生成完成',
  failed: '生成失败',
  cancelled: '已取消',
};
const activeTask = (t: GenerationTask) => ['queued', 'running'].includes(t.status);
export function ProjectEditor({ id, notify }: { id: string; notify: Notify }) {
  const model = useProject(id);
  const { detail, draft } = model;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerError, setProviderError] = useState('');
  const [selected, setSelected] = useState<BoardNode['data'] | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [panel, setPanel] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
  const [fitSignal, setFitSignal] = useState(0);
  const [modal, setModal] = useState<
    | 'generate'
    | 'copy'
    | 'poster'
    | 'template'
    | 'export'
    | 'compare'
    | 'rename'
    | 'reload'
    | 'storyboard'
    | 'share'
    | null
  >(null);
  const [editingVersion, setEditingVersion] = useState<ContentVersion>();
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [taskError, setTaskError] = useState('');
  const [showTasks, setShowTasks] = useState(false);
  const [genKind, setGenKind] = useState<'copy' | 'image'>('copy');
  const [genProvider, setGenProvider] = useState('');
  const [genPrompt, setGenPrompt] = useState('');
  const [genReference, setGenReference] = useState('');
  const [genError, setGenError] = useState('');
  const requestKey = useRef('');
  const [posterTemplate, setPosterTemplate] = useState(TEMPLATES[0].id);
  const [posterAsset, setPosterAsset] = useState('');
  const [exportIds, setExportIds] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [exportError, setExportError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const tasksRef = useRef<GenerationTask[] | null>(null);
  function selectContent(data: BoardNode['data'] | null, nodeId?: string) {
    setSelected(data);
    setSelectedId(nodeId);
    if (data && data.kind !== 'brief' && window.matchMedia('(max-width: 1100px)').matches)
      setPanel(false);
  }
  const loadProviders = useCallback(() => {
    setProviderError('');
    api<Provider[]>('/providers')
      .then((p) => {
        setProviders(p);
        setGenProvider((prev) => prev || p[0]?.id || '');
      })
      .catch((e) => setProviderError(message(e)));
  }, []);
  useEffect(loadProviders, [loadProviders]);
  useEffect(() => {
    if (!draft || !tasks.length) return;
    const board = withTaskNodes(draft.board, tasks, detail?.versions || []);
    if (board !== draft.board) model.update({ board });
  }, [draft?.board, tasks, detail?.versions, model.update]);
  useEffect(() => {
    if (!selectedId || !draft) return;
    const node = draft.board.nodes.find((n) => n.id === selectedId);
    setSelected(node?.data || null);
    if (!node) setSelectedId(undefined);
  }, [selectedId, draft?.board]);
  useEffect(() => {
    if (detail) {
      setTasks(detail.tasks);
      tasksRef.current = detail.tasks;
    }
  }, [detail?.tasks]);
  useEffect(() => {
    let stopped = false;
    let controller: AbortController | undefined;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      try {
        const result = await api<GenerationTask[]>(`/projects/${id}/tasks`, {
          signal: controller.signal,
        });
        if (stopped) return;
        const previous = tasksRef.current;
        tasksRef.current = result;
        setTasks(result);
        setTaskError('');
        if (
          previous &&
          result.some(
            (t) =>
              t.resultVersionId &&
              previous.find((p) => p.id === t.id)?.resultVersionId !== t.resultVersionId,
          )
        ) {
          await model.refresh();
          notify('新的创作版本已放入画布');
        }
      } catch (e) {
        if (!stopped) setTaskError(message(e));
      } finally {
        pending = false;
      }
    };
    const interval = setInterval(poll, 3000);
    return () => {
      stopped = true;
      clearInterval(interval);
      controller?.abort();
    };
  }, [id, model.refresh, notify]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        e.key.toLowerCase() !== 'z' ||
        modal ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)
      )
        return;
      e.preventDefault();
      if (e.shiftKey) model.redo();
      else model.undo();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [model.undo, model.redo, modal]);
  async function ensureSaved() {
    if (!(await model.flush())) throw new Error('请先处理画布保存提示，再进行此操作。');
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      await ensureSaved();
      for (const f of Array.from(files)) {
        const data = new FormData();
        data.append('file', f);
        await api(`/projects/${id}/assets`, { method: 'POST', body: data });
      }
      await model.refresh();
      setFitSignal((n) => n + 1);
      notify('素材已加入画布');
    } catch (e) {
      notify(message(e), 'error');
      await model.refresh().catch(() => {});
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }
  async function saveCopy(copy: CopyDraft, label: string, parentVersionId?: string) {
    await ensureSaved();
    const version = await api<ContentVersion>(
      `/projects/${id}/versions`,
      json('POST', { kind: 'copy', label, copy, parentVersionId }),
    );
    await model.refresh();
    selectContent({ kind: 'copy', label, versionId: version.id });
    notify('文案新版本已保存');
  }
  async function savePoster(poster: Poster, label: string, parentVersionId: string) {
    await ensureSaved();
    const version = await api<ContentVersion>(
      `/projects/${id}/versions`,
      json('POST', { kind: 'poster', label, poster, parentVersionId }),
    );
    await model.refresh();
    selectContent({ kind: 'poster', label, versionId: version.id });
    notify('海报新版本已保存');
  }
  async function createPoster() {
    setBusy(true);
    setGenError('');
    try {
      await ensureSaved();
      const version = await api<ContentVersion>(
        `/projects/${id}/posters`,
        json('POST', { templateId: posterTemplate, assetId: posterAsset || undefined }),
      );
      await model.refresh();
      selectContent({ kind: 'poster', label: version.label, versionId: version.id });
      setModal(null);
      notify('模板海报已加入画布');
    } catch (e) {
      setGenError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function createStoryboard() {
    if (!selectedVersion?.copy) return;
    setBusy(true);
    setGenError('');
    try {
      await ensureSaved();
      const versions = await api<ContentVersion[]>(
        `/projects/${id}/storyboards`,
        json('POST', {
          copyVersionId: selectedVersion.id,
          templateId: 'xhs-editorial',
          assetId: posterAsset || undefined,
        }),
      );
      await model.refresh();
      setFitSignal((n) => n + 1);
      setModal(null);
      notify(`已按大纲创建 ${versions.length} 页图文海报`);
    } catch (e) {
      setGenError(message(e));
    } finally {
      setBusy(false);
    }
  }
  function openGenerate(kind: 'copy' | 'image') {
    setGenKind(kind);
    setGenProvider((previous) => {
      const compatible = providers.filter((p) =>
        kind === 'copy' ? p.kind !== 'async-json' && !!p.textModel : !!p.imageModel,
      );
      return compatible.find((p) => p.id === previous)?.id || compatible[0]?.id || '';
    });
    setGenPrompt('');
    setGenReference(selected?.assetId || selectedVersion?.assetId || '');
    setGenError('');
    requestKey.current = crypto.randomUUID();
    setModal('generate');
    loadProviders();
  }
  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setGenError('');
    try {
      await ensureSaved();
      const task = await api<GenerationTask>(
        `/projects/${id}/tasks`,
        json('POST', {
          kind: genKind,
          providerId: genProvider,
          prompt: genPrompt.trim(),
          referenceAssetId: genReference || undefined,
          parentVersionId: selectedVersion?.id,
          idempotencyKey: requestKey.current,
        }),
      );
      await model.refresh();
      setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
      setShowTasks(true);
      setModal(null);
      notify('生成任务已提交，可以继续整理画布');
    } catch (e) {
      setGenError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancelTask(task: GenerationTask) {
    try {
      const updated = await api<GenerationTask>(`/tasks/${task.id}/cancel`, json('POST'));
      setTasks((p) => p.map((t) => (t.id === updated.id ? updated : t)));
      notify(
        updated.status === 'cancelled'
          ? task.status === 'queued' && !task.upstreamTaskId
            ? '任务已取消'
            : '已停止本地等待和查询，请核对服务商结果与费用。'
          : `任务状态已更新：${statusText[updated.status]}`,
      );
    } catch (e) {
      notify(message(e), 'error');
    }
  }
  function openExport() {
    setExportIds(
      selectedVersion ? [selectedVersion.id] : detail?.versions.slice(0, 20).map((v) => v.id) || [],
    );
    setAcknowledged(false);
    setExportError('');
    setModal('export');
  }
  async function exportContent() {
    setBusy(true);
    setExportError('');
    try {
      await ensureSaved();
      await download(
        '/exports',
        `${draft!.title}-内容包.zip`,
        json('POST', { projectId: id, versionIds: exportIds, acknowledged }),
      );
      notify('内容包已导出');
      setModal(null);
    } catch (e) {
      setExportError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function backup() {
    setBusy(true);
    try {
      await ensureSaved();
      await download(`/projects/${id}/backup`, `${draft!.title}-完整备份.zip`);
      notify('项目与媒体完整备份已下载');
    } catch (e) {
      notify(message(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function copyText(copy: CopyDraft) {
    try {
      await navigator.clipboard.writeText(
        `${copy.titles[0]}\n\n${copy.body}\n\n${copy.tags.map((t) => `#${t}`).join(' ')}`,
      );
      notify('标题、正文和标签已复制');
    } catch {
      notify('浏览器不允许复制，请打开编辑器手动选择文本。', 'error');
    }
  }
  function usePrompt(text: string) {
    openGenerate('copy');
    setGenPrompt(text);
  }
  function viewResultVersion(versionId: string) {
    const version = detail?.versions.find((v) => v.id === versionId);
    if (version)
      selectContent({
        kind: version.kind,
        label: version.label,
        versionId: version.id,
        assetId: version.assetId,
      });
    else void model.refresh().catch((e) => notify(message(e), 'error'));
  }
  function viewTaskResult(task: GenerationTask) {
    if (task.resultVersionId) viewResultVersion(task.resultVersionId);
  }
  function addNote(kind: 'prompt' | 'annotation') {
    if (!draft) return;
    const node: BoardNode = {
      id: `${kind}-${crypto.randomUUID()}`,
      type: 'content',
      position: {
        x: (100 - draft.board.viewport.x) / draft.board.viewport.zoom,
        y: (100 - draft.board.viewport.y) / draft.board.viewport.zoom,
      },
      data: {
        kind,
        label: kind === 'prompt' ? '创作提示词' : '审阅备注',
        text: '',
        color: kind === 'prompt' ? '#cbd9c5' : '#e4c985',
        ...(kind === 'annotation' ? { reviewStatus: 'open' } : {}),
      },
    };
    model.pushHistory();
    model.update({
      board: {
        ...draft.board,
        nodes: [
          ...draft.board.nodes.map((item) => ({ ...item, selected: false })),
          { ...node, selected: true },
        ],
      },
    });
    selectContent(node.data, node.id);
  }
  const selectedNode = draft?.board.nodes.find((node) =>
    selectedId
      ? node.id === selectedId
      : selected?.versionId
        ? node.data.versionId === selected.versionId
        : selected?.assetId
          ? node.data.assetId === selected.assetId
          : false,
  );
  const selectedTaskState = selected ? generationNodeState(selected, tasks) : undefined;
  const selectedTask = selectedTaskState?.task;
  const selectedSnapshot = selectedTaskState?.snapshot;
  const groupableIds =
    draft?.board.nodes
      .filter(
        (node) =>
          (node as BoardNode & { selected?: boolean }).selected &&
          !node.parentId &&
          node.data.kind !== 'group',
      )
      .map((node) => node.id) || [];
  const selectedVersion = detail?.versions.find((v) => v.id === selected?.versionId);
  const selectedAsset = detail?.assets.find(
    (a) => a.id === (selected?.assetId || selectedVersion?.assetId),
  );
  const running = tasks.filter(activeTask);
  const qualityWarnings =
    detail?.versions
      .filter((v) => exportIds.includes(v.id))
      .flatMap((v) => [
        ...(v.copy
          ? contentWarnings(`${v.copy.titles.join(' ')} ${v.copy.body}`, draft?.brief.bannedTerms)
          : []),
        ...(v.poster ? layoutPoster(v.poster).warnings : []),
      ]) || [];
  if (model.loading)
    return (
      <div className="screen-center">
        <Spinner label="正在整理你的创作空间" />
      </div>
    );
  if (model.error || !draft || !detail)
    return (
      <div className="page-container">
        <a href="#/" className="text-button">
          <ArrowLeft size={16} />
          返回项目
        </a>
        <ErrorBox>{model.error || '项目不存在'}</ErrorBox>
        <Button className="button secondary" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </div>
    );
  const updateBrief = <K extends keyof Brief>(key: K, value: Brief[K]) =>
    model.update({
      brief: { ...draft.brief, [key]: value, ...(key !== 'confirmed' ? { confirmed: false } : {}) },
    });
  return (
    <div className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-title">
          <a href="#/" className="icon-button" aria-label="返回全部项目">
            <ChevronLeft size={20} />
          </a>
          <div>
            <Button
              className="project-title-button"
              onClick={() => {
                setNewTitle(draft.title);
                setModal('rename');
              }}
            >
              {draft.title}
              <Edit3 size={13} />
            </Button>
            <span className={`save-status save-${model.saveState}`}>
              <i />
              {
                {
                  saved: '所有更改已保存',
                  pending: '有更改待保存',
                  saving: '正在保存…',
                  error: '保存失败 · 草稿已保留',
                  conflict: '需要合并云端更新',
                }[model.saveState]
              }
            </span>
          </div>
        </div>
        <div className="editor-header-actions">
          <Button
            className="button secondary small"
            disabled={busy || !detail.versions.length}
            onClick={async () => {
              try {
                await ensureSaved();
                setModal('share');
              } catch (e) {
                notify(message(e), 'error');
              }
            }}
          >
            <Share2 size={15} />
            分享预览
          </Button>
          <Button className="button secondary small backup-button" onClick={backup} disabled={busy}>
            <ArrowDownToLine size={15} />
            备份项目
          </Button>
          <Button
            className="button primary small"
            onClick={openExport}
            disabled={!detail.versions.length || busy}
          >
            <Download size={15} />
            导出内容
          </Button>
        </div>
      </header>
      {(model.saveState === 'conflict' || model.saveState === 'error') && (
        <div className="save-banner" role="alert">
          <span>{model.saveError}</span>
          <div>
            {model.saveState === 'conflict' ? (
              <>
                <Button onClick={() => model.merge().catch((e) => notify(message(e), 'error'))}>
                  保留本地并合并新内容
                </Button>
                <Button onClick={() => setModal('reload')}>重载云端版本</Button>
              </>
            ) : (
              <Button onClick={() => model.flush()}>重试保存</Button>
            )}
            <Button onClick={model.exportDraft}>下载本地草稿</Button>
          </div>
        </div>
      )}
      <div className="editor-toolbar">
        <div>
          <Button
            className={`toolbar-button ${panel ? 'is-active' : ''}`}
            onClick={() => {
              setPanel(!panel);
              if (!panel && window.matchMedia('(max-width: 1100px)').matches) selectContent(null);
            }}
            title="显示或隐藏简报"
            aria-label="内容简报"
            aria-expanded={panel}
            aria-controls="creative-brief"
          >
            {panel ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            <span>内容简报</span>
          </Button>
          <span className="toolbar-divider" />
          <Button
            className="toolbar-button"
            onClick={() => addNote('prompt')}
            aria-label="添加提示词"
            title="添加提示词"
          >
            <MessageSquare size={16} />
            <span>提示词</span>
          </Button>
          <Button
            className="toolbar-button"
            onClick={() => addNote('annotation')}
            aria-label="添加备注"
            title="添加备注"
          >
            <StickyNote size={16} />
            <span>备注</span>
          </Button>
          <Button
            className="toolbar-button"
            disabled={groupableIds.length < 2}
            title="Shift 选中至少两个未分组节点"
            aria-label="创建分组"
            onClick={() => {
              const groupId = `group-${crypto.randomUUID()}`;
              const board = createGroup(draft.board, groupableIds, groupId);
              if (board === draft.board) {
                notify('请缩小所选节点范围后分组', 'error');
                return;
              }
              model.pushHistory();
              model.update({
                board: {
                  ...board,
                  nodes: board.nodes.map((node) => ({ ...node, selected: node.id === groupId })),
                },
              });
              selectContent(board.nodes.find((node) => node.id === groupId)!.data, groupId);
            }}
          >
            <Group size={16} />
            <span>分组</span>
          </Button>
          <Button
            className="toolbar-button"
            aria-label="上传素材"
            title="上传素材"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            <Upload size={16} />
            <span>上传素材</span>
          </Button>
          <input
            ref={file}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/avif"
            hidden
            onChange={(e) => upload(e.target.files)}
          />
          <Button
            className="toolbar-button"
            aria-label="写文案"
            title="写文案"
            disabled={busy}
            onClick={() => {
              setEditingVersion(undefined);
              setModal('copy');
            }}
          >
            <FileText size={16} />
            <span>写文案</span>
          </Button>
          <Button
            className="toolbar-button"
            aria-label="模板海报"
            title="模板海报"
            disabled={busy}
            onClick={() => {
              setGenError('');
              setPosterAsset(selectedAsset?.id || detail.assets[0]?.id || '');
              setModal('template');
            }}
          >
            <Layers3 size={17} />
            <span>模板海报</span>
          </Button>
        </div>
        <div>
          <Button
            className="icon-button"
            aria-label="撤销画布操作"
            title="撤销 ⌘Z"
            disabled={!model.historyCount.undo}
            onClick={model.undo}
          >
            <Undo2 size={16} />
          </Button>
          <Button
            className="icon-button"
            aria-label="重做画布操作"
            title="重做 ⌘⇧Z"
            disabled={!model.historyCount.redo}
            onClick={model.redo}
          >
            <Redo2 size={16} />
          </Button>
          <Button
            className="icon-button"
            aria-label="适应全部内容"
            title="适应全部内容"
            onClick={() => setFitSignal((n) => n + 1)}
          >
            <Maximize size={16} />
          </Button>
          <span className="toolbar-divider" />
          <Button
            className="button ai-button small"
            disabled={busy}
            onClick={() => openGenerate('copy')}
          >
            <Sparkles size={15} />
            AI 创作
          </Button>
        </div>
      </div>
      <div
        className={`editor-workspace ${panel ? 'with-brief' : ''} ${selected && selected.kind !== 'brief' ? 'with-inspector' : ''}`}
      >
        {panel && (
          <aside id="creative-brief" className="brief-panel" aria-label="内容简报">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">THE CREATIVE BRIEF</span>
                <h2>先把想法说清楚</h2>
              </div>
              <Button
                className="icon-button panel-dismiss"
                aria-label="关闭内容简报"
                onClick={() => setPanel(false)}
              >
                <X size={18} />
              </Button>
            </div>
            <p className="panel-intro">真实的商品信息，是好内容的起点。</p>
            <Label>
              商品 / 创作主题
              <Input
                maxLength={120}
                placeholder="例如：手作陶瓷马克杯"
                value={draft.brief.productName}
                onChange={(e) => updateBrief('productName', e.target.value)}
              />
            </Label>
            <Label>
              核心卖点 <small>每行一个，填写有依据的事实</small>
              <Textarea
                rows={4}
                placeholder="材质、特点、使用场景…"
                value={draft.brief.sellingPoints}
                onChange={(e) => updateBrief('sellingPoints', e.target.value)}
              />
            </Label>
            <Label>
              目标受众
              <Input
                placeholder="这份内容，希望打动谁？"
                value={draft.brief.audience}
                onChange={(e) => updateBrief('audience', e.target.value)}
              />
            </Label>
            <Label>
              价格 / 活动信息
              <Input
                placeholder="例如：¥89，活动至 10 月 15 日"
                value={draft.brief.price}
                onChange={(e) => updateBrief('price', e.target.value)}
              />
            </Label>
            <div className="brief-section-title">品牌与表达</div>
            <BrandPicker
              projectId={id}
              revision={detail.project.revision}
              beforeApply={async () => {
                await ensureSaved();
                return model.savedRevision()!;
              }}
              onApplied={() => {
                void model.refresh().catch((e) => notify(message(e), 'error'));
              }}
              notify={notify}
            />
            {draft.brief.brandKitId && (
              <p className="hint">
                已应用品牌规范 · {draft.brief.fontFamily === 'serif' ? '衬线字体' : '无衬线字体'}
                {draft.brief.logoAssetId ? ' · 含品牌 Logo' : ''}
              </p>
            )}
            {!!draft.brief.bannedTerms?.length && (
              <p className="brand-terms-hint">品牌禁用词：{draft.brief.bannedTerms.join('、')}</p>
            )}
            <Label>
              品牌名称
              <Input
                placeholder="你的品牌"
                value={draft.brief.brand}
                onChange={(e) => updateBrief('brand', e.target.value)}
              />
            </Label>
            <Label className="color-field">
              品牌颜色
              <input
                type="color"
                value={draft.brief.brandColor}
                onChange={(e) => updateBrief('brandColor', e.target.value)}
              />
              <span>{draft.brief.brandColor.toUpperCase()}</span>
            </Label>
            <Label>
              内容风格
              <Input
                placeholder="自然、清晰、有细节"
                value={draft.brief.tone}
                onChange={(e) => updateBrief('tone', e.target.value)}
              />
            </Label>
            <Label>
              目标平台
              <select
                value={draft.brief.platform}
                onChange={(e) => updateBrief('platform', e.target.value as Brief['platform'])}
              >
                <option value="xiaohongshu">小红书图文</option>
                <option value="commerce">电商商品图</option>
                <option value="douyin">抖音内容</option>
              </select>
            </Label>
            <Label className="checkbox-label confirmation">
              <input
                type="checkbox"
                checked={draft.brief.confirmed}
                disabled={!draft.brief.productName.trim() || !draft.brief.sellingPoints.trim()}
                onChange={(e) => updateBrief('confirmed', e.target.checked)}
              />
              <span>
                我已核对以上商品事实，允许将其用于内容生成。
                <small>修改简报后，需要重新确认。</small>
              </span>
            </Label>
            <Button
              className="button primary full"
              disabled={busy || !draft.brief.confirmed}
              onClick={() => openGenerate('copy')}
            >
              <Sparkles size={16} />
              用这份简报开始创作
            </Button>
          </aside>
        )}
        <div className="canvas-wrapper">
          <div className="canvas-caption">
            <span className="canvas-label">自由画布</span>
            <span>
              {draft.board.nodes.length} 个节点<span className="caption-dot">·</span>
              素材与版本，都有迹可循
            </span>
          </div>
          <Canvas
            board={draft.board}
            brief={draft.brief}
            assets={detail.assets}
            versions={detail.versions}
            tasks={tasks}
            onCancelTask={cancelTask}
            onViewResult={viewResultVersion}
            onUsePrompt={usePrompt}
            onChange={(board, persist) => model.update({ board }, persist)}
            onHistory={model.pushHistory}
            onSelect={(data, nodeId) => {
              selectContent(data, nodeId);
              if (data?.kind === 'brief') setPanel(true);
            }}
            fitSignal={fitSignal}
          />
          {draft.board.nodes.length <= 1 && (
            <div className="canvas-onboarding">
              <span className="onboarding-symbol">
                <Image size={24} strokeWidth={1.4} />
              </span>
              <h3>先放入一张商品图</h3>
              <p>
                上传素材，搭配左侧简报
                <br />
                开始你的第一份内容创作。
              </p>
              <Button
                className="button secondary small"
                disabled={busy}
                onClick={() => file.current?.click()}
              >
                <Plus size={15} />
                选择图片
              </Button>
              <small>PNG、JPG、WebP 或 AVIF · 单张 ≤ 24 MB</small>
            </div>
          )}
          <div className="canvas-bottom-tools">
            <Button
              className={`task-pill ${running.length ? 'has-running' : ''}`}
              aria-expanded={showTasks}
              aria-controls="generation-history"
              onClick={() => setShowTasks(!showTasks)}
            >
              {running.length ? (
                <Spinner label={`${running.length} 个任务正在处理`} />
              ) : (
                <>
                  <Clock3 size={14} />
                  生成记录{tasks.length > 0 && <span>{tasks.length}</span>}
                </>
              )}
              <ChevronDown size={13} />
            </Button>
            {busy && (
              <span className="operation-pill">
                <Spinner label="正在处理" />
              </span>
            )}
          </div>
          {showTasks && (
            <section id="generation-history" className="tasks-popover" aria-label="生成任务">
              <div className="panel-heading">
                <h3>生成任务</h3>
                <Button
                  className="icon-button"
                  aria-label="关闭生成任务"
                  onClick={() => setShowTasks(false)}
                >
                  <X size={16} />
                </Button>
              </div>
              {taskError && <ErrorBox>{taskError}</ErrorBox>}
              {!tasks.length ? (
                <p className="empty-small">还没有生成记录。点击「AI 创作」开始。</p>
              ) : (
                tasks
                  .slice()
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((t) => (
                    <div className={`task-item task-${t.status}`} key={t.id}>
                      <div className="task-item-header">
                        <span>
                          {t.kind === 'copy' ? <FileText size={14} /> : <Image size={14} />}
                          {t.kind === 'copy' ? '图文文案' : '图片创作'}
                        </span>
                        <Tag
                          tone={
                            t.status === 'failed' ? 'red' : t.status === 'succeeded' ? 'green' : ''
                          }
                        >
                          {t.upstreamTaskId && ['running', 'reconciling'].includes(t.status)
                            ? '核对原任务'
                            : statusText[t.status]}
                        </Tag>
                      </div>
                      <p>{t.prompt || '根据已确认的商品简报生成'}</p>
                      {t.needsAttention && <Tag tone="red">需人工核对供应商结果与费用</Tag>}
                      <TaskTimeline projectId={id} task={t} />
                      {t.error && <div className="task-error">{t.error}</div>}
                      {t.upstreamTaskId && ['running', 'reconciling'].includes(t.status) && (
                        <div className="task-reconciliation">
                          <strong>核对原任务（不重复提交）</strong>
                          <p>
                            任务编号：<code>{t.upstreamTaskId}</code>
                          </p>
                          <p>
                            系统只查询原任务。停止核对仅停止本地等待和查询，服务商可能仍在生成并计费。
                          </p>
                        </div>
                      )}
                      {t.status === 'reconciling' && (
                        <div className="task-error">
                          {t.upstreamTaskId
                            ? '请按任务提示核对服务商结果。重新创作会提交新任务，可能重复计费。'
                            : '服务商可能已受理，但没有可恢复的任务编号。请先在服务商后台核对结果与费用，再决定是否重新创作，以免重复收费。'}
                        </div>
                      )}
                      <div className="task-item-footer">
                        <small>{formatTime(t.createdAt)}</small>
                        <div className="task-actions">
                          {(activeTask(t) || t.status === 'reconciling') && (
                            <Button className="text-button" onClick={() => cancelTask(t)}>
                              {t.upstreamTaskId
                                ? '停止核对'
                                : t.status === 'queued'
                                  ? '取消任务'
                                  : '停止本地等待'}
                            </Button>
                          )}
                          {t.resultVersionId ? (
                            <Button className="text-button" onClick={() => viewTaskResult(t)}>
                              查看结果
                              <ArrowRight size={12} />
                            </Button>
                          ) : t.status === 'failed' || t.status === 'reconciling' ? (
                            <Button
                              className="text-button"
                              onClick={() => {
                                openGenerate(t.kind);
                                setGenProvider(t.providerId);
                                setGenPrompt(t.prompt);
                                setGenReference(t.referenceAssetId || '');
                              }}
                            >
                              {t.status === 'reconciling' ? '核对后重新创作' : '重新创作'}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))
              )}
            </section>
          )}
        </div>
        {selected && selected.kind !== 'brief' && (
          <aside className="inspector-panel" aria-label="素材与版本详情">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">DETAILS & VERSIONS</span>
                <h2>{selected.kind === 'asset' ? '素材详情' : '创作详情'}</h2>
              </div>
              <Button
                className="icon-button"
                aria-label="关闭详情"
                onClick={() => selectContent(null)}
              >
                <X size={17} />
              </Button>
            </div>
            <h3 className="inspector-label">{selected.label}</h3>
            {selectedNode && (
              <CanvasNodeEditor
                node={selectedNode}
                onUsePrompt={usePrompt}
                onSave={(data, size) => {
                  model.pushHistory();
                  model.update({
                    board: {
                      ...draft.board,
                      nodes: draft.board.nodes.map((node) =>
                        node.id === selectedNode.id ? { ...node, data, ...size } : node,
                      ),
                    },
                  });
                  setSelected(data);
                  notify('节点已更新');
                }}
                onUngroup={() => {
                  model.pushHistory();
                  model.update({ board: removeNodes(draft.board, [selectedNode.id]) });
                  selectContent(null);
                }}
              />
            )}
            {selected.kind === 'generation' && (
              <div className="canvas-task-detail">
                <Tag>{selectedTaskState?.statusLabel || '任务记录待加载'}</Tag>
                <p>
                  {selectedSnapshot
                    ? '历史记录，不会恢复执行'
                    : selectedTask?.prompt || '根据已确认的商品简报生成'}
                </p>
                {selectedSnapshot && (
                  <p className="hint">备份任务创建于 {formatTime(selectedSnapshot.createdAt)}</p>
                )}
                {selectedTask?.error && <ErrorBox>{selectedTask.error}</ErrorBox>}
                {selectedTask?.status === 'reconciling' && (
                  <p className="hint">先核对服务商结果和费用，再决定是否重新创作。</p>
                )}
                {selectedTask && selectedTaskState?.canCancel && (
                  <Button
                    className="button secondary full"
                    onClick={() => cancelTask(selectedTask)}
                  >
                    {selectedTask.status === 'queued' ? '取消任务' : '停止本地等待'}
                  </Button>
                )}
                {selectedTaskState?.resultVersionId && (
                  <Button
                    className="button primary full"
                    onClick={() => viewResultVersion(selectedTaskState.resultVersionId!)}
                  >
                    查看结果
                  </Button>
                )}
              </div>
            )}
            {selectedVersion?.copy ? (
              <>
                <div className="copy-preview">
                  <span className="detail-label">备选标题</span>
                  {selectedVersion.copy.titles.map((t, i) => (
                    <strong key={i}>{t}</strong>
                  ))}
                  <span className="detail-label">正文</span>
                  <p>{selectedVersion.copy.body}</p>
                  <div className="node-tags">
                    {selectedVersion.copy.tags.map((t, i) => (
                      <span key={i}>#{t}</span>
                    ))}
                  </div>
                </div>
                <div className="inspector-actions">
                  <Button
                    className="button primary full"
                    onClick={() => {
                      setEditingVersion(selectedVersion);
                      setModal('copy');
                    }}
                  >
                    <Edit3 size={15} />
                    编辑并保存新版本
                  </Button>
                  <Button
                    className="button secondary full"
                    onClick={() => copyText(selectedVersion.copy!)}
                  >
                    <Copy size={15} />
                    复制文案
                  </Button>
                  <Button
                    className="button ai-button full"
                    disabled={!selectedVersion.copy.pages.length || busy}
                    onClick={() => {
                      setGenError('');
                      setPosterAsset(detail.assets[0]?.id || '');
                      setModal('storyboard');
                    }}
                  >
                    <Layers3 size={15} />
                    按大纲生成图文组
                  </Button>
                </div>
                <details className="outline-details">
                  <summary>图文分页大纲 · {selectedVersion.copy.pages.length} 页</summary>
                  {selectedVersion.copy.pages.map((p, i) => (
                    <div key={i}>
                      <b>
                        {i + 1}. {p.headline}
                      </b>
                      <p>{p.body}</p>
                    </div>
                  ))}
                </details>
              </>
            ) : selectedVersion?.poster ? (
              <>
                <img
                  className="inspector-preview"
                  src={`/api/versions/${selectedVersion.id}/preview`}
                  alt={selectedVersion.label}
                />
                <Button
                  className="button primary full"
                  onClick={() => {
                    setEditingVersion(selectedVersion);
                    setModal('poster');
                  }}
                >
                  <Edit3 size={15} />
                  编辑海报排版
                </Button>
              </>
            ) : selectedAsset ? (
              <>
                <a
                  href={selectedAsset.url || `/api/assets/${selectedAsset.id}/content`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    className="inspector-preview"
                    src={selectedAsset.url || `/api/assets/${selectedAsset.id}/content`}
                    alt={selectedAsset.name}
                  />
                </a>
                <dl className="asset-details">
                  <div>
                    <dt>图片尺寸</dt>
                    <dd>
                      {selectedAsset.width} × {selectedAsset.height}
                    </dd>
                  </div>
                  <div>
                    <dt>文件大小</dt>
                    <dd>{(selectedAsset.size / 1024 / 1024).toFixed(2)} MB</dd>
                  </div>
                  <div>
                    <dt>加入时间</dt>
                    <dd>{formatTime(selectedAsset.createdAt)}</dd>
                  </div>
                </dl>
                <Button className="button ai-button full" onClick={() => openGenerate('image')}>
                  <Sparkles size={16} />
                  以此为参考创作
                </Button>
                <Button
                  className="button secondary full"
                  onClick={() => {
                    setGenError('');
                    setPosterAsset(selectedAsset.id);
                    setModal('template');
                  }}
                >
                  <Layers3 size={16} />
                  用于模板海报
                </Button>
                <a
                  className="text-button original-link"
                  href={selectedAsset.url || `/api/assets/${selectedAsset.id}/content`}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看原图
                  <ArrowRight size={14} />
                </a>
              </>
            ) : ['prompt', 'annotation', 'group', 'generation'].includes(selected.kind) ? null : (
              <p className="hint">内容加载中，稍后可重新选择节点。</p>
            )}
            {selectedVersion && (
              <div className="version-info">
                <h3>
                  <GitBranch size={15} />
                  版本记录
                </h3>
                <p>{formatTime(selectedVersion.createdAt)}</p>
                <Tag>{selectedVersion.parentVersionId ? '有来源版本' : '初始版本'}</Tag>
                <Button className="text-button" onClick={() => setModal('compare')}>
                  查看版本对比
                  <ArrowRight size={14} />
                </Button>
                {detail.versions
                  .filter((v) => v.parentVersionId === selectedVersion.id)
                  .map((v) => (
                    <Button
                      className="version-child"
                      key={v.id}
                      onClick={() =>
                        selectContent({
                          kind: v.kind,
                          label: v.label,
                          versionId: v.id,
                          assetId: v.assetId,
                        })
                      }
                    >
                      <GitBranch size={13} />
                      {v.label}
                      <ArrowRight size={12} />
                    </Button>
                  ))}
              </div>
            )}
            {selected.kind !== 'generation' && (
              <div className="inspector-bottom">
                <Button
                  className="text-button danger-text"
                  disabled={!selectedNode}
                  onClick={() => {
                    if (!selectedNode) return;
                    model.pushHistory();
                    model.update({ board: removeNodes(draft.board, [selectedNode.id]) });
                    selectContent(null);
                  }}
                >
                  <Trash2 size={14} />
                  {selected.kind === 'group' ? '移除分组，保留内容' : '从画布移除节点'}
                </Button>
                <small>
                  {selected.kind === 'group'
                    ? '内部节点将保留在原位置。'
                    : selectedVersion || selectedAsset
                      ? '素材与版本仍保存在项目中，可通过版本库恢复。'
                      : '可撤销本次画布移除。'}
                </small>
              </div>
            )}
          </aside>
        )}
      </div>
      <footer className="editor-footer">
        <span>
          <i />
          {model.saveState === 'saved' ? '云端已保存' : '本地草稿已保留'}
        </span>
        <Button className="text-button" onClick={() => setModal('export')}>
          <Layers3 size={13} />
          版本库 · {detail.versions.length} 份内容
        </Button>
        <span>织作 · 每一版灵感都有来处</span>
      </footer>
      {modal === 'share' && (
        <ShareDialog
          projectId={id}
          versions={detail.versions}
          onClose={() => setModal(null)}
          notify={notify}
        />
      )}
      {modal === 'copy' && (
        <CopyEditor
          version={editingVersion}
          bannedTerms={draft.brief.bannedTerms}
          onClose={() => setModal(null)}
          onSave={saveCopy}
        />
      )}
      {modal === 'poster' && editingVersion?.poster && (
        <PosterEditor
          version={editingVersion}
          assets={detail.assets}
          onClose={() => setModal(null)}
          onSave={savePoster}
        />
      )}
      {modal === 'compare' && selectedVersion && (
        <VersionCompare
          current={selectedVersion}
          parent={detail.versions.find((v) => v.id === selectedVersion.parentVersionId)}
          assets={detail.assets}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'rename' && (
        <Modal title="为项目换个名字" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              model.update({ title: newTitle.trim() });
              setModal(null);
            }}
          >
            <Label>
              项目名称
              <Input
                autoFocus
                required
                maxLength={100}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
            </Label>
            <div className="modal-actions">
              <Button className="button primary" disabled={!newTitle.trim()}>
                <Check size={16} />
                保存名称
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'reload' && (
        <ConfirmModal
          title="重新加载云端版本？"
          description="此操作会替换当前未保存的本地布局与简报。你可以先下载本地草稿留存。"
          onClose={() => setModal(null)}
        >
          <div className="modal-actions">
            <Button className="button secondary" onClick={model.exportDraft}>
              下载本地草稿
            </Button>
            <AlertDialogCancel className="button secondary">继续编辑</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="button danger"
              onClick={(event) => {
                event.preventDefault();
                void model
                  .reload()
                  .then(() => setModal(null))
                  .catch((e) => notify(message(e), 'error'));
              }}
            >
              确认重新加载
            </AlertDialogAction>
          </div>
        </ConfirmModal>
      )}
      {modal === 'generate' && (
        <Modal
          title="让想法，继续生长"
          description="根据已确认的商品信息创作，生成结果会自动加入画布。"
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <form onSubmit={generate}>
            <Tabs
              value={genKind}
              onValueChange={(value) => setGenKind(value as 'copy' | 'image')}
              className="generation-tabs"
            >
              <TabsList className="segmented" aria-label="创作内容类型">
                <TabsTrigger value="copy">
                  <FileText size={16} />
                  图文文案
                </TabsTrigger>
                <TabsTrigger value="image">
                  <Image size={16} />
                  图片创作
                </TabsTrigger>
              </TabsList>
              <TabsContent value={genKind}>
                {providerError && <ErrorBox>{providerError}</ErrorBox>}
                {!providers.length ? (
                  <div className="connection-prompt">
                    <Sparkles size={26} />
                    <h3>先连接一个模型服务</h3>
                    <p>接入你常用的官方接口或中转平台，开始真实的 AI 创作。</p>
                    <a href="#/settings" className="button primary" onClick={() => setModal(null)}>
                      前往模型接入
                      <ArrowRight size={15} />
                    </a>
                  </div>
                ) : (
                  <>
                    <Label>
                      使用的服务商
                      <select
                        required
                        value={genProvider}
                        onChange={(e) => setGenProvider(e.target.value)}
                      >
                        <option value="">请选择</option>
                        {providers.map((p) => (
                          <option
                            key={p.id}
                            value={p.id}
                            disabled={
                              genKind === 'copy'
                                ? p.kind === 'async-json' || !p.textModel
                                : !p.imageModel
                            }
                          >
                            {p.name} ·{' '}
                            {genKind === 'copy'
                              ? p.textModel || '未配置文本模型'
                              : p.imageModel || '未配置图片模型'}
                          </option>
                        ))}
                      </select>
                    </Label>
                    {genKind === 'image' && (
                      <Label>
                        参考图片
                        <select
                          value={genReference}
                          onChange={(e) => setGenReference(e.target.value)}
                        >
                          <option value="">不使用参考图</option>
                          {detail.assets.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        <small>参考图支持取决于服务商的图片编辑能力。</small>
                      </Label>
                    )}
                    {genKind === 'image' && (
                      <Label>
                        从提示词库选用
                        <select
                          value=""
                          onChange={(e) => {
                            const entry = PROMPT_LIBRARY.find((item) => item.id === e.target.value);
                            if (entry) setGenPrompt(entry.prompt);
                          }}
                        >
                          <option value="">选择一个提示词模板（可再编辑）</option>
                          {PROMPT_LIBRARY_CATEGORIES.map((category) => (
                            <optgroup key={category} label={category}>
                              {PROMPT_LIBRARY.filter((entry) => entry.category === category).map(
                                (entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.title}
                                  </option>
                                ),
                              )}
                            </optgroup>
                          ))}
                        </select>
                        <small>
                          模板中的 [方括号] 是变量，选入后替换成你的商品与场景信息；精选自 CC BY 4.0
                          开源提示词库。
                        </small>
                      </Label>
                    )}
                    <Label>
                      {genKind === 'copy' ? '补充创作方向' : '描述你想要的画面'}
                      <Textarea
                        rows={4}
                        required={genKind === 'image'}
                        maxLength={8000}
                        placeholder={
                          genKind === 'copy'
                            ? '例如：用自然的语气讲使用场景，3 个备选标题，4 页图文大纲。'
                            : '例如：暖色家居场景，保留商品外观，柔和自然光，不在图片中加入文字。'
                        }
                        value={genPrompt}
                        onChange={(e) => setGenPrompt(e.target.value)}
                      />
                    </Label>
                    <div className="generation-brief">
                      <Tag>使用当前内容简报</Tag>
                      <strong>{draft.brief.productName || '商品信息待填写'}</strong>
                      <p>
                        {draft.brief.confirmed
                          ? '商品事实已确认。生成后请再次核对文字与商品外观。'
                          : '请先在左侧补充商品名称和卖点，并勾选事实确认。'}
                      </p>
                    </div>
                    <p className="hint">
                      每次创作将预占 1
                      次任务额度，完成后结算。服务商费用以账单为准；重复创作会提交新任务，取消可能无法终止已发送的请求。
                    </p>
                    {genError && <ErrorBox>{genError}</ErrorBox>}
                    <div className="modal-actions">
                      <Button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => setModal(null)}
                      >
                        取消
                      </Button>
                      <Button
                        className="button primary"
                        disabled={
                          busy ||
                          !draft.brief.confirmed ||
                          !genProvider ||
                          !(genKind === 'copy'
                            ? providers.find((p) => p.id === genProvider && p.kind !== 'async-json')
                                ?.textModel
                            : providers.find((p) => p.id === genProvider)?.imageModel)
                        }
                      >
                        {busy ? (
                          <Spinner label="正在提交" />
                        ) : (
                          <>
                            <Sparkles size={16} />
                            开始创作
                          </>
                        )}
                      </Button>
                    </div>
                  </>
                )}
              </TabsContent>
            </Tabs>
          </form>
        </Modal>
      )}
      {modal === 'template' && (
        <Modal
          wide
          title="给内容，选一件合适的外衣"
          description="使用真实商品素材创建海报，文字与版式可继续编辑。"
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <div className="template-picker">
            {TEMPLATES.map((t) => (
              <Button
                key={t.id}
                className={posterTemplate === t.id ? 'selected' : ''}
                aria-pressed={posterTemplate === t.id}
                onClick={() => setPosterTemplate(t.id)}
              >
                <TemplateArt kind={t.id} compact />
                <strong>{t.name}</strong>
                <small>
                  {t.width} × {t.height}
                </small>
                {posterTemplate === t.id && (
                  <span className="selected-check">
                    <Check size={14} />
                  </span>
                )}
              </Button>
            ))}
          </div>
          <Label>
            使用的商品素材
            <select value={posterAsset} onChange={(e) => setPosterAsset(e.target.value)}>
              <option value="">先不使用图片，稍后添加</option>
              {detail.assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Label>
          <p className="hint">模板尺寸是常用设计预设，发布前请根据平台当期要求检查。</p>
          {genError && <ErrorBox>{genError}</ErrorBox>}
          <div className="modal-actions">
            <Button className="button secondary" disabled={busy} onClick={() => setModal(null)}>
              取消
            </Button>
            <Button className="button primary" disabled={busy} onClick={createPoster}>
              {busy ? (
                <Spinner label="正在编排" />
              ) : (
                <>
                  <Layers3 size={16} />
                  创建模板海报
                </>
              )}
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'storyboard' && selectedVersion?.copy && (
        <Modal
          title="把大纲变成一组图文"
          description={`按当前文案的 ${selectedVersion.copy.pages.length} 页大纲，逐页创建 1080 × 1440 海报，并保留与文案的来源关系。`}
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <Label>
            使用的商品素材
            <select value={posterAsset} onChange={(e) => setPosterAsset(e.target.value)}>
              <option value="">先不使用图片，稍后逐页添加</option>
              {detail.assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Label>
          <div className="storyboard-outline">
            {selectedVersion.copy.pages.map((p, i) => (
              <div key={i}>
                <span>{String(i + 1).padStart(2, '0')}</span>
                <p>
                  <strong>{p.headline || `第 ${i + 1} 页`}</strong>
                  <small>{p.body}</small>
                </p>
              </div>
            ))}
          </div>
          <p className="hint">
            逐页海报由当前大纲排版，不额外调用 AI。创建后可修改每页文字和图片，再一起导出。
          </p>
          {genError && <ErrorBox>{genError}</ErrorBox>}
          <div className="modal-actions">
            <Button className="button secondary" disabled={busy} onClick={() => setModal(null)}>
              取消
            </Button>
            <Button className="button primary" disabled={busy} onClick={createStoryboard}>
              {busy ? (
                <Spinner label="正在逐页编排" />
              ) : (
                <>
                  <Layers3 size={16} />
                  创建 {selectedVersion.copy.pages.length} 页海报
                </>
              )}
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'export' && (
        <Modal
          wide
          title="把喜欢的内容，带出工作台"
          description="每次最多选择 20 个版本。海报和图片导出为 PNG，文案包含 Markdown 与结构化 JSON。"
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <div className="export-select-heading">
            <span>项目版本库 · {detail.versions.length} 份</span>
            <Button
              className="text-button"
              onClick={() =>
                setExportIds(
                  exportIds.length === Math.min(20, detail.versions.length)
                    ? []
                    : detail.versions.slice(0, 20).map((v) => v.id),
                )
              }
            >
              {exportIds.length === Math.min(20, detail.versions.length)
                ? '取消全选'
                : detail.versions.length > 20
                  ? '选择前 20 份'
                  : '选择全部'}
            </Button>
          </div>
          <div className="export-version-list">
            <Table className="version-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="version-check-column">选择</TableHead>
                  <TableHead>创作版本</TableHead>
                  <TableHead className="version-action-column">画布</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.versions.map((v) => (
                  <TableRow
                    key={v.id}
                    data-state={exportIds.includes(v.id) ? 'selected' : undefined}
                  >
                    <TableCell>
                      <Label className="version-select">
                        <input
                          aria-label={`导出 ${v.label}`}
                          type="checkbox"
                          disabled={exportIds.length >= 20 && !exportIds.includes(v.id)}
                          checked={exportIds.includes(v.id)}
                          onChange={(e) =>
                            setExportIds((p) =>
                              e.target.checked ? [...p, v.id] : p.filter((x) => x !== v.id),
                            )
                          }
                        />
                      </Label>
                    </TableCell>
                    <TableCell>
                      <div className="version-cell">
                        <span>
                          {v.kind === 'copy' ? <FileText size={20} /> : <Image size={20} />}
                        </span>
                        <div>
                          <strong>{v.label}</strong>
                          <small>
                            {formatTime(v.createdAt)} ·{' '}
                            {v.kind === 'copy' ? '图文文案' : v.kind === 'poster' ? '海报' : '图片'}
                          </small>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        className="text-button"
                        onClick={() => {
                          const exists = draft.board.nodes.find((n) => n.data.versionId === v.id);
                          if (!exists) {
                            model.pushHistory();
                            model.update({
                              board: {
                                ...draft.board,
                                nodes: [
                                  ...draft.board.nodes,
                                  {
                                    id: `restored-${crypto.randomUUID()}`,
                                    type: 'content',
                                    position: {
                                      x: 420 + (draft.board.nodes.length % 3) * 310,
                                      y: 150 + Math.floor(draft.board.nodes.length / 3) * 350,
                                    },
                                    data: {
                                      kind: v.kind,
                                      label: v.label,
                                      versionId: v.id,
                                      assetId: v.assetId,
                                    },
                                  },
                                ],
                              },
                            });
                          }
                          selectContent({
                            kind: v.kind,
                            label: v.label,
                            versionId: v.id,
                            assetId: v.assetId,
                          });
                          setModal(null);
                          setFitSignal((n) => n + 1);
                        }}
                      >
                        {draft.board.nodes.some((n) => n.data.versionId === v.id)
                          ? '查看'
                          : '放回画布'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!detail.versions.length && (
              <p className="empty-small">还没有创作版本。先写一份文案或创建模板海报。</p>
            )}
          </div>
          <div className="quality-warning">
            <strong>发布前，再检查一次</strong>
            <p>
              确认商品外观、价格、活动时间与事实一致；检查文字溢出、字体和素材使用权。AI
              生成的内容请按平台要求标识。
            </p>
            {[...new Set(qualityWarnings)].map((w) => (
              <p key={w}>• {w}</p>
            ))}
          </div>
          <Label className="checkbox-label">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>我已检查所选内容，并会根据平台规则核对后发布。</span>
          </Label>
          {exportError && <ErrorBox>{exportError}</ErrorBox>}
          <div className="modal-actions">
            <Button className="button secondary" onClick={() => setModal(null)} disabled={busy}>
              继续编辑
            </Button>
            <Button
              className="button primary"
              disabled={busy || !exportIds.length || !acknowledged}
              onClick={exportContent}
            >
              {busy ? (
                <Spinner label="正在打包" />
              ) : (
                <>
                  <Download size={16} />
                  导出 {exportIds.length} 份内容
                </>
              )}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const taskEventLabels: Record<string, string> = {
  queued: '已入队',
  claimed: '已被领取执行',
  checkpoint: '提交前检查点',
  published: '已发布结果',
  failed: '执行失败',
  cancelled: '已取消',
  reconcile: '结果未知，进入核对',
  dead: '自动查询已停止，需人工核对',
  requeued: '租约过期，未提交故重新排队',
  unavailable: '工作空间不可执行，已取消',
};
interface TaskEventRow {
  id: string;
  kind: string;
  at: string;
  detail?: string;
}
function TaskTimeline({ projectId, task }: { projectId: string; task: GenerationTask }) {
  const [events, setEvents] = useState<TaskEventRow[]>();
  const [error, setError] = useState('');
  const settled = !['queued', 'running'].includes(task.status);
  if (!settled && !task.needsAttention) return null;
  return (
    <details
      className="task-timeline"
      onToggle={(e) => {
        const target = e.currentTarget;
        if (!target.open || events || error) return;
        api<TaskEventRow[]>(`/projects/${projectId}/tasks/${task.id}/events`)
          .then(setEvents)
          .catch((err) => setError(message(err)));
      }}
    >
      <summary>处理记录</summary>
      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : events ? (
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              <span>{taskEventLabels[event.kind] ?? event.kind}</span>
              <small>{formatTime(event.at)}</small>
              {event.detail && <p>{event.detail}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <Spinner label="正在载入处理记录" />
      )}
    </details>
  );
}
