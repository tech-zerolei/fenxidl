/**
 * Site grabber dialog (spec §5).
 *
 * Five-step wizard (start page, destination, explore filters, file filters,
 * run) with live statistics and a results table. Rebuilt on MD3 primitives.
 */

import React, { useEffect, useState } from 'react';
import type { AppSettings, GrabberProject, GrabberStats, IpcResult } from '../../shared/types';
import {
  Button,
  Checkbox,
  Dialog,
  LinearProgress,
  NumberField,
  SectionTitle,
  Supporting,
  TextField,
} from '../md3/components';
import { formatBytes } from '../main';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

interface GrabberFile {
  absoluteUrl: string;
  fileName: string;
  extension: string;
  linkText: string;
  depth: number;
  sizeBytes: number | null;
}

const STEPS = ['开始页面', '保存位置', '探索过滤器', '文件过滤器', '运行'];

function newProject(settings: AppSettings): GrabberProject {
  return {
    id: `p${Date.now().toString(36)}`,
    name: '',
    startUrl: '',
    saveDirectory: settings.defaultDirectory,
    onlyThisSite: true,
    wholeSite: true,
    maxDepth: 3,
    otherSiteDepth: 0,
    excludeParentDirs: true,
    includeTypes: [],
    excludeTypes: [],
    includePaths: [],
    excludePaths: [],
    minBytes: 0,
    maxBytes: 0,
    concurrentExplore: 3,
    concurrentDownload: 2,
    addToQueueOnClose: true,
    useLinkTextAsDescription: true,
    useRelativePaths: false,
    convertLinksForOffline: false,
    overwriteExisting: false,
    downloadAllMatches: false,
    filters: [],
    createdAt: Date.now(),
  };
}

