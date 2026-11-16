/**
 * Default application settings, category rules, and the validation used when
 * the renderer saves settings.
 *
 * The category list and its default extensions follow the built-in set
 * observed in the original product (spec §1.5, strings 20261-20265, 20319, 20508).
 *
 * This module is intentionally free of `electron` imports: it is exercised by
 * the Node test runner. Callers inject the secret codec (safeStorage) and the
 * executable validator, so the policy stays testable.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AppSettings,
  CategoryId,
  CategoryRule,
  ProxySettings,
  QuotaSettings,
  ScheduleEntry,
  SiteCredential,
  VirusScanSettings,
} from '../shared/types';
import {
  FENXI_ENC_PREFIX,
  asArray,
  asBoolean,
  asEnum,
  asInt,
  asString,
  assertExecutableProgram,
  isRecord,
  type SecretCodec,
} from './validate';

/**
 * Stable per-user tag for scoping shared temp paths.
 *
 * Uses the numeric uid where available and falls back to the user name, so two
 * accounts on the same machine never contend for one temp folder.
 */
function currentUserTag(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null) return `u${uid}`;
  const name = (os.userInfo?.().username ?? 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
  return name || 'default';
}

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
    // Per-user subdirectory: a shared /tmp/FenxiDL created by another account
    // (or by a previous root run) is not writable, which used to make every
    // download fail with a misleading "destination not writable" error.
    tempDirectory: path.join(os.tmpdir(), 'FenxiDL', currentUserTag()),
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

export const LANGUAGE_IDS: string[] = LANGUAGES.map((l) => l.id);
export const CONNECTION_TYPE_IDS: string[] = CONNECTION_TYPES.map((c) => c.id);

export const CATEGORY_IDS: readonly CategoryId[] = [
  'completed', 'programs', 'music', 'video', 'games', 'documents', 'archives', 'other',
];

const MAX_EXTENSIONS = 200;
const MAX_CREDENTIALS = 200;

/** Validate one `Record<string, number>` such as serverConnectionOverrides. */
function sanitizeOverrides(raw: unknown, field: string): Record<string, number> {
  if (!isRecord(raw)) throw new Error(`${field} must be an object.`);
  const entries = Object.entries(raw);
  if (entries.length > 500) throw new Error(`${field} has too many entries.`);
  const out: Record<string, number> = {};
  for (const [key, value] of entries) {
    const host = asString(key, `${field} host`, 253).trim().toLowerCase();
    if (!/^[a-z0-9.*_-]+(:\d+)?$/.test(host)) throw new Error(`${field} contains an invalid host name.`);
    out[host] = asInt(value, `${field}.${host}`, 1, 32);
  }
  return out;
}

function sanitizeProxy(raw: unknown, field: string): ProxySettings {
  if (!isRecord(raw)) throw new Error(`${field} must be an object.`);
  const host = asString(raw.host, `${field}.host`, 253).trim();
  if (host && !/^[A-Za-z0-9._:[\]-]+$/.test(host)) throw new Error(`${field}.host is not a valid host.`);
  return {
    enabled: asBoolean(raw.enabled, `${field}.enabled`),
    host,
    port: asInt(raw.port, `${field}.port`, 1, 65535),
    username: asString(raw.username, `${field}.username`, 256),
    password: asString(raw.password, `${field}.password`, 256),
  };
}

function sanitizeQuota(raw: unknown): QuotaSettings {
  if (!isRecord(raw)) throw new Error('quota must be an object.');
  return {
    enabled: asBoolean(raw.enabled, 'quota.enabled'),
    startMinute: asInt(raw.startMinute, 'quota.startMinute', 0, 1439),
    endMinute: asInt(raw.endMinute, 'quota.endMinute', 0, 1439),
    megabytes: asInt(raw.megabytes, 'quota.megabytes', 0, 10_000_000),
  };
}

