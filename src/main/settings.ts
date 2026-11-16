/**
 * Default application settings and category rules.
 *
 * The category list and its default extensions follow the built-in set
 * observed in the original product (spec §1.5, strings 20261-20265, 20319, 20508).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { AppSettings, CategoryRule, ProxySettings } from '../shared/types';

export function downloadsRoot(): string {
  return path.join(os.homedir(), 'Downloads', 'FenxiDL');
}

function emptyProxy(): ProxySettings {
  return { enabled: false, host: '', port: 8080, username: '', password: '' };
}

export function defaultCategories(root: string): CategoryRule[] {
  return [
    { id: 'completed', name: 'Completed', directory: root, extensions: [], rememberLastPath: false },
    { id: 'programs', name: 'Programs', directory: path.join(root, 'Programs'), extensions: ['exe', 'msi', 'zip', '7z', 'rar', 'msix', 'appx'], rememberLastPath: true },
    { id: 'music', name: 'Music', directory: path.join(root, 'Music'), extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'wma', 'opus'], rememberLastPath: true },
    { id: 'video', name: 'Video', directory: path.join(root, 'Video'), extensions: ['mp4', 'mkv', 'avi', 'flv', 'mov', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts'], rememberLastPath: true },
    { id: 'games', name: 'Games', directory: path.join(root, 'Games'), extensions: ['iso', 'bin', 'cue', 'nsp', 'xci', 'pkg'], rememberLastPath: true },
    { id: 'documents', name: 'Documents', directory: path.join(root, 'Documents'), extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'txt', 'rtf'], rememberLastPath: true },
    { id: 'archives', name: 'Compressed', directory: path.join(root, 'Compressed'), extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'], rememberLastPath: true },
    { id: 'other', name: 'Other', directory: path.join(root, 'Other'), extensions: [], rememberLastPath: true },
  ];
}

export function defaultSettings(): AppSettings {
  const root = downloadsRoot();
  return {
    launchAtStartup: false,
    monitorClipboard: true,
    browserIntegration: true,
    autoStartExtensions: ['exe', 'msi', 'zip', '7z', 'rar', 'pdf', 'iso', 'mp3', 'mp4', 'mkv', 'avi'],
    showMediaBar: true,
    language: 'zh-CN',
    showTipsOnStartup: true,

    defaultConnections: 8,
    serverConnectionOverrides: {},
    connectionTypeId: 'unlimited',
    quota: { enabled: false, startMinute: 0, endMinute: 0, megabytes: 0 },

    defaultDirectory: root,
    tempDirectory: path.join(os.tmpdir(), 'FenxiDL'),
    useLastPathForGeneral: true,
    showStartDialog: true,
    showProgressDialog: true,
    showCompleteDialog: true,
    virusScan: { enabled: false, program: '', args: '' },
    categories: defaultCategories(root),

    httpProxy: emptyProxy(),
    httpsProxy: emptyProxy(),
    ftpProxy: emptyProxy(),
    ftpPassive: true,

    credentials: [],

    useDialup: false,
    redialAttempts: 3,
    redialIntervalSeconds: 5,

    defaultQueueConcurrency: 4,
    maxRetries: 8,
    retryDelaySeconds: 5,
    globalSpeedLimit: 0,
  };
}

/** Connection-type presets (spec string 20314-20316 plus unlimited). */
export const CONNECTION_TYPES: Array<{ id: string; label: string }> = [
  { id: 'unlimited', label: 'Unlimited' },
  { id: '256k', label: '256K Cable/DSL/other' },
  { id: '300k', label: '300K Cable/DSL/other' },
  { id: '512k', label: '512K Cable/DSL/other' },
  { id: '1m', label: '1M Cable/DSL/other' },
  { id: '2m', label: '2M Cable/DSL/other' },
  { id: '5m', label: '5M Cable/DSL/other' },
  { id: '10m', label: '10M Cable/DSL/other' },
];

/** Supported interface languages. Only the shipped translations are listed. */
export const LANGUAGES: Array<{ id: string; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
  { id: 'zh-TW', label: '繁體中文' },
];