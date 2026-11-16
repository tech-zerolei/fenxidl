/**
 * Batch download dialog (spec §6).
 *
 * Wildcard template expansion with a live preview of the URLs that will be
 * created, rendered with MD3 fields and a monospace preview panel.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { AppSettings, CategoryId, IpcResult } from '../../shared/types';
import {
  Button,
  Dialog,
  NumberField,
  SectionTitle,
  SelectField,
  Supporting,
  TextField,
} from '../md3/components';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await window.fenxi.invoke<IpcResult<T>>(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

export function BatchDialog({
  settings,
  onClose,
  onAdded,
  onError,
}: {
  settings: AppSettings;
  onClose: () => void;
  onAdded: (n: number) => void;
  onError: (m: string) => void;
}): React.ReactElement {
  const [template, setTemplate] = useState('https://example.com/images/img*.jpg');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(10);
  const [width, setWidth] = useState(3);
  const [directory, setDirectory] = useState(settings.defaultDirectory);
  const [categoryId, setCategoryId] = useState<CategoryId>('other');
  const [busy, setBusy] = useState(false);

  // Keep the zero-pad suggestion in sync with the upper bound.
  useEffect(() => {
    void invoke<number>('dl:suggestWidth', to).then((w) => setWidth(w)).catch(() => undefined);
  }, [to]);

  const preview = useMemo(() => {
    const text = template.trim();
    if (!text.includes('*')) return [text].filter(Boolean);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    if (!Number.isFinite(low) || !Number.isFinite(high) || high - low > 200) return [];
    const out: string[] = [];
    for (let i = low; i <= high && out.length < 200; i += 1) {
      out.push(text.replace('*', width > 0 ? String(i).padStart(width, '0') : String(i)));
    }
    return out;
  }, [template, from, to, width]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const expansion = await invoke<{ urls: string[]; issues: string[] }>('dl:expandBatch', {
        template,
        from,
        to,
        width,
      });
      if (expansion.issues.length > 0) {
        onError(expansion.issues.join(' '));
        return;
      }
      let added = 0;
      for (const url of expansion.urls) {
        try {
          await invoke('dl:createTask', { url, directory, categoryId, addToQueueOnly: false });
          added += 1;
        } catch {
          /* skip individual failures and report the total */
        }
      }
      if (added === 0) onError('没有成功添加任何任务。');
      else onAdded(added);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      headline="批量下载"
      subhead="用星号通配符生成一组有序地址"
      onClose={onClose}
      actions={
        <>
          <span className="spacer md-supporting" style={{ margin: 0 }}>
            将创建 {preview.length} 个任务
          </span>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button
            variant="filled"
            onClick={() => void submit()}
            disabled={busy || preview.length === 0}
          >
            {busy ? '正在添加…' : '开始批量下载'}
          </Button>
        </>
      }
    >
      <Supporting>
        向下载队列添加一组有序文件（如 img001.jpg、img002.jpg …）。
        使用星号 (*) 通配符编写链接模板。
      </Supporting>

      <div style={{ marginTop: 16 }}>
        <TextField
          label="下载链接模板（含一个 *）"
          value={template}
          onChange={setTemplate}
          placeholder="https://host/path/file*.zip"
          mono
        />
      </div>

      <div className="md-row">
        <NumberField label="起始值" value={from} onChange={setFrom} min={0} />
        <NumberField label="结束值" value={to} onChange={setTo} min={0} />
        <NumberField
          label="通配符长度"
          value={width}
          onChange={setWidth}
          min={0}
          max={10}
          help="补零位数，0 表示不补零"
        />
      </div>

      <div className="md-row">
        <SelectField
          label="分类"
          value={categoryId}
          options={settings.categories
            .filter((c) => c.id !== 'completed')
            .map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => setCategoryId(v as CategoryId)}
        />
        <div style={{ flex: 2 }}>
          <TextField label="保存到" value={directory} onChange={setDirectory} />
        </div>
      </div>

      <SectionTitle>预览</SectionTitle>
      <div
        className="md-mono"
        style={{
          maxHeight: 168,
          overflowY: 'auto',
          background: 'var(--md-surface-container-lowest)',
          border: '1px solid var(--md-outline-variant)',
          borderRadius: 'var(--md-shape-sm)',
          padding: 12,
          lineHeight: 1.8,
        }}
      >
        {preview.length === 0 ? (
          <span style={{ color: 'var(--md-on-surface-variant)' }}>
            模板无效，或范围过大（单次最多 200 条预览）。
          </span>
        ) : (
          preview.map((u) => <div key={u}>{u}</div>)
        )}
      </div>
    </Dialog>
  );
}