function sanitizeExtensions(raw: unknown, field: string): string[] {
  const list = asArray<unknown>(raw, field, MAX_EXTENSIONS);
  const out: string[] = [];
  for (const item of list) {
    const ext = asString(item, `${field} entry`, 32).trim().toLowerCase().replace(/^\./, '');
    if (!ext) continue;
    if (!/^[a-z0-9][a-z0-9+_-]{0,31}$/.test(ext)) {
      throw new Error(`${field} contains an invalid extension: ${ext}`);
    }
    out.push(ext);
  }
  return out;
}

function sanitizeCategories(raw: unknown, fallback: CategoryRule[]): CategoryRule[] {
  const list = asArray<unknown>(raw, 'categories', 32);
  if (list.length === 0) return fallback;
  const seen = new Set<string>();
  const out: CategoryRule[] = [];
  for (const item of list) {
    if (!isRecord(item)) throw new Error('categories entries must be objects.');
    const id = asEnum(item.id, 'categories.id', CATEGORY_IDS);
    if (seen.has(id)) throw new Error(`categories contains a duplicate id: ${id}`);
    seen.add(id);
    out.push({
      id,
      name: asString(item.name, 'categories.name', 120),
      // The directory is validated by the caller against the directory policy;
      // here we only enforce shape, because categories may point anywhere the
      // user selected earlier.
      directory: asString(item.directory, 'categories.directory', 4096),
      extensions: Array.isArray(item.extensions)
        ? item.extensions.map((e) => asString(e, 'categories.extensions entry', 32).toLowerCase()).slice(0, MAX_EXTENSIONS)
        : [],
      rememberLastPath: item.rememberLastPath === true,
    });
  }
  if (!seen.has('completed')) {
    const base = fallback.find((c) => c.id === 'completed');
    if (base) out.unshift(base);
  }
  return out;
}

function sanitizeCredentials(raw: unknown, previous: SiteCredential[]): SiteCredential[] {
  const list = asArray<unknown>(raw, 'credentials', MAX_CREDENTIALS);
  const bySite = new Map(previous.map((c) => [c.id, c]));
  const out: SiteCredential[] = [];
  const seenSites = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) throw new Error('credentials entries must be objects.');
    const site = asString(item.site, 'credentials.site', 253).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
    if (!site) continue;
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(site)) {
      throw new Error('credentials.site must be a bare host name such as bank.example.');
    }
    if (seenSites.has(site)) throw new Error(`credentials already contains an entry for ${site}.`);
    seenSites.add(site);
    const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.id)
      ? item.id
      : bySite.get(`site:${site}`)?.id ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    out.push({
      id,
      site,
      username: asString(item.username, 'credentials.username', 256),
      password: asString(item.password, 'credentials.password', 256),
    });
  }
  return out;
}

export interface SettingsValidationContext {
  /** Validates and returns a resolved executable path, or throws. */
  validateProgram?: (program: string) => string;
  /** Called when a security-relevant field changed, for audit logging. */
  onSecurityChange?: (message: string) => void;
}

/**
 * Merge a renderer-supplied settings object into the current settings.
 *
 * Every field is validated individually. Nothing is copied wholesale, so a
 * renderer cannot inject `virusScan.program` (or any other unknown key) into
 * the object the download engine later feeds to `spawn`.
 */
