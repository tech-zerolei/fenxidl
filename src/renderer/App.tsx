/**
 * Main application shell: sidebar, toolbar, task table and modal routing.
 *
 * Layout and controls mirror the reverse-engineered main dialog (spec §1):
 * the seven task-list columns, the category sidebar, the toolbar actions and
 * the seven sort orders are all present.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CategoryId,
  DownloadTask,
  GrabberStats,
  IpcResult,
  ProgressSnapshot,
} from '../shared/types';
import { formatBytes, formatEta, formatSpeed, fileColor, fileGlyph } from './main';
import { NewTaskDialog } from './dialogs/NewTaskDialog';
import { OptionsDialog } from './dialogs/OptionsDialog';
import { SchedulerDialog } from './dialogs/SchedulerDialog';
import { ProgressDialog } from './dialogs/ProgressDialog';
import { BatchDialog } from './dialogs/BatchDialog';
import { GrabberDialog } from './dialogs/GrabberDialog';
import { TaskPropertiesDialog } from './dialogs/TaskPropertiesDialog';
import { AboutDialog } from './dialogs/AboutDialog';
import { MediaDialog } from './dialogs/MediaDialog';
import { Icon, iconForCategory } from './md3/icons';
import {
  Button,
  Fab,
  IconButton,
  LinearProgress,
  NavigationRail,
  SearchBar,
  SnackbarStack,
  StatusBadge,
  type RailItem,
  type SnackbarMessage,
} from './md3/components';

declare global {
  interface Window {
    fenxi: {
      invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
      onSnapshot: (h: (p: ProgressSnapshot) => void) => () => void;
      onLog: (h: (m: string) => void) => () => void;
      onClipboardUrl: (h: (url: string) => void) => () => void;
      onGrabberStats: (h: (s: GrabberStats) => void) => () => void;
      onGrabberFiles: (h: (f: unknown[]) => void) => () => void;
      onGrabberLog: (h: (m: string) => void) => () => void;
      onMediaSniffed: (h: (p: unknown[]) => void) => () => void;
    };
  }
}

type SortKey = 'added' | 'name' | 'size' | 'status' | 'eta' | 'speed' | 'description';

const SORT_LABELS: Record<SortKey, string> = {
  added: '按添加时间',
  name: '按文件名称',
  size: '按文件大小',
  status: '按文件状态',
  eta: '按剩余时间',
  speed: '按传输速度',
  description: '按文件描述',
};

const CATEGORIES: Array<{ id: CategoryId | 'all' | 'active' | 'finished'; label: string; icon: string }> = [
  { id: 'all', label: '所有下载', icon: '▤' },
  { id: 'active', label: '正在下载', icon: '↓' },
  { id: 'finished', label: '已完成', icon: '✓' },
  { id: 'programs', label: '程序', icon: '⚙' },
  { id: 'music', label: '音乐', icon: '♪' },
  { id: 'video', label: '视频', icon: '▶' },
  { id: 'games', label: '游戏', icon: '◈' },
  { id: 'documents', label: '文档', icon: '▣' },
  { id: 'archives', label: '压缩文件', icon: '▦' },
  { id: 'other', label: '其他', icon: '○' },
];

const STATUS_LABELS: Record<DownloadTask['status'], string> = {
  queued: '排队中',
  connecting: '正在连接',
  downloading: '正在下载',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  error: '错误',
};

type ModalKind =
  | { kind: 'none' }
  | { kind: 'new'; prefillUrl?: string }
  | { kind: 'options'; tab?: string }
  | { kind: 'scheduler' }
  | { kind: 'progress'; taskId: string }
  | { kind: 'batch' }
  | { kind: 'grabber' }
  | { kind: 'properties'; taskId: string }
  | { kind: 'about' }
  | { kind: 'media' };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res || typeof res !== 'object') throw new Error('The application service did not respond.');
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

export function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ProgressSnapshot | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<CategoryId | 'all' | 'active' | 'finished'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('added');
  const [sortDesc, setSortDesc] = useState(true);
  const [modal, setModal] = useState<ModalKind>({ kind: 'none' });
  const [toasts, setToasts] = useState<SnackbarMessage[]>([]);
  const [filter, setFilter] = useState('');
  const [uiFlags, setUiFlags] = useState<{
    showStartDialog: boolean;
    showProgressDialog: boolean;
    showCompleteDialog: boolean;
    showTipsOnStartup: boolean;
    language: string;
  } | null>(null);
  const [grabberStats, setGrabberStats] = useState<GrabberStats>({
    status: 'idle',
    pagesProcessed: 0,
    filesFound: 0,
    filesMatched: 0,
    filesDownloaded: 0,
  });
  const lastRowClick = useRef<{ id: string; at: number } | null>(null);
  const autoOpenedRef = useRef<Set<string>>(new Set());

  const toast = useCallback((message: string, kind: SnackbarMessage['kind'] = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5200);
  }, []);

  const run = useCallback(
    async <T,>(channel: string, ...args: unknown[]): Promise<T | null> => {
      try {
        return await call<T>(channel, ...args);
      } catch (err) {
        toast((err as Error).message, 'error');
        return null;
      }
    },
    [toast],
  );

  // Subscribe to main-process pushes.
  useEffect(() => {
    const offSnap = window.fenxi.onSnapshot((p) => setSnapshot(p));
    const offLog = window.fenxi.onLog((m) => toast(m));
    const offClip = window.fenxi.onClipboardUrl((url) => {
      void call<{ showStartDialog: boolean }>('dl:uiFlags')
        .then((flags) => {
          if (flags.showStartDialog) {
            setModal((current) => (current.kind === 'none' ? { kind: 'new', prefillUrl: url } : current));
          } else {
            // The dialog is disabled: queue the URL directly.
            return call('dl:createTask', { url }).then(() => toast('已从剪贴板添加下载任务', 'success'));
          }
          return undefined;
        })
        .catch((err: Error) => toast(err.message, 'error'));
    });
    const offStats = window.fenxi.onGrabberStats((s) => setGrabberStats(s));
    void call<ProgressSnapshot>('dl:snapshot').then(setSnapshot).catch(() => undefined);
    void call<typeof uiFlags>('dl:uiFlags').then(setUiFlags).catch(() => undefined);
    return () => {
      offSnap();
      offLog();
      offClip();
      offStats();
    };
  }, [toast]);

  const tasks = snapshot?.tasks ?? [];
  const queues = snapshot?.queues ?? [];
  const settings = snapshot?.settings ?? null;
  const stats = snapshot?.stats ?? { activeCount: 0, totalSpeed: 0, quotaUsedToday: 0 };

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    map.set('all', tasks.length);
    map.set('active', tasks.filter((t) => t.status === 'downloading' || t.status === 'connecting' || t.status === 'queued').length);
    map.set('finished', tasks.filter((t) => t.status === 'completed').length);
    for (const c of CATEGORIES) {
      if (c.id === 'all' || c.id === 'active' || c.id === 'finished') continue;
      map.set(c.id, tasks.filter((t) => t.categoryId === c.id).length);
    }
    return map;
  }, [tasks]);

  const visible = useMemo(() => {
    let list = tasks;
    if (category === 'active') {
      list = list.filter((t) => t.status === 'downloading' || t.status === 'connecting' || t.status === 'queued' || t.status === 'paused');
    } else if (category === 'finished') {
      list = list.filter((t) => t.status === 'completed');
    } else if (category !== 'all') {
      list = list.filter((t) => t.categoryId === category);
    }
    const needle = filter.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (t) =>
          t.fileName.toLowerCase().includes(needle)
          || t.url.toLowerCase().includes(needle)
          || t.description.toLowerCase().includes(needle),
      );
    }
    const dir = sortDesc ? -1 : 1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.fileName.localeCompare(b.fileName, 'zh-Hans-CN') * dir;
        case 'size':
          return (a.totalBytes - b.totalBytes) * dir;
        case 'status':
          return a.status.localeCompare(b.status) * dir;
        case 'eta': {
          const av = Number.isFinite(a.eta) ? a.eta : Number.MAX_SAFE_INTEGER;
          const bv = Number.isFinite(b.eta) ? b.eta : Number.MAX_SAFE_INTEGER;
          return (av - bv) * dir;
        }
        case 'speed':
          return (a.speed - b.speed) * dir;
        case 'description':
          return a.description.localeCompare(b.description, 'zh-Hans-CN') * dir;
        case 'added':
        default:
          return (a.createdAt - b.createdAt) * dir;
      }
    });
  }, [tasks, category, filter, sortKey, sortDesc]);

  const selectedTasks = useMemo(() => tasks.filter((t) => selected.has(t.id)), [tasks, selected]);

  const queueName = useCallback(
    (id: string | null): string => {
      if (id === null) return queues.find((q) => q.isPrimary)?.name ?? '主要下载队列';
      return queues.find((q) => q.id === id)?.name ?? '—';
    },
    [queues],
  );

  const queueBadge = useCallback(
    (id: string | null): string => {
      if (id === null) return 'M';
      const idx = queues.findIndex((q) => q.id === id);
      return idx >= 0 ? String(idx) : '?';
    },
    [queues],
  );

  const onRowClick = (task: DownloadTask, event: React.MouseEvent): void => {
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(task.id)) next.delete(task.id);
        else next.add(task.id);
        return next;
      });
      lastRowClick.current = { id: task.id, at: Date.now() };
      return;
    }
    if (event.shiftKey && selected.size > 0) {
      const order = visible.map((t) => t.id);
      const anchorId = lastRowClick.current?.id ?? [...selected][0];
      const a = order.indexOf(anchorId);
      const b = order.indexOf(task.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(order.slice(lo, hi + 1)));
        return;
      }
    }
    setSelected(new Set([task.id]));
    lastRowClick.current = { id: task.id, at: Date.now() };
  };

  const onRowDoubleClick = (task: DownloadTask): void => {
    if (task.status === 'completed') void run('dl:openFile', task.id);
    else setModal({ kind: 'progress', taskId: task.id });
  };

  // When enabled, surface the progress dialog for a task that just started.
  useEffect(() => {
    if (!uiFlags?.showProgressDialog) return;
    const active = tasks.find((t) => t.status === 'downloading');
    if (!active) return;
    setModal((current) => {
      if (current.kind !== 'none') return current;
      // Only auto-open once per task so the user can dismiss it.
      if (autoOpenedRef.current.has(active.id)) return current;
      autoOpenedRef.current.add(active.id);
      return { kind: 'progress', taskId: active.id };
    });
  }, [tasks, uiFlags]);

  const act = {
    start: async () => {
      for (const t of selectedTasks) await run('dl:startTask', t.id);
    },
    pause: async () => {
      for (const t of selectedTasks) await run('dl:pauseTask', t.id);
    },
    stop: async () => {
      for (const t of selectedTasks) await run('dl:stopTask', t.id);
    },
    remove: async () => {
      for (const t of selectedTasks) await run('dl:removeTask', t.id, false);
      setSelected(new Set());
    },
    removeCompleted: async () => {
      await run('dl:removeCompleted');
    },
    stopAll: async () => {
      await run('dl:stopAll');
    },
    startQueue: async (queueId: string | null) => {
      await run('dl:startQueue', queueId);
    },
    stopQueue: async (queueId: string | null) => {
      await run('dl:stopQueue', queueId);
    },
    exportTasks: async (format: 'fdx' | 'text') => {
      const path = await run<string | null>('dl:exportTasks', format);
      if (path) toast(`已导出到 ${path}`, 'success');
    },
    importTasks: async () => {
      const res = await run<{ imported: number }>('dl:importTasks');
      if (res) toast(`已导入 ${res.imported} 个任务`, 'success');
    },
  };

  const hasSelection = selectedTasks.length > 0;
  const canStart = selectedTasks.some((t) => ['stopped', 'paused', 'error', 'queued'].includes(t.status));
  const canPause = selectedTasks.some((t) => t.status === 'downloading' || t.status === 'connecting');

  const toggleSort = (key: SortKey): void => {
    if (sortKey === key) setSortDesc(!sortDesc);
    else {
      setSortKey(key);
      setSortDesc(key === 'added');
    }
  };

  // Sortable headers are real controls: they take focus, expose aria-sort, and
  // respond to Enter/Space. A bare onClick <th> made sorting mouse-only.
  const sortHeader = (key: SortKey, label: string): React.ReactElement => (
    <th
      scope="col"
      role="columnheader"
      tabIndex={0}
      onClick={() => toggleSort(key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSort(key);
        }
      }}
      title={`排序：${SORT_LABELS[key]}`}
      aria-sort={sortKey === key ? (sortDesc ? 'descending' : 'ascending') : 'none'}
    >
      {label}
      {sortKey === key && <span className="sort-arrow" aria-hidden>{sortDesc ? '▼' : '▲'}</span>}
    </th>
  );

  // Rail destinations. Primary views come first; the file-type shortcuts
  // follow, then the queues, matching MD3 navigation-rail ordering.
  const primaryRail: RailItem<string>[] = [
    { id: 'all', label: '所有下载', icon: 'apps', count: counts.get('all') },
    { id: 'active', label: '正在下载', icon: 'download', count: counts.get('active') },
    { id: 'finished', label: '已完成', icon: 'check_circle', count: counts.get('finished') },
  ];
  const typeRail: RailItem<string>[] = CATEGORIES.slice(3).map((c) => ({
    id: c.id,
    label: c.label,
    icon: iconForCategory(c.id),
    count: counts.get(c.id),
  }));

  const railFooter = (
    <>
      <button
        type="button"
        className="md-nav-rail__item"
        onClick={() => setModal({ kind: 'about' })}
        title="关于 FenxiDL"
      >
        <span className="md-nav-rail__indicator">
          <span className="md-nav-rail__icon" aria-hidden>
            <Icon name="info" size={22} />
          </span>
        </span>
        <span className="md-nav-rail__label">关于</span>
      </button>
    </>
  );

  // When rows are selected the top app bar turns contextual (MD3 pattern):
  // it reports the count and exposes the actions that apply to the selection.
  const contextual = hasSelection;

  return (
    <div className="md-app">
      <header className={`md-top-app-bar${contextual ? ' contextual' : ''}`}>
        {contextual ? (
          <>
            <IconButton icon="close" label="取消选择" onClick={() => setSelected(new Set())} />
            <div className="md-top-app-bar__title" style={{ marginLeft: 8 }}>
              已选择 {selectedTasks.length} 项
            </div>
            <div className="md-top-app-bar__actions">
              <IconButton icon="play" label="继续下载选中的文件" onClick={() => void act.start()} disabled={!canStart} />
              <IconButton icon="pause" label="暂停选中的文件" onClick={() => void act.pause()} disabled={!canPause} />
              <IconButton icon="stop" label="停止选中的文件" onClick={() => void act.stop()} />
              <IconButton icon="delete" label="从列表中删除选中的任务" onClick={() => void act.remove()} />
            </div>
          </>
        ) : (
          <>
            <div className="md-top-app-bar__title">
              <div className="md-brand" aria-hidden>F</div>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span>FenxiDL</span>
                <span className="md-top-app-bar__subtitle">高速下载管理器</span>
              </div>
            </div>
            <div className="md-top-app-bar__actions">
              <SearchBar value={filter} onChange={setFilter} placeholder="搜索文件名或地址" />
              <div className={`md-speed${stats.activeCount > 0 ? ' active' : ''}`} title="当前总传输速率">
                <span className="md-speed__dot" />
                {stats.activeCount > 0 ? formatSpeed(stats.totalSpeed) : '空闲'}
              </div>
              <IconButton icon="list_alt" label="批量下载（通配符模板）" onClick={() => setModal({ kind: 'batch' })} />
              <IconButton icon="travel_explore" label="站点抓取" onClick={() => setModal({ kind: 'grabber' })} />
              <IconButton icon="movie" label="媒体嗅探（浏览器捕获的音视频）" onClick={() => setModal({ kind: 'media' })} />
              <IconButton icon="schedule" label="计划任务及下载队列" onClick={() => setModal({ kind: 'scheduler' })} />
              <IconButton icon="settings" label="选项" onClick={() => setModal({ kind: 'options' })} />
            </div>
          </>
        )}
      </header>

      <div className="md-app-body">
        <NavigationRail
          items={primaryRail}
          groups={[
            {
              key: 'types',
              label: '分类',
              icon: 'category',
              headline: '按文件类型筛选',
              items: typeRail,
            },
          ]}
          value={category}
          onChange={(id) => setCategory(id as typeof category)}
          header={
            <div className="md-nav-rail__fab">
              <Fab icon="add" label="新建下载" onClick={() => setModal({ kind: 'new' })} />
            </div>
          }
          footer={railFooter}
        />

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Queue actions live in a persistent surface strip so they stay
              reachable regardless of selection state. */}
          <div className="md-toolbar">
            <Button variant="filled" icon="add" onClick={() => setModal({ kind: 'new' })}>
              新建下载
            </Button>
            <div className="md-toolbar-separator" aria-hidden />
            <Button variant="text" icon="play" onClick={() => void act.startQueue(null)} title="开始主要下载队列">
              开始队列
            </Button>
            <Button variant="text" icon="stop" onClick={() => void act.stopQueue(null)} title="停止主要下载队列">
              停止队列
            </Button>
            <Button variant="text" icon="stop" onClick={() => void act.stopAll()} title="停止全部的下载任务">
              全部停止
            </Button>
            <div className="md-toolbar-separator" aria-hidden />
            <Button variant="text" icon="clear_all" onClick={() => void act.removeCompleted()} title="从列表中删除全部已完成的任务">
              清理已完成
            </Button>
            <div className="md-spacer" />
            <span className="md-supporting" style={{ margin: 0 }}>
              {visible.length} 个文件
              {filter && ` · 筛选 "${filter}"`}
            </span>
          </div>

          <div className="md-table-region">
            {visible.length === 0 ? (
              <div className="md-empty">
                <div className="md-empty__icon" aria-hidden>
                  <Icon name="download" size={56} />
                </div>
                <div className="md-empty__title">
                  {tasks.length === 0 ? '还没有下载任务' : '此分类中没有文件'}
                </div>
                <p className="md-empty__body">
                  {tasks.length === 0
                    ? '点击「新建下载」添加地址，或把浏览器中的下载链接复制到剪贴板（已开启监视）。'
                    : filter
                      ? `没有匹配「${filter}」的文件。清除筛选条件即可看到当前分类的全部文件。`
                      : '此分类中还没有文件，切换到「所有下载」可以看到全部任务。'}
                </p>
                {/* Every empty state offers a way out. Previously only the
                    "no tasks at all" branch had a button, so a filtered-empty
                    list told the user to clear the search but gave them
                    nothing to click. */}
                {tasks.length === 0 ? (
                  <Button variant="filled" icon="add" onClick={() => setModal({ kind: 'new' })}>
                    新建下载
                  </Button>
                ) : filter ? (
                  <Button variant="tonal" icon="refresh" onClick={() => setFilter('')}>
                    清除筛选条件
                  </Button>
                ) : (
                  <Button variant="tonal" icon="clear_all" onClick={() => setCategory('all')}>
                    查看所有下载
                  </Button>
                )}
              </div>
            ) : (
              <table className="md-table">
                {/* Fixed columns used to total 828px against 810px of table at
                    the 900x520 minimum window, which collapsed 文件名 to 0px.
                    Column widths are now ceilings and the @media rules fold the
                    secondary columns away in priority order, so the file name
                    always keeps a floor. */}
                <colgroup>
                  <col style={{ width: 56 }} />
                  <col style={{ minWidth: 200 }} />
                  <col style={{ width: 'min(160px, 14vw)' }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 96 }} />
                  <col style={{ width: 104 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 'min(180px, 16vw)' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="static" scope="col" role="columnheader" title="所属队列">
                      队列
                    </th>
                    {sortHeader('name', '文件名')}
                    {sortHeader('description', '描述')}
                    {sortHeader('status', '状态')}
                    {sortHeader('size', '大小')}
                    {sortHeader('eta', '剩余时间')}
                    {sortHeader('speed', '传输速率')}
                    <th className="static" scope="col" role="columnheader">进度</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((task) => {
                    const pct = task.totalBytes > 0 ? (task.downloadedBytes / task.totalBytes) * 100 : 0;
                    const progressVariant =
                      task.status === 'completed' ? 'completed'
                        : task.status === 'error' ? 'error'
                          : task.status === 'paused' ? 'paused'
                            : undefined;
                    return (
                      <tr
                        key={task.id}
                        className={selected.has(task.id) ? 'selected' : undefined}
                        // Rows are the primary selection control, so they must be
                        // reachable and operable without a mouse; otherwise every
                        // selection-only action is unavailable to keyboard users.
                        tabIndex={0}
                        aria-selected={selected.has(task.id)}
                        onClick={(e) => onRowClick(task, e)}
                        onDoubleClick={() => onRowDoubleClick(task)}
                        onKeyDown={(e) => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault();
                            setSelected(new Set([task.id]));
                            lastRowClick.current = { id: task.id, at: Date.now() };
                            // Enter also opens the row, mirroring double-click.
                            if (e.key === 'Enter') onRowDoubleClick(task);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!selected.has(task.id)) setSelected(new Set([task.id]));
                          setModal({ kind: 'properties', taskId: task.id });
                        }}
                      >
                        <td>
                          <span className="md-queue-marker" title={queueName(task.queueId)}>
                            {queueBadge(task.queueId)}
                          </span>
                        </td>
                        <td>
                          <div className="md-file-cell">
                            <span
                              className="md-file-cell__glyph"
                              style={{
                                background: fileColor(task.fileName).bg,
                                color: fileColor(task.fileName).fg,
                              }}
                              aria-hidden
                            >
                              {fileGlyph(task.fileName)}
                            </span>
                            <span className="md-file-cell__name" title={task.savePath}>
                              {task.fileName}
                            </span>
                          </div>
                        </td>
                        <td className="secondary" title={task.description}>
                          {task.description || '—'}
                        </td>
                        <td>
                          <StatusBadge status={task.status} label={STATUS_LABELS[task.status]} />
                        </td>
                        <td className="numeric">
                          {task.totalBytes > 0 ? formatBytes(task.totalBytes) : '未知'}
                        </td>
                        <td className="numeric">
                          {task.status === 'downloading' ? formatEta(task.eta) : '—'}
                        </td>
                        <td className="numeric">
                          {task.status === 'downloading' ? formatSpeed(task.speed) : '—'}
                        </td>
                        <td>
                          <LinearProgress value={pct} variant={progressVariant} />
                          <div className="md-progress-meta">
                            {task.totalBytes > 0
                              ? `${pct.toFixed(1)}% · ${formatBytes(task.downloadedBytes)}`
                              : formatBytes(task.downloadedBytes)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </main>
      </div>

      {modal.kind === 'new' && (
        <NewTaskDialog
          settings={settings}
          queues={queues}
          prefillUrl={modal.prefillUrl}
          onClose={() => setModal({ kind: 'none' })}
          onCreated={() => {
            setModal({ kind: 'none' });
            toast('任务已添加', 'success');
          }}
          onError={(m) => toast(m, 'error')}
        />
      )}
      {modal.kind === 'options' && settings && (
        <OptionsDialog
          settings={settings}
          initialTab={modal.tab}
          queues={queues}
          onClose={() => setModal({ kind: 'none' })}
          onSaved={() => toast('设置已保存', 'success')}
          onError={(m) => toast(m, 'error')}
        />
      )}
      {modal.kind === 'scheduler' && snapshot && (
        <SchedulerDialog
          queues={queues}
          schedules={snapshot.schedules}
          tasks={tasks}
          onClose={() => setModal({ kind: 'none' })}
          onError={(m) => toast(m, 'error')}
          onSaved={() => toast('计划任务已保存', 'success')}
        />
      )}
      {modal.kind === 'progress' && (
        <ProgressDialog
          task={tasks.find((t) => t.id === modal.taskId) ?? null}
          onClose={() => setModal({ kind: 'none' })}
          onOpenFile={(id) => void run('dl:openFile', id)}
          onOpenFolder={(id) => void run('dl:openFolder', id)}
          onError={(m) => toast(m, 'error')}
        />
      )}
      {modal.kind === 'properties' && (
        <TaskPropertiesDialog
          task={tasks.find((t) => t.id === modal.taskId) ?? null}
          queues={queues}
          onClose={() => setModal({ kind: 'none' })}
          onError={(m) => toast(m, 'error')}
          onSaved={() => toast('任务属性已更新', 'success')}
        />
      )}
      {modal.kind === 'batch' && settings && (
        <BatchDialog
          settings={settings}
          onClose={() => setModal({ kind: 'none' })}
          onAdded={(n) => {
            setModal({ kind: 'none' });
            toast(`已添加 ${n} 个下载任务`, 'success');
          }}
          onError={(m) => toast(m, 'error')}
        />
      )}
      {modal.kind === 'grabber' && settings && (
        <GrabberDialog
          settings={settings}
          stats={grabberStats}
          onClose={() => setModal({ kind: 'none' })}
          onAddedToTasks={(n) => toast(`已加入任务列表：${n} 个文件`, 'success')}
          onError={(m) => toast(m, 'error')}
        />
      )}
      {modal.kind === 'media' && (
        <MediaDialog
          onClose={() => setModal({ kind: 'none' })}
          onAdded={(n) => toast(`已添加 ${n} 个媒体下载任务`, 'success')}
          onError={(m) => toast(m, 'error')}
        />
      )}
      {modal.kind === 'about' && <AboutDialog settings={settings} onClose={() => setModal({ kind: 'none' })} />}

      <SnackbarStack messages={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}
