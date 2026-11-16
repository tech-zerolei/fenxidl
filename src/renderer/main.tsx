/**
 * Renderer entry: React root plus the shared formatting helpers.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import './md3/tokens.css';
import './md3/md3.css';
import { App } from './App';

/** Format a byte count with binary units, matching the original's abbreviations. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Remaining time in the compact form the original uses (%d 小时 %d 分 etc.). */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m} 分 ${rest} 秒`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

export function formatDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Colour roles for a file-type glyph.
 *
 * Returns CSS custom-property references rather than literal hex values: the
 * seven hard-coded colours that used to live here were the only place in the
 * renderer that bypassed the token system, and three of them fell below 3:1
 * against the white glyph text. Each entry is a MD3-style container /
 * on-container pair, so the glyph keeps at least 4.5:1 in both themes.
 */
export function fileColor(name: string): { bg: string; fg: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['exe', 'msi', 'msix', 'appx'].includes(ext)) {
    return { bg: 'var(--md-file-program-bg)', fg: 'var(--md-file-program-fg)' };
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2'].includes(ext)) {
    return { bg: 'var(--md-file-archive-bg)', fg: 'var(--md-file-archive-fg)' };
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg'].includes(ext)) {
    return { bg: 'var(--md-file-video-bg)', fg: 'var(--md-file-video-fg)' };
  }
  if (['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma'].includes(ext)) {
    return { bg: 'var(--md-file-audio-bg)', fg: 'var(--md-file-audio-fg)' };
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) {
    return { bg: 'var(--md-file-image-bg)', fg: 'var(--md-file-image-fg)' };
  }
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'].includes(ext)) {
    return { bg: 'var(--md-file-doc-bg)', fg: 'var(--md-file-doc-fg)' };
  }
  return { bg: 'var(--md-file-default-bg)', fg: 'var(--md-file-default-fg)' };
}

export function fileGlyph(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (!ext || ext === name.toLowerCase()) return '?';
  return ext.slice(0, 3).toUpperCase();
}

const root = document.getElementById('root');
if (!root) throw new Error('The renderer mount point is missing.');
createRoot(root).render(
  React.createElement(React.StrictMode, null, React.createElement(App)),
);