export function mergeSettings(
  current: AppSettings,
  raw: unknown,
  ctx: SettingsValidationContext = {},
): AppSettings {
  if (!isRecord(raw)) throw new Error('Invalid settings payload.');
  const known = new Set<keyof AppSettings>([
    'launchAtStartup', 'monitorClipboard', 'browserIntegration', 'autoStartExtensions',
    'showMediaBar', 'language', 'showTipsOnStartup', 'defaultConnections',
    'serverConnectionOverrides', 'connectionTypeId', 'quota', 'defaultDirectory',
    'tempDirectory', 'useLastPathForGeneral', 'showStartDialog', 'showProgressDialog',
    'showCompleteDialog', 'virusScan', 'categories', 'httpProxy', 'httpsProxy',
    'ftpProxy', 'ftpPassive', 'credentials', 'useDialup', 'redialAttempts',
    'redialIntervalSeconds', 'defaultQueueConcurrency', 'maxRetries',
    'retryDelaySeconds', 'globalSpeedLimit',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key as keyof AppSettings)) {
      throw new Error(
        `Unknown setting: ${key}. Valid settings are: ${[...known].join(', ')}.`,
      );
    }
  }

  const next: AppSettings = {
    ...current,
    categories: current.categories.map((c) => ({ ...c })),
    credentials: current.credentials.map((c) => ({ ...c })),
    serverConnectionOverrides: { ...current.serverConnectionOverrides },
  };

  if (raw.launchAtStartup !== undefined) next.launchAtStartup = asBoolean(raw.launchAtStartup, 'launchAtStartup');
  if (raw.monitorClipboard !== undefined) next.monitorClipboard = asBoolean(raw.monitorClipboard, 'monitorClipboard');
  if (raw.browserIntegration !== undefined) next.browserIntegration = asBoolean(raw.browserIntegration, 'browserIntegration');
  if (raw.showMediaBar !== undefined) next.showMediaBar = asBoolean(raw.showMediaBar, 'showMediaBar');
  if (raw.showTipsOnStartup !== undefined) next.showTipsOnStartup = asBoolean(raw.showTipsOnStartup, 'showTipsOnStartup');
  if (raw.language !== undefined) next.language = asEnum(raw.language, 'language', LANGUAGE_IDS);
  if (raw.autoStartExtensions !== undefined) {
    next.autoStartExtensions = sanitizeExtensions(raw.autoStartExtensions, 'autoStartExtensions');
  }
  if (raw.defaultConnections !== undefined) {
    next.defaultConnections = asInt(raw.defaultConnections, 'defaultConnections', 1, 32);
  }
  if (raw.serverConnectionOverrides !== undefined) {
    next.serverConnectionOverrides = sanitizeOverrides(raw.serverConnectionOverrides, 'serverConnectionOverrides');
  }
  if (raw.connectionTypeId !== undefined) {
    next.connectionTypeId = asEnum(raw.connectionTypeId, 'connectionTypeId', CONNECTION_TYPE_IDS);
  }
  if (raw.quota !== undefined) next.quota = sanitizeQuota(raw.quota);
  if (raw.defaultDirectory !== undefined) {
    next.defaultDirectory = asString(raw.defaultDirectory, 'defaultDirectory', 4096).trim();
    if (!path.isAbsolute(next.defaultDirectory)) {
      throw new Error('defaultDirectory must be an absolute path.');
    }
  }
  if (raw.tempDirectory !== undefined) {
    next.tempDirectory = asString(raw.tempDirectory, 'tempDirectory', 4096).trim();
    if (!path.isAbsolute(next.tempDirectory)) {
      throw new Error('tempDirectory must be an absolute path.');
    }
  }
  if (raw.useLastPathForGeneral !== undefined) {
    next.useLastPathForGeneral = asBoolean(raw.useLastPathForGeneral, 'useLastPathForGeneral');
  }
  if (raw.showStartDialog !== undefined) next.showStartDialog = asBoolean(raw.showStartDialog, 'showStartDialog');
  if (raw.showProgressDialog !== undefined) next.showProgressDialog = asBoolean(raw.showProgressDialog, 'showProgressDialog');
  if (raw.showCompleteDialog !== undefined) next.showCompleteDialog = asBoolean(raw.showCompleteDialog, 'showCompleteDialog');
  if (raw.virusScan !== undefined) {
    next.virusScan = sanitizeVirusScan(raw.virusScan, current.virusScan, ctx);
    if (next.virusScan.program !== current.virusScan.program) {
      ctx.onSecurityChange?.(
        `The virus-scan program was changed to ${next.virusScan.program || '(none)'}.`,
      );
    }
  }
  if (raw.categories !== undefined) next.categories = sanitizeCategories(raw.categories, current.categories);
  if (raw.httpProxy !== undefined) next.httpProxy = sanitizeProxy(raw.httpProxy, 'httpProxy');
  if (raw.httpsProxy !== undefined) next.httpsProxy = sanitizeProxy(raw.httpsProxy, 'httpsProxy');
  if (raw.ftpProxy !== undefined) next.ftpProxy = sanitizeProxy(raw.ftpProxy, 'ftpProxy');
  if (raw.ftpPassive !== undefined) next.ftpPassive = asBoolean(raw.ftpPassive, 'ftpPassive');
  if (raw.credentials !== undefined) next.credentials = sanitizeCredentials(raw.credentials, current.credentials);
  if (raw.useDialup !== undefined) next.useDialup = asBoolean(raw.useDialup, 'useDialup');
  if (raw.redialAttempts !== undefined) next.redialAttempts = asInt(raw.redialAttempts, 'redialAttempts', 0, 100);
  if (raw.redialIntervalSeconds !== undefined) {
    next.redialIntervalSeconds = asInt(raw.redialIntervalSeconds, 'redialIntervalSeconds', 1, 3600);
  }
  if (raw.defaultQueueConcurrency !== undefined) {
    next.defaultQueueConcurrency = asInt(raw.defaultQueueConcurrency, 'defaultQueueConcurrency', 1, 50);
  }
  if (raw.maxRetries !== undefined) next.maxRetries = asInt(raw.maxRetries, 'maxRetries', 0, 100);
  if (raw.retryDelaySeconds !== undefined) {
    next.retryDelaySeconds = asInt(raw.retryDelaySeconds, 'retryDelaySeconds', 1, 3600);
  }
  if (raw.globalSpeedLimit !== undefined) {
    next.globalSpeedLimit = asInt(raw.globalSpeedLimit, 'globalSpeedLimit', 0, 10_000_000_000);
  }
  return next;
}