export function GrabberDialog({
  settings,
  stats,
  onClose,
  onAddedToTasks,
  onError,
}: {
  settings: AppSettings;
  stats: GrabberStats;
  onClose: () => void;
  onAddedToTasks: (n: number) => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [step, setStep] = useState(0);
  const [project, setProject] = useState<GrabberProject>(() => newProject(settings));
  const [files, setFiles] = useState<GrabberFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [includeTypes, setIncludeTypes] = useState('');
  const [excludeTypes, setExcludeTypes] = useState('');
  const [includePaths, setIncludePaths] = useState('');
  const [excludePaths, setExcludePaths] = useState('');

  useEffect(() => {
    const offFiles = window.fenxi.onGrabberFiles((f) => setFiles(f as GrabberFile[]));
    const offLog = window.fenxi.onGrabberLog((m) => setLogs((prev) => [...prev.slice(-199), m]));
    return () => {
      offFiles();
      offLog();
    };
  }, []);

  useEffect(() => {
    setRunning(stats.status === 'exploring' || stats.status === 'downloading');
  }, [stats.status]);

  const patch = (p: Partial<GrabberProject>): void => setProject((prev) => ({ ...prev, ...p }));

  const parseList = (raw: string): string[] =>
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean);

  const start = async (): Promise<void> => {
    try {
      const payload: GrabberProject = {
        ...project,
        includeTypes: parseList(includeTypes),
        excludeTypes: parseList(excludeTypes),
        includePaths: parseList(includePaths),
        excludePaths: parseList(excludePaths),
      };
      await invoke('dl:grabberStart', payload);
      setStep(4);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const stop = async (): Promise<void> => {
    try {
      await invoke('dl:grabberStop');
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const addToTasks = async (): Promise<void> => {
    const chosen = files.filter((f) => selected.has(f.absoluteUrl)).map((f) => f.absoluteUrl);
    if (chosen.length === 0) {
      onError('请先勾选需要下载的文件。');
      return;
    }
    try {
      const n = await invoke<number>('dl:grabberAddToTasks', chosen);
      onAddedToTasks(n);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const saveProject = async (): Promise<void> => {
    if (!project.name.trim()) {
      onError('请为抓取方案输入名称。');
      return;
    }
    try {
      await invoke('dl:grabberSaveProject', project);
      onError('抓取方案已保存。');
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const progressPct =
    stats.filesFound > 0 ? (stats.filesMatched / stats.filesFound) * 100 : 0;

  return (
    <Dialog
      headline="站点抓取"
      subhead={`步骤 ${step + 1} / 5 — ${STEPS[step]}`}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <span className="spacer md-supporting" style={{ margin: 0 }}>
            {stats.pagesProcessed} 页 · {stats.filesFound} 个文件 · {stats.filesMatched} 个匹配
          </span>
          <Button
            variant="text"
            icon="arrow_back"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            上一步
          </Button>
          {step < 4 && (
            <>
              <Button
                variant="text"
                icon="arrow_forward"
                onClick={() => setStep((s) => Math.min(4, s + 1))}
              >
                下一步
              </Button>
              <Button
                variant="filled"
                icon="travel_explore"
                onClick={() => void start()}
                disabled={!project.startUrl.trim()}
              >
                开始抓取
              </Button>
            </>
          )}
          {step === 4 && (
            <>
              {running ? (
                <Button variant="danger" icon="stop" onClick={() => void stop()}>
                  停止
                </Button>
              ) : (
                <Button
                  variant="tonal"
                  icon="refresh"
                  onClick={() => void start()}
                  disabled={!project.startUrl.trim()}
                >
                  重新抓取
                </Button>
              )}
              <Button variant="filled" icon="add" onClick={() => void addToTasks()}>
                加入任务（{selected.size}）
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="md-steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            className={`md-step${i === step ? ' active' : doneClass(i, step)}`}
            onClick={() => setStep(i)}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <>
          <TextField
            label="抓取方案名称"
            value={project.name}
            onChange={(v) => patch({ name: v })}
            placeholder="例如：图片站抓取"
            help="保存后可重复使用，也便于制定计划任务"
          />
          <TextField
            label="开始页面/地址"
            value={project.startUrl}
            onChange={(v) => patch({ startUrl: v })}
            placeholder="https://example.com/gallery"
            mono
          />
          <Checkbox checked={project.onlyThisSite} onChange={(v) => patch({ onlyThisSite: v })}>
            只在此站点搜索文件
          </Checkbox>
          <Checkbox
            checked={project.wholeSite}
            onChange={(v) => patch({ wholeSite: v })}
            supporting="关闭后按下方深度限制"
          >
            探索整个站点
          </Checkbox>
          <div className="md-row" style={{ marginTop: 8 }}>
            <NumberField
              label="根站点的深度"
              value={project.maxDepth}
              onChange={(v) => patch({ maxDepth: v })}
              min={0}
              max={20}
            />
            <NumberField
              label="其他站点的深度"
              value={project.otherSiteDepth}
              onChange={(v) => patch({ otherSiteDepth: v })}
              min={0}
              max={10}
            />
          </div>
          <Checkbox
            checked={project.excludeParentDirs}
            onChange={(v) => patch({ excludeParentDirs: v })}
          >
            不要探索父目录
          </Checkbox>
        </>
      )}

      {step === 1 && (
        <>
          <TextField
            label="保存到"
            value={project.saveDirectory}
            onChange={(v) => patch({ saveDirectory: v })}
          />
          <Checkbox
            checked={project.useRelativePaths}
            onChange={(v) => patch({ useRelativePaths: v })}
          >
            使用原来的相对路径
          </Checkbox>
          <Checkbox
            checked={project.convertLinksForOffline}
            onChange={(v) => patch({ convertLinksForOffline: v })}
          >
            将 HTML 网页中的链接转换为本地链接以便离线浏览
          </Checkbox>
          <Checkbox checked={project.overwriteExisting} onChange={(v) => patch({ overwriteExisting: v })}>
            覆盖已存在的文件
          </Checkbox>
          <Checkbox
            checked={project.addToQueueOnClose}
            onChange={(v) => patch({ addToQueueOnClose: v })}
          >
            关闭时把选中的文件加入任务列表与队列
          </Checkbox>
          <Checkbox
            checked={project.useLinkTextAsDescription}
            onChange={(v) => patch({ useLinkTextAsDescription: v })}
          >
            将链接文字用作下载描述
          </Checkbox>
          <Checkbox
            checked={project.downloadAllMatches}
            onChange={(v) => patch({ downloadAllMatches: v })}
          >
            同时开始下载所有匹配的文件
          </Checkbox>
        </>
      )}

      {step === 2 && (
        <>
          <div className="md-row">
            <NumberField
              label="同时探索的文件数量"
              value={project.concurrentExplore}
              onChange={(v) => patch({ concurrentExplore: Math.min(10, Math.max(1, v)) })}
              min={1}
              max={10}
              help="1–10"
            />
            <NumberField
              label="同时下载的文件数量"
              value={project.concurrentDownload}
              onChange={(v) => patch({ concurrentDownload: Math.min(10, Math.max(1, v)) })}
              min={1}
              max={10}
              help="1–10"
            />
          </div>
          <TextField
            label="只下载下列路径/域内的文件"
            value={includePaths}
            onChange={setIncludePaths}
            help="使用分号(;)分隔各条目"
            mono
          />
          <TextField
            label="不要下载下列路径/域内的文件"
            value={excludePaths}
            onChange={setExcludePaths}
            mono
          />
          <Supporting>
            请注意：如果同时探索/下载很多文件，服务器可能会拒绝请求。
          </Supporting>
        </>
      )}

      {step === 3 && (
        <>
          <TextField
            label="下载下列文件（文件类型）"
            value={includeTypes}
            onChange={setIncludeTypes}
            help="以空格分隔扩展名，例如：jpg png zip"
            mono
          />
          <TextField
            label="不要下载下列文件（文件类型）"
            value={excludeTypes}
            onChange={setExcludeTypes}
            mono
          />
          <div className="md-row">
            <NumberField
              label="大小下限（字节）"
              value={project.minBytes}
              onChange={(v) => patch({ minBytes: v })}
              min={0}
              help="0 表示不限"
            />
            <NumberField
              label="大小上限（字节）"
              value={project.maxBytes}
              onChange={(v) => patch({ maxBytes: v })}
              min={0}
              help="0 表示不限"
            />
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <span className={`md-badge ${stats.status === 'completed' ? 'completed' : stats.status === 'stopped' ? 'error' : 'downloading'}`}>
              {{ idle: '空闲', exploring: '正在探索', downloading: '正在下载', completed: '完成', stopped: '已停止' }[stats.status]}
            </span>
            <span className="md-supporting" style={{ margin: 0 }}>
              已处理网页 {stats.pagesProcessed} · 找到 {stats.filesFound} · 匹配 {stats.filesMatched}
            </span>
            <div className="md-spacer" />
            <Button variant="text" onClick={() => setSelected(new Set(files.map((f) => f.absoluteUrl)))}>
              全选
            </Button>
            <Button variant="text" onClick={() => setSelected(new Set())}>清空</Button>
            <Button variant="text" icon="save" onClick={() => void saveProject()}>保存方案</Button>
          </div>

          <LinearProgress value={progressPct} />

          <div
            style={{
              maxHeight: 300,
              overflowY: 'auto',
              border: '1px solid var(--md-outline-variant)',
              borderRadius: 'var(--md-shape-sm)',
              marginTop: 12,
            }}
          >
            {files.length === 0 ? (
              <div style={{ padding: 20 }}>
                <Supporting>尚未找到匹配的文件。</Supporting>
              </div>
            ) : (
              <table className="md-table">
                <thead>
                  <tr>
                    <th className="static" style={{ width: 44 }}>
                      <input
                        type="checkbox"
                        checked={files.length > 0 && selected.size === files.length}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? new Set(files.map((f) => f.absoluteUrl)) : new Set(),
                          )
                        }
                        aria-label="全选"
                      />
                    </th>
                    <th className="static">文件名</th>
                    <th className="static" style={{ width: 80 }}>类型</th>
                    <th className="static numeric" style={{ width: 100 }}>大小</th>
                    <th className="static numeric" style={{ width: 64 }}>深度</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.absoluteUrl}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(f.absoluteUrl)}
                          onChange={(e) => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(f.absoluteUrl);
                              else next.delete(f.absoluteUrl);
                              return next;
                            });
                          }}
                          aria-label={`选择 ${f.fileName}`}
                        />
                      </td>
                      <td title={f.absoluteUrl}>{f.fileName}</td>
                      <td className="secondary md-mono">{f.extension}</td>
                      <td className="numeric">{f.sizeBytes ? formatBytes(f.sizeBytes) : '—'}</td>
                      <td className="numeric secondary">{f.depth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {logs.length > 0 && (
            <>
              <SectionTitle>日志</SectionTitle>
              <div
                className="md-mono"
                style={{
                  maxHeight: 110,
                  overflowY: 'auto',
                  background: 'var(--md-surface-container-lowest)',
                  border: '1px solid var(--md-outline-variant)',
                  borderRadius: 'var(--md-shape-sm)',
                  padding: 10,
                  lineHeight: 1.7,
                  color: 'var(--md-on-surface-variant)',
                }}
              >
                {logs.slice(-30).map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

/** Steps before the current one render with the completed outline style. */
function doneClass(index: number, current: number): string {
  return index < current ? ' done' : '';
}
