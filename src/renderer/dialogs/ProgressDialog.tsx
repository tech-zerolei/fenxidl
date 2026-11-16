/**
 * Download progress dialog (spec §3).
 *
 * Shows live counters plus the per-connection segment table from the details
 * panel (string 1305), now rendered with MD3 linear progress indicators.
 */

import React, { useEffect, useState } from 'react';
import type { DownloadTask } from '../../shared/types';
import { Button, Dialog, LinearProgress, SectionTitle, StatusBadge, Supporting } from '../md3/components';
import { formatBytes, formatEta, formatSpeed } from '../main';

const STATUS_TEXT: Record<DownloadTask['status'], string> = {
  queued: '排队中',
  connecting: '正在连接',
  downloading: '正在下载',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  error: '错误',
};

export function ProgressDialog({
  task,
  onClose,
  onOpenFile,
  onOpenFolder,
  onError,
}: {
  task: DownloadTask | null;
  onClose: () => void;
  onOpenFile: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [showDetails, setShowDetails] = useState(true);

  useEffect(() => {
    if (task && task.status === 'error' && task.error) {
      onError(task.error.message);
    }
    // React only to the transition into the error state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.status]);

  if (!task) {
    return (
      <Dialog
        headline="下载进度"
        size="narrow"
        onClose={onClose}
        actions={<Button variant="filled" onClick={onClose}>关闭</Button>}
      >
        <Supporting>该任务已不存在。</Supporting>
      </Dialog>
    );
  }

  const pct = task.totalBytes > 0 ? (task.downloadedBytes / task.totalBytes) * 100 : 0;
  const variant =
    task.status === 'completed' ? 'completed'
      : task.status === 'error' ? 'error'
        : task.status === 'paused' ? 'paused'
          : undefined;

  return (
    <Dialog
      headline={task.fileName}
      subhead={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <StatusBadge status={task.status} label={STATUS_TEXT[task.status]} />
          {task.totalBytes > 0 && <span>{pct.toFixed(1)}% 已完成</span>}
        </span>
      }
      size="wide"
      onClose={onClose}
      actions={
        <>
          <div className="spacer" style={{ display: 'flex', gap: 8 }}>
            {task.status === 'completed' && (
              <>
                <Button variant="tonal" icon="folder" onClick={() => onOpenFolder(task.id)}>
                  打开文件夹
                </Button>
                <Button variant="filled" icon="play" onClick={() => onOpenFile(task.id)}>
                  打开文件
                </Button>
              </>
            )}
          </div>
          <Button
            variant="text"
            icon={showDetails ? 'expand_less' : 'expand_more'}
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? '隐藏细节' : '显示细节'}
          </Button>
          <Button variant="text" onClick={onClose}>关闭</Button>
        </>
      }
    >
      <LinearProgress value={pct} variant={variant} height={8} />

      <dl className="md-kv" style={{ marginTop: 20 }}>
        <dt>下载状态</dt>
        <dd>
          <StatusBadge status={task.status} label={STATUS_TEXT[task.status]} />
        </dd>
        <dt>文件大小</dt>
        <dd>{task.totalBytes > 0 ? formatBytes(task.totalBytes) : '未知'}</dd>
        <dt>已经下载</dt>
        <dd>
          {formatBytes(task.downloadedBytes)}
          {task.totalBytes > 0 && ` (${pct.toFixed(1)}%)`}
        </dd>
        <dt>传输速度</dt>
        <dd>{formatSpeed(task.speed)}</dd>
        <dt>剩余时间</dt>
        <dd>{task.status === 'downloading' ? formatEta(task.eta) : '—'}</dd>
        <dt>能否续传</dt>
        <dd>
          <span className={`md-badge ${task.supportsResume ? 'completed' : 'error'}`}>
            {task.supportsResume ? '能够' : '不能'}
          </span>
        </dd>
        <dt>描述</dt>
        <dd>{task.description || '—'}</dd>
        <dt>分类</dt>
        <dd>{task.categoryId}</dd>
        <dt>另存为</dt>
        <dd className="md-mono">{task.savePath}</dd>
        <dt>下载地址</dt>
        <dd className="md-mono">{task.url}</dd>
        {task.mimeType && (
          <>
            <dt>内容类型</dt>
            <dd className="md-mono">{task.mimeType}</dd>
          </>
        )}
        {task.etag && (
          <>
            <dt>ETag</dt>
            <dd className="md-mono">{task.etag}</dd>
          </>
        )}
        {task.error && (
          <>
            <dt>错误</dt>
            <dd style={{ color: 'var(--md-error)' }}>{task.error.message}</dd>
          </>
        )}
      </dl>

      {showDetails && (
        <>
          <SectionTitle>各线程的起始位置以及下载进度</SectionTitle>
          {task.segments.length === 0 ? (
            <Supporting>
              单连接下载（服务器不支持续传，或连接数设为 1）。
            </Supporting>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {task.segments.map((seg) => {
                const total = seg.end - seg.start + 1;
                const p = total > 0 ? (seg.downloaded / total) * 100 : 0;
                return (
                  <div className="md-segment" key={seg.index}>
                    <span className="md-segment__index">{seg.index + 1}.</span>
                    <div className="md-segment__track">
                      <div className="md-segment__fill" style={{ width: `${Math.min(100, p)}%` }} />
                    </div>
                    <span className="md-segment__value">
                      {formatBytes(seg.downloaded)} / {formatBytes(total)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
