/**
 * Media sniffer panel (spec §8).
 *
 * Lists media URLs the local capture service accepted, mirroring the original's
 * "recent ten requests" window, and lets the user queue a download directly.
 */

import React, { useEffect, useState } from 'react';
import type { IpcResult } from '../../shared/types';
import { Button, Dialog, SectionTitle, Supporting } from '../md3/components';
import { Icon } from '../md3/icons';
import { formatBytes, formatDate } from '../main';

interface SniffedMedia {
  url: string;
  kind: 'video' | 'audio';
  mimeType: string;
  sizeBytes: number | null;
  variants: Array<{ url: string; bandwidth: number | null; resolution: string | null }>;
  durationSeconds: number | null;
  resolution: string | null;
  discoveredAt: number;
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

export function MediaDialog({
  onClose,
  onAdded,
  onError,
}: {
  onClose: () => void;
  onAdded: (n: number) => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [items, setItems] = useState<SniffedMedia[]>([]);
  const [info, setInfo] = useState<{ running: boolean; port: number }>({ running: false, port: 0 });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<{ running: boolean; port: number }>('dl:snifferInfo').then(setInfo).catch(() => undefined);
    void invoke<SniffedMedia[]>('dl:getSniffedMedia').then(setItems).catch(() => undefined);
    return window.fenxi.onMediaSniffed((list) => setItems(list as SniffedMedia[]));
  }, []);

  const addSelected = async (targets: string[]): Promise<void> => {
    setBusy(true);
    try {
      let n = 0;
      for (const url of targets) {
        try {
          await invoke('dl:createTask', { url });
          n += 1;
        } catch {
          /* skip individual failures */
        }
      }
      if (n === 0) onError('没有成功添加任何媒体文件。');
      else onAdded(n);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      headline="媒体嗅探"
      subhead={
        info.running
          ? `捕获服务运行中 · 127.0.0.1:${info.port}`
          : '捕获服务未运行（可在「选项 → 常规」中启用）'
      }
      size="wide"
      onClose={onClose}
      actions={
        <>
          <span className="spacer md-supporting" style={{ margin: 0 }}>
            保留最近 10 个媒体地址
          </span>
          <Button
            variant="text"
            onClick={() => {
              void invoke('dl:clearSniffedMedia')
                .then(() => setItems([]))
                .catch((e: Error) => onError(e.message));
            }}
            disabled={items.length === 0}
          >
            清空列表
          </Button>
          <Button variant="filled" onClick={onClose}>关闭</Button>
        </>
      }
    >
      <Supporting>
        浏览器扩展会把页面实际请求的音视频报告给本地捕获服务（仅监听 127.0.0.1，
        不注入浏览器进程、不安装内核驱动）。这里保留最近 10 个媒体地址。
      </Supporting>

      {items.length === 0 ? (
        <div className="md-empty" style={{ height: 220 }}>
          <div className="md-empty__icon" aria-hidden>
            <Icon name="movie" size={56} />
          </div>
          <div className="md-empty__title">尚未捕获到媒体文件</div>
          <p className="md-empty__body">
            在浏览器中播放视频后切换到这里；或使用「新建下载」直接粘贴媒体地址。
          </p>
        </div>
      ) : (
        <>
          <SectionTitle>已捕获</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((m) => (
              <div
                key={m.url}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: 12,
                  border: '1px solid var(--md-outline-variant)',
                  borderRadius: 'var(--md-shape-sm)',
                  background: 'var(--md-surface-container)',
                }}
              >
                <span
                  className={`md-badge ${m.kind === 'video' ? 'error' : 'completed'}`}
                  style={{ flex: '0 0 auto' }}
                >
                  {m.kind === 'video' ? '视频' : '音频'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="md-mono" style={{ wordBreak: 'break-all' }}>{m.url}</div>
                  <div className="md-supporting" style={{ marginTop: 2 }}>
                    {m.mimeType || '未知类型'}
                    {m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : ''}
                    {m.resolution ? ` · ${m.resolution}` : ''}
                    {m.durationSeconds ? ` · ${Math.round(m.durationSeconds)} 秒` : ''}
                    {` · ${formatDate(m.discoveredAt)}`}
                  </div>
                  {m.variants.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {m.variants.slice(0, 4).map((v) => (
                        <div key={v.url} className="md-supporting md-mono" style={{ margin: 0 }}>
                          ↳ {v.resolution ?? '未知'}
                          {v.bandwidth ? ` · ${Math.round(v.bandwidth / 1000)} kbps` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  variant="tonal"
                  onClick={() => void addSelected([m.url])}
                  disabled={busy}
                >
                  下载
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
