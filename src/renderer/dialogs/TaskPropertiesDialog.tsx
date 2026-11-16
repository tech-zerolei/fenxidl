/**
 * File properties dialog (spec §2.5/§10).
 *
 * Shows the read-only facts about a task plus the editable overrides: save
 * folder, description, category, queue, credentials and connection count.
 */

import React, { useState } from 'react';
import type { CategoryId, DownloadTask, IpcResult, Queue } from '../../shared/types';
import {
  Button,
  Checkbox,
  Dialog,
  NumberField,
  SectionTitle,
  SelectField,
  Supporting,
  TextField,
} from '../md3/components';
import { formatBytes, formatDate } from '../main';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

const CATEGORY_OPTIONS = [
  { value: 'programs', label: '程序' },
  { value: 'music', label: '音乐' },
  { value: 'video', label: '视频' },
  { value: 'games', label: '游戏' },
  { value: 'documents', label: '文档' },
  { value: 'archives', label: '压缩文件' },
  { value: 'other', label: '其他' },
  { value: 'completed', label: '已完成' },
];

export function TaskPropertiesDialog({
  task,
  queues,
  onClose,
  onSaved,
  onError,
}: {
  task: DownloadTask | null;
  queues: Queue[];
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [description, setDescription] = useState(task?.description ?? '');
  const [directory, setDirectory] = useState(task?.directory ?? '');
  const [categoryId, setCategoryId] = useState<CategoryId>(task?.categoryId ?? 'other');
  const [connections, setConnections] = useState(task?.connections ?? 8);
  const [username, setUsername] = useState(task?.username ?? '');
  const [password, setPassword] = useState(task?.password ?? '');
  const [referer, setReferer] = useState(task?.referer ?? '');
  const [queueId, setQueueId] = useState<string | null>(task?.queueId ?? null);
  const [openWhenDone, setOpenWhenDone] = useState(task?.openWhenDone ?? false);
  const [busy, setBusy] = useState(false);

  if (!task) {
    return (
      <Dialog
        headline="文件属性"
        size="narrow"
        onClose={onClose}
        actions={<Button variant="filled" onClick={onClose}>关闭</Button>}
      >
        <Supporting>该任务已不存在。</Supporting>
      </Dialog>
    );
  }

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await invoke('dl:updateTask', task.id, {
        description,
        directory,
        categoryId,
        connections,
        username: username || null,
        password: password || null,
        referer: referer || null,
        openWhenDone,
      });
      if ((task.queueId ?? null) !== queueId) {
        await invoke('dl:moveToQueue', task.id, queueId);
      }
      onSaved();
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const queueOptions = [
    { value: '', label: '主要下载队列' },
    ...queues.filter((q) => !q.isPrimary).map((q) => ({ value: q.id, label: q.name })),
  ];

  return (
    <Dialog
      headline={task.fileName}
      subhead="文件属性"
      onClose={onClose}
      actions={
        <>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button variant="filled" onClick={() => void save()} disabled={busy}>
            {busy ? '正在保存…' : '保存'}
          </Button>
        </>
      }
    >
      <dl className="md-kv">
        <dt>类型</dt>
        <dd>{task.mimeType ?? '未知'}</dd>
        <dt>大小</dt>
        <dd>{task.totalBytes > 0 ? formatBytes(task.totalBytes) : '未知'}</dd>
        <dt>已下载</dt>
        <dd>{formatBytes(task.downloadedBytes)}</dd>
        <dt>添加时间</dt>
        <dd>{formatDate(task.createdAt)}</dd>
        <dt>完成时间</dt>
        <dd>{task.finishedAt ? formatDate(task.finishedAt) : '—'}</dd>
        <dt>下载地址</dt>
        <dd className="md-mono">{task.url}</dd>
        <dt>保存到</dt>
        <dd className="md-mono">{task.savePath}</dd>
        {task.error && (
          <>
            <dt>最后结果</dt>
            <dd style={{ color: 'var(--md-error)' }}>{task.error.message}</dd>
          </>
        )}
      </dl>

      <SectionTitle>可编辑属性</SectionTitle>

      <TextField label="描述" value={description} onChange={setDescription} />

      <div className="md-row">
        <div style={{ flex: 2 }}>
          <TextField label="保存目录" value={directory} onChange={setDirectory} />
        </div>
        <SelectField
          label="分类"
          value={categoryId}
          options={CATEGORY_OPTIONS}
          onChange={(v) => setCategoryId(v as CategoryId)}
        />
      </div>

      <div className="md-row">
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
        />
      </div>

      <div className="md-row">
        <TextField label="用户名" value={username} onChange={setUsername} />
        <TextField label="密码" type="password" value={password} onChange={setPassword} />
      </div>

      <TextField label="引用页" value={referer} onChange={setReferer} />

      <Checkbox checked={openWhenDone} onChange={setOpenWhenDone}>
        下载完成后打开文件
      </Checkbox>
    </Dialog>
  );
}