/**
 * Validate the virus-scan settings.
 *
 * `program` must be an existing absolute executable that is not a shell or
 * interpreter and does not live in a temp or download folder, so a renderer
 * cannot turn "scan finished downloads" into arbitrary code execution.
 */
export function sanitizeVirusScan(
  raw: unknown,
  current: VirusScanSettings,
  ctx: SettingsValidationContext = {},
): VirusScanSettings {
  if (!isRecord(raw)) throw new Error('virusScan must be an object.');
  const allowed = new Set(['enabled', 'program', 'args']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Unknown virusScan field: ${key}.`);
  }
  const enabled = raw.enabled === undefined ? current.enabled : asBoolean(raw.enabled, 'virusScan.enabled');
  const programRaw = raw.program === undefined ? current.program : asString(raw.program, 'virusScan.program', 1024).trim();
  const args = raw.args === undefined ? current.args : asString(raw.args, 'virusScan.args', 2048);

  let program = programRaw;
  if (enabled) {
    if (!programRaw) throw new Error('Choose a virus-scan program before enabling the scan.');
    // If the value is unchanged we still re-validate: the file may have moved
    // or become non-executable, which must not stay armed silently.
    program = ctx.validateProgram
      ? ctx.validateProgram(programRaw)
      : assertExecutableProgram(programRaw);
  } else if (programRaw) {
    // Keep a remembered path but only if it is still a safe executable, so a
    // later "enable" cannot be satisfied by something planted meanwhile.
    try {
      program = ctx.validateProgram ? ctx.validateProgram(programRaw) : assertExecutableProgram(programRaw);
    } catch {
      program = '';
    }
  }
  if (args.includes('\u0000')) throw new Error('virusScan.args contains an invalid character.');
  return { enabled, program, args };
}

// ------------------------------------------------------------------ at rest

function looksEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(FENXI_ENC_PREFIX);
}

function encodeSecret(value: string, codec: SecretCodec): string {
  if (!value) return '';
  return codec.protect(value) ?? value;
}

function decodeSecret(value: unknown, codec: SecretCodec | null, warn: (m: string) => void): string {
  if (typeof value !== 'string' || !value) return '';
  if (!looksEncrypted(value)) return value;
  if (!codec) {
    warn('A stored secret could not be decrypted: OS encryption is unavailable.');
    return '';
  }
  try {
    return codec.unprotect(value);
  } catch {
    warn('A stored secret could not be decrypted and was ignored.');
    return '';
  }
}

/** Encrypt every password in the settings object before it is written to disk. */
export function encodeSettingsSecrets(settings: AppSettings, codec: SecretCodec | null): AppSettings {
  if (!codec) return settings;
  const encodeProxy = (p: ProxySettings): ProxySettings => ({ ...p, password: encodeSecret(p.password, codec) });
  return {
    ...settings,
    httpProxy: encodeProxy(settings.httpProxy),
    httpsProxy: encodeProxy(settings.httpsProxy),
    ftpProxy: encodeProxy(settings.ftpProxy),
    credentials: settings.credentials.map((c) => ({ ...c, password: encodeSecret(c.password, codec) })),
  };
}

/** Decrypt passwords read from disk; plaintext files from older versions pass through. */
export function decodeSettingsSecrets(
  settings: AppSettings,
  codec: SecretCodec | null,
  warn: (m: string) => void,
): AppSettings {
  const decodeProxy = (p: ProxySettings): ProxySettings => ({ ...p, password: decodeSecret(p.password, codec, warn) });
  return {
    ...settings,
    httpProxy: decodeProxy(settings.httpProxy),
    httpsProxy: decodeProxy(settings.httpsProxy),
    ftpProxy: decodeProxy(settings.ftpProxy),
    credentials: settings.credentials.map((c) => ({ ...c, password: decodeSecret(c.password, codec, warn) })),
  };
}

// --------------------------------------------------------------- schedules

const AFTER_ACTIONS = ['none', 'exit', 'shutdown', 'sleep', 'hibernate', 'hangup'] as const;
const SCHEDULE_MODES = ['once', 'daily', 'weekly', 'interval'] as const;

/** Validate the schedule list sent by the renderer (V-13). */
export function sanitizeSchedules(raw: unknown): ScheduleEntry[] {
  const list = asArray<unknown>(raw, 'schedules', 200);
  const ids = new Set<string>();
  const out: ScheduleEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) throw new Error('Each schedule must be an object.');
    const id = asString(item.id, 'schedule.id', 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('schedule.id is not a valid identifier.');
    if (ids.has(id)) throw new Error(`Duplicate schedule id: ${id}`);
    ids.add(id);
    const mode = asEnum(item.mode, 'schedule.mode', SCHEDULE_MODES);
    const queueId = item.queueId === null || item.queueId === undefined
      ? null
      : asString(item.queueId, 'schedule.queueId', 64);
    const startAt = item.startAt === null || item.startAt === undefined
      ? null
      : asInt(item.startAt, 'schedule.startAt', 0, 4_102_444_800_000);
    const timeOfDay = item.timeOfDay === null || item.timeOfDay === undefined
      ? null
      : asInt(item.timeOfDay, 'schedule.timeOfDay', 0, 1439);
    const intervalMinutes = item.intervalMinutes === null || item.intervalMinutes === undefined
      ? null
      : asInt(item.intervalMinutes, 'schedule.intervalMinutes', 1, 10_080);
    if (mode === 'once' && startAt === null) throw new Error('A one-off schedule needs a start time.');
    if ((mode === 'daily' || mode === 'weekly') && timeOfDay === null) {
      throw new Error('A daily or weekly schedule needs a time of day.');
    }
    if (mode === 'interval' && intervalMinutes === null) {
      throw new Error('An interval schedule needs an interval in minutes.');
    }
    out.push({
      id,
      queueId,
      enabled: item.enabled === true,
      mode,
      startAt,
      timeOfDay,
      weekdays: item.weekdays === undefined || item.weekdays === null
        ? 0
        : asInt(item.weekdays, 'schedule.weekdays', 0, 0x7f),
      intervalMinutes,
      afterAction: item.afterAction === undefined || item.afterAction === null
        ? 'none'
        : asEnum(item.afterAction, 'schedule.afterAction', AFTER_ACTIONS),
    });
  }
  return out;
}