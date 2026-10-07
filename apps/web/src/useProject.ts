import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board, Brief, Project, ProjectDetail } from '../../../packages/shared/src/index';
import { api, ApiError, json, message, saveBlob } from './api';
import { cleanBoard, mergeBoards, mergeProjectFields, orderedNodes } from './canvas-helpers';
export type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
type LocalDraft = {
  revision: number;
  title: string;
  brief: Brief;
  board: Board;
  baseBoard?: Board;
  baseBrief?: Brief;
  baseTitle?: string;
};
function removeDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Saving on the server remains successful when browser storage is disabled. */
  }
}
const copyBoard = (b: Board) => structuredClone(cleanBoard(b));
export function useProject(id: string) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const [draft, setDraft] = useState<LocalDraft>();
  const current = useRef<LocalDraft | undefined>(undefined);
  const server = useRef<Project | undefined>(undefined);
  const baseBoard = useRef<Board | undefined>(undefined);
  const baseBrief = useRef<Brief | undefined>(undefined);
  const baseTitle = useRef<string | undefined>(undefined);
  const change = useRef(0);
  const saved = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const conflict = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  const [historyCount, setHistoryCount] = useState({ undo: 0, redo: 0 });
  const past = useRef<Board[]>([]);
  const future = useRef<Board[]>([]);
  const key = `zhizuo:draft:${id}`;
  const store = useCallback(() => {
    if (current.current) {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            ...current.current,
            board: cleanBoard(current.current.board),
            baseBoard: baseBoard.current ? cleanBoard(baseBoard.current) : undefined,
            baseBrief: baseBrief.current,
            baseTitle: baseTitle.current,
            revision: current.current.revision,
          }),
        );
      } catch {
        setSaveError('浏览器草稿空间不足，请保持页面开启并重试保存。');
      }
    }
  }, [key]);
  const flush = useCallback(async (): Promise<boolean> => {
    if (conflict.current) return false;
    if (saving.current) {
      await saving.current;
      if (conflict.current) return false;
    }
    if (!current.current || !server.current || change.current === saved.current) return true;
    if (saving.current) return saving.current;
    const snapshot = structuredClone(current.current),
      revision = server.current.revision,
      stamp = change.current;
    setSaveState('saving');
    const task = (async () => {
      try {
        const updated = await api<Project>(
          `/projects/${id}`,
          json('PATCH', {
            revision,
            title: snapshot.title,
            brief: snapshot.brief,
            board: cleanBoard(snapshot.board),
          }),
        );
        server.current = updated;
        baseBoard.current = snapshot.board;
        baseBrief.current = updated.brief;
        baseTitle.current = updated.title;
        saved.current = stamp;
        if (current.current)
          current.current = {
            ...current.current,
            revision: updated.revision,
            baseBrief: updated.brief,
            baseTitle: updated.title,
          };
        if (live.current) {
          setDetail((d) => (d ? { ...d, project: updated } : d));
          setDraft(current.current);
          setSaveError('');
          setSaveState(change.current === stamp ? 'saved' : 'pending');
        }
        if (change.current === stamp) removeDraft(key);
        else store();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          conflict.current = true;
          if (live.current) setSaveState('conflict');
        } else if (live.current) setSaveState('error');
        if (live.current) setSaveError(message(e));
        store();
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = task;
    return task;
  }, [id, key, store]);
  useEffect(() => {
    live.current = true;
    let ignore = false;
    api<ProjectDetail>(`/projects/${id}`)
      .then((result) => {
        if (ignore) return;
        server.current = result.project;
        baseBoard.current = result.project.board;
        baseBrief.current = result.project.brief;
        baseTitle.current = result.project.title;
        let local: LocalDraft = {
          revision: result.project.revision,
          title: result.project.title,
          brief: result.project.brief,
          baseBrief: result.project.brief,
          baseTitle: result.project.title,
          board: { ...result.project.board, nodes: orderedNodes(result.project.board.nodes) },
        };
        try {
          const stored = localStorage.getItem(key);
          if (stored) {
            const parsed = JSON.parse(stored) as LocalDraft;
            if (
              parsed.board?.schemaVersion === 1 &&
              Array.isArray(parsed.board.nodes) &&
              parsed.brief &&
              typeof parsed.title === 'string'
            ) {
              local = {
                ...parsed,
                board: { ...parsed.board, nodes: orderedNodes(parsed.board.nodes) },
              };
              baseBoard.current = parsed.baseBoard || parsed.board;
              baseBrief.current =
                parsed.baseBrief ??
                (parsed.revision === result.project.revision ? result.project.brief : undefined);
              baseTitle.current =
                parsed.baseTitle ??
                (parsed.revision === result.project.revision ? result.project.title : undefined);
              local.baseBrief = baseBrief.current;
              local.baseTitle = baseTitle.current;
              change.current++;
              if (parsed.revision !== result.project.revision) {
                conflict.current = true;
                setSaveState('conflict');
                setSaveError('发现未保存的本地草稿，云端内容也已更新。请选择合并或重新加载。');
              } else setSaveState('pending');
            }
          }
        } catch {
          removeDraft(key);
        }
        current.current = local;
        setDraft(local);
        setDetail(result);
      })
      .catch((e) => {
        if (!ignore) setError(message(e));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
      live.current = false;
      clearTimeout(timer.current);
    };
  }, [id, key]);
  useEffect(() => {
    if (saveState !== 'pending') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush();
    }, 800);
    return () => clearTimeout(timer.current);
  }, [draft, saveState, flush]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (change.current !== saved.current) {
        store();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [store]);
  const update = useCallback(
    (patch: Partial<LocalDraft>, persist = true) => {
      if (!current.current) return;
      current.current = { ...current.current, ...patch };
      setDraft(current.current);
      if (persist) {
        change.current++;
        store();
        if (!conflict.current) setSaveState('pending');
      }
    },
    [store],
  );
  const pushHistory = useCallback(() => {
    if (!current.current) return;
    past.current = [...past.current.slice(-39), copyBoard(current.current.board)];
    future.current = [];
    setHistoryCount({ undo: past.current.length, redo: 0 });
  }, []);
  const undo = useCallback(() => {
    if (!past.current.length || !current.current) return;
    future.current.push(copyBoard(current.current.board));
    update({ board: past.current.pop()! });
    setHistoryCount({ undo: past.current.length, redo: future.current.length });
  }, [update]);
  const redo = useCallback(() => {
    if (!future.current.length || !current.current) return;
    past.current.push(copyBoard(current.current.board));
    update({ board: future.current.pop()! });
    setHistoryCount({ undo: past.current.length, redo: future.current.length });
  }, [update]);
  const refresh = useCallback(async () => {
    const result = await api<ProjectDetail>(`/projects/${id}`);
    if (!live.current) return;
    setDetail(result);
    if (change.current !== saved.current && result.project.revision !== server.current?.revision) {
      conflict.current = true;
      setSaveState('conflict');
      setSaveError('云端有新内容。你的本地编辑已保留，合并后可继续保存。');
      return;
    }
    if (change.current === saved.current) {
      server.current = result.project;
      baseBoard.current = result.project.board;
      baseBrief.current = result.project.brief;
      baseTitle.current = result.project.title;
      current.current = {
        revision: result.project.revision,
        title: result.project.title,
        brief: result.project.brief,
        baseBrief: result.project.brief,
        baseTitle: result.project.title,
        board: { ...result.project.board, nodes: orderedNodes(result.project.board.nodes) },
      };
      setDraft(current.current);
    }
  }, [id]);
  const merge = useCallback(async () => {
    const result = await api<ProjectDetail>(`/projects/${id}`);
    const local = current.current;
    if (!local) return;
    const board = mergeBoards(local.board, result.project.board, baseBoard.current);
    const fields = mergeProjectFields(local, result.project, {
      brief: baseBrief.current,
      title: baseTitle.current,
    });
    server.current = result.project;
    baseBoard.current = result.project.board;
    baseBrief.current = result.project.brief;
    baseTitle.current = result.project.title;
    conflict.current = false;
    setDetail(result);
    setSaveError('');
    update({
      revision: result.project.revision,
      board,
      ...fields,
      baseBrief: result.project.brief,
      baseTitle: result.project.title,
    });
    return flush();
  }, [id, update, flush]);
  const reload = useCallback(async () => {
    const result = await api<ProjectDetail>(`/projects/${id}`);
    conflict.current = false;
    saved.current = change.current;
    server.current = result.project;
    baseBoard.current = result.project.board;
    baseBrief.current = result.project.brief;
    baseTitle.current = result.project.title;
    current.current = {
      revision: result.project.revision,
      title: result.project.title,
      brief: result.project.brief,
      baseBrief: result.project.brief,
      baseTitle: result.project.title,
      board: { ...result.project.board, nodes: orderedNodes(result.project.board.nodes) },
    };
    setDetail(result);
    setDraft(current.current);
    setSaveState('saved');
    setSaveError('');
    removeDraft(key);
    past.current = [];
    future.current = [];
    setHistoryCount({ undo: 0, redo: 0 });
  }, [id, key]);
  const exportDraft = () =>
    saveBlob(
      new Blob([JSON.stringify(current.current, null, 2)], { type: 'application/json' }),
      `织作-${current.current?.title || '项目'}-本地草稿.json`,
    );
  return {
    detail,
    draft,
    loading,
    error,
    saveState,
    saveError,
    update,
    flush,
    refresh,
    merge,
    reload,
    exportDraft,
    pushHistory,
    undo,
    redo,
    historyCount,
    savedRevision: () => server.current?.revision,
  };
}
