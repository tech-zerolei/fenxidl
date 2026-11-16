/**
 * New download task dialog (spec §4).
 *
 * MD3 basic dialog: URL entry with a live probe, destination, category, queue,
 * connection count and an expandable advanced section.
 */

import React, { useEffect, useState } from 'react';
import type { AppSettings, CategoryId, IpcResult, Queue } from '../../shared/types';
import {
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  SectionTitle,
  SelectField,
  Supporting,
  TextField,
  NumberField,
} from '../md3/components';
import { formatBytes } from '../main';

interface ProbeInfo {
  ok: boolean;
  fileName: string | null;
  totalBytes: number;
  supportsResume: boolean;
  mimeType: string | null;
  error: string | null;
  requiresAuth: boolean;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

export function NewTaskDialog({
  settings,
  queues,
  prefillUrl,
  onClose,
  onCreated,
  onError,
}: {
  settings: AppSettings | null;
  queues: Queue[];
  prefillUrl?: string;
  onClose: () => void;
  onCreated: () => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [url, setUrl] = useState(prefillUrl ?? '');
  const [fileName, setFileName] = useState('');
  const [directory, setDirectory] = useState(settings?.defaultDirectory ?? '');
  const [categoryId, setCategoryId] = useState<CategoryId>('other');
  const [description, setDescription] = useState('');
  const [connections, setConnections] = useState(settings?.defaultConnections ?? 8);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [referer, setReferer] = useState('');
  const [queueId, setQueueId] = useState<string | null>(null);
  const [addToQueueOnly, setAddToQueueOnly] = useState(false);
  const [openWhenDone, setOpenWhenDone] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Re-probe the URL after the user stops typing.
  useEffect(() => {
    const trimmed = url.trim();
    if (!/^https?:\/\/\S+$/i.test(trimmed)) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    setProbing(true);
    const timer = setTimeout(() => {
      invoke<ProbeInfo>('dl:probeUrl', trimmed)
        .then((info) => {
          if (cancelled) return;
          setProbe(info);
          if (info.ok) {
            if (info.fileName && !fileName) setFileName(info.fileName);
            if (info.totalBytes > 0) {
              const name = (info.fileName ?? trimmed).toLowerCase();
              const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
              const rule = settings?.categories.find(
                (c) => c.id !== 'completed' && c.extensions.includes(ext),
              );
              if (rule) {
                setCategoryId(rule.id);
                if (rule.directory) setDirectory(rule.directory);
              }
            }
          }
        })
        .catch((err: Error) => {
          if (!cancelled) {
            setProbe({
              ok: false,
              fileName: null,
              totalBytes: 0,
              supportsResume: false,
              mimeType: null,
              error: err.message,
              requiresAuth: false,
            });
          }
        })
        .finally(() => {
          if (!cancelled) setProbing(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, fileName, settings]);

  // Keep the folder aligned with the selected category.
  useEffect(() => {
    if (!settings) return;
    const rule = settings.categories.find((c) => c.id === categoryId);
    if (rule?.directory) setDirectory(rule.directory);
  }, [categoryId, settings]);

  const browse = async (): Promise<void> => {
    try {
      const chosen = await invoke<string | null>('dl:chooseDirectory', directory);
      if (chosen) setDirectory(chosen);
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const submit = async (): Promise<void> => {
    if (!url.trim()) {
      onError('请输入下载地址。');
      return;
    }
    setBusy(true);
    try {
      await invoke('dl:createTask', {
        url: url.trim(),
        fileName: fileName.trim() || undefined,
        directory: directory.trim() || undefined,
        categoryId,
        description: description.trim(),
        connections,
        username: username || null,
        password: password || null,
        referer: referer || null,
        queueId,
        addToQueueOnly,
        // The button label already says 开始下载 / 加入队列, so make the intent
        // explicit and let the main process honour it instead of re-deciding
        // from the file extension.
        startNow: !addToQueueOnly,
        openWhenDone,
      });
      onCreated();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const categoryOptions = (settings?.categories ?? [])
    .filter((c) => c.id !== 'completed')
    .map((c) => ({ value: c.id, label: c.name }));

  const queueOptions = [
    { value: '', label: '主要下载队列' },
    ...queues.filter((q) => !q.isPrimary).map((q) => ({ value: q.id, label: q.name })),
  ];

  return (
    <Dialog
      headline="新建下载"
      subhead="输入地址后会自动探测文件大小与续传支持"
      size="wide"
      onClose={onClose}
      actions={
        <>
          <span className="spacer md-supporting" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {probing && (
              <>
                <CircularProgress /> 正在检测服务器…
              </>
            )}
            {!probing && probe?.ok && (
              <>
                续传：{probe.supportsResume ? '支持' : '不支持'} · 大小：
                {probe.totalBytes > 0 ? formatBytes(probe.totalBytes) : '未知'}
              </>
            )}
            {!probing && probe?.error && (
              <span style={{ color: 'var(--md-warning)' }}>{probe.error}</span>
            )}
          </span>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button
            variant="filled"
            onClick={() => void submit()}
            disabled={busy || !url.trim()}
            icon={busy ? undefined : 'download'}
          >
            {busy ? '正在添加…' : addToQueueOnly ? '加入队列' : '开始下载'}
          </Button>
        </>
      }
    >
      <TextField
        label="下载地址"
        value={url}
        onChange={setUrl}
        placeholder="https://example.com/file.zip"
        help="支持 http 与 https 协议"
        mono
      />

      <div className="md-row">
        <TextField label="文件名" value={fileName} onChange={setFileName} placeholder="（自动从地址推断）" />
        <div style={{ flex: 2, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TextField label="保存到" value={directory} onChange={setDirectory} />
          </div>
          <div style={{ paddingTop: 27 }}>
            <Button variant="outlined" onClick={() => void browse()}>浏览</Button>
          </div>
        </div>
      </div>

      <div className="md-row">
        <SelectField
          label="分类"
          value={categoryId}
          options={categoryOptions}
          onChange={(v) => setCategoryId(v as CategoryId)}
        />
        <SelectField
          label="队列"
          value={queueId ?? ''}
          options={queueOptions}
          onChange={(v) => setQueueId(v || null)}
        />
        <NumberField
          label="连接数"
          value={connections}
          onChange={setConnections}
          min={1}
          max={32}
          help="并发分段数 1–32"
        />
      </div>

      <TextField label="描述" value={description} onChange={setDescription} placeholder="可选，便于之后查找" />

      <div style={{ marginTop: 4 }}>
        <Button
          variant="text"
          icon={advancedOpen ? 'expand_less' : 'expand_more'}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          高级选项（授权、引用页）
        </Button>
      </div>

      {advancedOpen && (
        <div style={{ paddingLeft: 8, marginTop: 8 }}>
          <SectionTitle>服务器授权</SectionTitle>
          <div className="md-row">
            <TextField label="用户名" value={username} onChange={setUsername} />
            <TextField label="密码" type="password" value={password} onChange={setPassword} />
          </div>
          <TextField
            label="引用页 (Referer)"
            value={referer}
            onChange={setReferer}
            help="部分站点要求携带来源页才能下载"
            mono
          />
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Checkbox checked={addToQueueOnly} onChange={setAddToQueueOnly}>
          只把文件添加到下载队列，不立刻开始
        </Checkbox>
        <Checkbox checked={openWhenDone} onChange={setOpenWhenDone}>
          下载完成后打开文件
        </Checkbox>
      </div>

      <Supporting>
        提示：可以在「选项 → 下载」中修改默认保存目录与分类规则；分类会按文件扩展名自动匹配。
      </Supporting>
    </Dialog>
  );
}
