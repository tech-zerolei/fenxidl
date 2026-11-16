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

/** Colour used for a file-type glyph so the list scans quickly. */
export function fileColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['exe', 'msi', 'msix', 'appx'].includes(ext)) return '#8b6cf7';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2'].includes(ext)) return '#d29922';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg'].includes(ext)) return '#e5534b';
  if (['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma'].includes(ext)) return '#35c07d';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return '#56b6c2';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub'].includes(ext)) return '#4c8bf5';
  return '#5b6675';
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