/**
 * Electron main process: window lifecycle, tray, IPC surface and app services.
 *
 * The IPC channel names and payloads are the contract consumed by the
 * renderer; each handler validates its input and never trusts the renderer.
 *
 * Trust model: the renderer is treated as attacker-reachable (it can be
 * navigated, XSS'd or driven by a compromised extension). Therefore:
 *   - every handler validates and narrows its arguments (see ./validate);
 *   - handlers mutate only allow-listed fields;
 *   - paths are confined to folders the user actually chose;
 *   - the window cannot navigate away from its own bundled page.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  shell,
  Notification,
} from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AppSettings,
  CategoryId,
  DownloadTask,
  GrabberProject,
  GrabberStats,
  IpcResult,
  ProgressSnapshot,
  Queue,
  ScheduleEntry,
  TaskCreateInput,
} from '../shared/types';
import { expandBatch, suggestWidth, type BatchSpec } from './batch';
import { fileNameFromUrl, probe } from './download-engine';
import { relativeSavePath, startGrabber, type CrawlFoundFile, type GrabberHandle } from './grabber';
import { startSniffer, type SniffedMedia, type SnifferHandle } from './media-sniffer';
import {
  CONNECTION_TYPE_IDS,
  LANGUAGE_IDS,
  decodeSettingsSecrets,
  defaultSettings,
  encodeSettingsSecrets,
  mergeSettings,
  sanitizeSchedules,
  sanitizeVirusScan,
} from './settings';
import { TaskManager } from './task-manager';
import {
  FENXI_ENC_PREFIX,
  asBoolean,
  asEnum,
  asInt,
  asNumber,
  asOptionalEnum,
  asOptionalInt,
  asOptionalString,
  asString,
  asStringOrNull,
  assertExecutableProgram,
  assertOutboundHostAllowed,
  assertSafeFileName,
  assertSafePath,
  hardenFilePermissions,
  isRecord,
  isWithin,
  parseHttpUrl,
  sanitizeHeaderRecord,
  type DirectoryPolicy,
  type SecretCodec,
} from './validate';

// esbuild emits CommonJS for the main process, so __dirname is available.
declare const __dirname: string;

/**
 * Chromium refuses to start as root unless the sandbox is disabled, aborting
 * with "Running as root without --no-sandbox is not supported". A packaged
 * AppImage launched by double-click passes no arguments, so the app would
 * crash immediately for anyone running as root (containers, some VMs, and any
 * session started via `sudo`).
 *
 * This is now an explicit opt-in instead of an automatic downgrade: the
 * sandbox stays on unless the operator asks for the workaround, because
 * disabling it removes the second line of defence behind every renderer bug.
 * Set FENXI_ALLOW_NO_SANDBOX=1 to enable it (documented for containers).
 */
function applyRootSandboxWorkaround(): void {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) return;
  // A launcher may have supplied the flag already (the AppImage AppRun does so
  // for uid 0). In that case there is nothing to decide and nothing to warn
  // about - reporting "refusing" here was a false alarm that made a working
  // launch look like a security violation.
  if (app.commandLine.hasSwitch('no-sandbox')) {
    if (process.env.FENXI_ALLOW_NO_SANDBOX !== '1') {
      console.warn(
        '[FenxiDL] Running as root with --no-sandbox supplied by the launcher: ' +
          'the Chromium sandbox is disabled. For best security, run the app as ' +
          'a regular user.',
      );
    }
    return;
  }
  if (process.env.FENXI_ALLOW_NO_SANDBOX !== '1') {
    console.error(
      '[FenxiDL] Refusing to disable the Chromium sandbox automatically. ' +
        'Running as root requires --no-sandbox; set FENXI_ALLOW_NO_SANDBOX=1 ' +
        '(or pass --no-sandbox) only inside a disposable container.',
    );
    return;
  }
  app.commandLine.appendSwitch('no-sandbox');
  if (!app.commandLine.hasSwitch('disable-gpu-sandbox')) {
    app.commandLine.appendSwitch('disable-gpu-sandbox');
  }
  console.warn(
    '[FenxiDL] FENXI_ALLOW_NO_SANDBOX=1: the Chromium sandbox is disabled. ' +
      'For best security, run the app as a regular user.',
  );
}

applyRootSandboxWorkaround();

/** The one page the window is allowed to display (plus the dev server). */
const DEV_ORIGINS = (process.env.FENXI_DEV_ORIGIN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager: TaskManager | null = null;
let settings: AppSettings = defaultSettings();
let queues: Queue[] = [];
let schedules: ScheduleEntry[] = [];
let grabberHandle: GrabberHandle | null = null;
let sniffer: SnifferHandle | null = null;
const sniffedMedia: SniffedMedia[] = [];
const SNIFFER_PORT = 47823;
/** Set when the queues/schedules file existed but could not be parsed. */
let auxLoadError: string | null = null;
let grabberProject: GrabberProject | null = null;
let grabberStats: GrabberStats = {
  status: 'idle',
  pagesProcessed: 0,
  filesFound: 0,
  filesMatched: 0,
  filesDownloaded: 0,
};
let grabberFiles: CrawlFoundFile[] = [];
let clipboardTimer: NodeJS.Timeout | null = null;
let lastClipboardText = '';
/** Folders the user picked in a native folder dialog during this session. */
const userChosenDirectories = new Set<string>();
/** Set when OS encryption is unavailable, so the UI/log can warn once. */
let plaintextSecretWarning = false;

function userDataDir(): string {
  return app.getPath('userData');
}

function statePath(): string {
  return path.join(userDataDir(), 'state.json');
}

function settingsPath(): string {
  return path.join(userDataDir(), 'settings.json');
}

function auxPath(): string {
  return path.join(userDataDir(), 'aux.json');
}

function grabberProjectsPath(): string {
  return path.join(userDataDir(), 'grabber-projects.json');
}

// ------------------------------------------------------------------ secrets

/**
 * safeStorage-backed codec.
 *
 * Electron only exposes OS keyring encryption after the app is ready, so the
 * codec is resolved lazily and cached. When encryption is unavailable the
 * value is stored as-is and a one-time warning is surfaced; the app still
 * works, but the log and UI state that secrets are not protected.
 */
let secretCodecResolved = false;
let secretCodec: SecretCodec | null = null;

function secretCodecOrNull(): SecretCodec | null {
  if (secretCodecResolved) return secretCodec;
  secretCodecResolved = true;
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      secretCodec = null;
      return null;
    }
    secretCodec = {
      protect: (plain: string) => `${FENXI_ENC_PREFIX}${safeStorage.encryptString(plain).toString('base64')}`,
      unprotect: (stored: string) => {
        const payload = stored.slice(FENXI_ENC_PREFIX.length);
        return safeStorage.decryptString(Buffer.from(payload, 'base64'));
      },
    };
  } catch {
    secretCodec = null;
  }
  return secretCodec;
}

function warnPlaintextSecrets(reason: string): void {
  if (plaintextSecretWarning) return;
  plaintextSecretWarning = true;
  const message =
    'OS encryption is unavailable (' +
    reason +
    '): saved passwords are stored unencrypted on disk. ' +
    'Install a keyring (gnome-keyring / kwallet / libsecret) to protect them.';
  console.warn(`[FenxiDL] ${message}`);
  broadcast('dl:log', message);
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Write a JSON file atomically with owner-only permissions. */
async function writePrivateJson(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  hardenFilePermissions(tmp, 0o600);
  await fsp.rename(tmp, target);
  hardenFilePermissions(target, 0o600);
}

// ----------------------------------------------------------------- settings

function decodeStoredSettings(parsed: unknown): AppSettings {
  const base = defaultSettings();
  if (!isRecord(parsed)) return base;
  // Settings are read from disk (not from the renderer): keep unknown keys out
  // but tolerate older files by merging only known, individually valid fields.
  let merged: AppSettings;
  try {
    merged = mergeSettings(base, parsed, {});
  } catch {
    merged = base;
  }
  const codec = secretCodecOrNull();
  if (!codec && JSON.stringify(parsed).includes(FENXI_ENC_PREFIX)) {
    warnPlaintextSecrets('encrypted values found but no OS keyring is present');
  }
  return decodeSettingsSecrets(merged, codec, (m) => console.warn(`[FenxiDL] ${m}`));
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const merged = decodeStoredSettings(parsed);
    // Older versions wrote 0644; tighten whatever is already there.
    hardenFilePermissions(settingsPath(), 0o600);
    return merged;
  } catch {
    return defaultSettings();
  }
}

async function saveSettings(next: AppSettings): Promise<void> {
  const codec = secretCodecOrNull();
  if (!codec) warnPlaintextSecrets('no OS keyring available');
  await writePrivateJson(settingsPath(), encodeSettingsSecrets(next, codec));
}

async function loadAux(): Promise<void> {
  try {
    const raw = await fsp.readFile(auxPath(), 'utf8');
    const data = JSON.parse(raw) as { queues?: Queue[]; schedules?: ScheduleEntry[] };
    queues = Array.isArray(data.queues) && data.queues.length ? data.queues : [];
    schedules = Array.isArray(data.schedules) ? data.schedules : [];
  } catch (err) {
    queues = [];
    schedules = [];
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // A corrupt file used to be discarded silently, and the next save then
      // overwrote it — losing every queue and schedule with no trace. Keep a
      // copy the user (or support) can recover from, and say so.
      const backup = `${auxPath()}.corrupt-${Date.now()}`;
      try {
        await fsp.copyFile(auxPath(), backup);
        console.error(`[FenxiDL] Readable backup of the damaged queues file: ${backup}`);
      } catch {
        console.error('[FenxiDL] The queues file is unreadable and could not be backed up.');
      }
      auxLoadError = err instanceof Error ? err.message : String(err);
    }
  }
  if (queues.length === 0) {
    queues = [{ id: 'primary', name: 'Main download queue', concurrency: settings.defaultQueueConcurrency, isPrimary: true }];
  }
  if (!queues.some((q) => q.isPrimary)) {
    queues.unshift({ id: 'primary', name: 'Main download queue', concurrency: settings.defaultQueueConcurrency, isPrimary: true });
  }
}

async function saveAux(): Promise<void> {
  await writePrivateJson(auxPath(), { queues, schedules });
}

/** Placeholder the renderer sees in place of a stored password. */
const SECRET_MASK = '\u0000stored';

/** Replace a stored secret with the mask, keeping "is there one" observable. */
function maskSecret(value: string | null): string | null {
  if (value === null || value === '') return value === null ? null : '';
  return SECRET_MASK;
}

/**
 * Build the renderer-visible snapshot.
 *
 * Passwords are write-only across the bridge: the renderer learns that one is
 * stored but never receives it, so an XSS or a remote page driving the bridge
 * cannot exfiltrate saved site, per-task or proxy credentials.
 */
function redactSnapshot(): ProgressSnapshot {
  const snap = requireManager().snapshot();
  return {
    ...snap,
    settings: withheldCredentials(snap.settings),
    tasks: snap.tasks.map(stripTaskSecrets),
  };
}

function stripTaskSecrets(task: DownloadTask): DownloadTask {
  return { ...task, password: maskSecret(task.password) };
}

function pushSnapshot(): void {
  if (!manager) return;
  queues = manager.getQueues();
  schedules = manager.getSchedules();
  broadcast('dl:snapshot', redactSnapshot());
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Wrap a handler so thrown errors become structured failures, never crashes. */
function handle<TArgs extends unknown[], TResult>(
  channel: string,
  fn: (...args: TArgs) => Promise<IpcResult<TResult>> | IpcResult<TResult>,
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as TArgs));
    } catch (err) {
      return fail(err);
    }
  });
}

function requireManager(): TaskManager {
  if (!manager) throw new Error('The download service is not ready yet.');
  return manager;
}

function validateUrl(raw: string): string {
  return parseHttpUrl(raw).toString();
}

// ------------------------------------------------------- directory allow-list

/**
 * Directories a task may write into.
 *
 * This is an allow-list rather than a deny-list so that new sensitive
 * locations cannot silently become writable: the download roots, every
 * configured category folder, the app's own folders, and any folder the user
 * selected with the native folder picker during this session. Anything else —
 * including /etc, ~/.ssh and autostart folders — is refused by
 * `assertSafePath`, which also applies a hard deny-list.
 */
function directoryPolicy(): DirectoryPolicy {
  const roots = new Set<string>();
  const add = (p: string | undefined | null): void => {
    if (typeof p !== 'string' || !p.trim()) return;
    try {
      roots.add(path.resolve(p));
    } catch {
      /* ignore unusable entries */
    }
  };
  add(settings.defaultDirectory);
  for (const category of settings.categories) add(category.directory);
  for (const dir of [...userChosenDirectories]) add(dir);
  try {
    add(userDataDir());
    add(app.getPath('downloads'));
    add(app.getPath('temp'));
  } catch {
    /* app paths unavailable in some test harnesses */
  }
  // The batch and grabber dialogs accept a typed folder, so ordinary visible
  // folders under the home directory stay writable; hidden folders, system
  // paths and the deny-list entries above stay refused.
  return { roots: [...roots], allowHomeSubtree: true };
}

/** Validate a download directory against the allow-list. */
function assertAllowedDirectory(raw: unknown, field: string): string {
  return assertSafePath(raw, field, directoryPolicy());
}

/** Validate a whole file path against the allow-list. */
function assertAllowedFilePath(raw: unknown, field: string): string {
  return assertSafePath(raw, field, directoryPolicy());
}

/**
 * A task's own file may only be touched while it is still inside the folder
 * the task declares, so a tampered `savePath` cannot reach other files.
 */
function assertTaskOwnFile(task: DownloadTask): string {
  const resolved = assertAllowedFilePath(task.savePath, 'savePath');
  const expected = path.resolve(task.directory);
  if (!isWithin(expected, resolved)) {
    throw new Error('The task file is outside its own download folder.');
  }
  if (path.basename(resolved) !== path.basename(task.savePath)) {
    throw new Error('The task file path looks tampered with.');
  }
  return resolved;
}

// ------------------------------------------------------------ task patching

/**
 * Fields the renderer may change after creation.
 *
 * Everything else — savePath, url, status, downloadedBytes, segments,
 * totalBytes, error, timestamps — stays under main-process control, so the
 * renderer cannot redirect a write or forge completion state.
 */
function buildTaskPatch(patch: unknown, task: DownloadTask): Partial<DownloadTask> {
  if (!isRecord(patch)) throw new Error('Invalid task patch.');
  // Explicitly reject protected/unknown keys instead of silently dropping them:
  // an attempt to write savePath or forge status is reported, not ignored.
  const EDITABLE = new Set([
    'openWhenDone', 'description', 'categoryId', 'connections', 'referer',
    'username', 'password', 'headers', 'queueId', 'directory', 'fileName',
  ]);
  const rejected = Object.keys(patch).filter((key) => !EDITABLE.has(key));
  if (rejected.length > 0) {
    throw new Error(
      `These fields cannot be changed from the window: ${rejected.join(', ')}. ` +
        `Editable fields are: ${[...EDITABLE].join(', ')}.`,
    );
  }
  const allowed: Partial<DownloadTask> = {};
  if (patch.openWhenDone !== undefined) {
    allowed.openWhenDone = asBoolean(patch.openWhenDone, 'openWhenDone');
  }
  if (patch.description !== undefined) {
    allowed.description = asString(patch.description, 'description', 4000).trim();
  }
  if (patch.categoryId !== undefined) {
    allowed.categoryId = asEnum(patch.categoryId, 'categoryId', [
      'completed', 'programs', 'music', 'video', 'games', 'documents', 'archives', 'other',
    ] as const);
  }
  if (patch.connections !== undefined) {
    allowed.connections = asInt(patch.connections, 'connections', 1, 32);
  }
  if (patch.referer !== undefined) {
    const referer = asStringOrNull(patch.referer, 'referer', 4096);
    allowed.referer = referer ? parseHttpUrl(referer, 'referer').toString() : null;
  }
  if (patch.username !== undefined) {
    allowed.username = asStringOrNull(patch.username, 'username', 256);
  }
  if (patch.password !== undefined) {
    allowed.password = asStringOrNull(patch.password, 'password', 256);
  }
  if (patch.headers !== undefined) {
    allowed.headers = sanitizeHeaderRecord(patch.headers, 'headers');
  }
  if (patch.queueId !== undefined) {
    allowed.queueId = patch.queueId === null ? null : asString(patch.queueId, 'queueId', 64);
  }
  // Moving a task to another folder: the new save path is derived here from the
  // validated folder plus the task's own file name. The renderer can never
  // supply `savePath` directly, which is what closed the arbitrary-write bug.
  if (patch.directory !== undefined) {
    const directory = assertAllowedDirectory(patch.directory, 'directory');
    const name = assertSafeFileName(
      typeof patch.fileName === 'string' && patch.fileName.trim() ? patch.fileName : task.fileName,
      'fileName',
    );
    allowed.directory = directory;
    allowed.fileName = name;
    allowed.savePath = path.join(directory, name);
    // A finished file that is moved stays finished; an unfinished task keeps
    // its accounting and is restarted from zero by the engine.
    if (task.status === 'completed') allowed.finishedAt = task.finishedAt;
  }
  if (Object.keys(allowed).length === 0) {
    throw new Error('The request did not contain any editable field.');
  }
  return allowed;
}

// --------------------------------------------------------------- navigation

/** Is `url` the app's own bundled renderer page (or the dev server)? */
function isInternalRendererUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') {
    const rendererRoot = path.resolve(__dirname, '..', 'renderer');
    let filePath: string;
    try {
      filePath = decodeURIComponent(u.pathname);
    } catch {
      return false;
    }
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
    return isWithin(rendererRoot, path.resolve(filePath));
  }
  if (DEV_ORIGINS.length > 0) {
    const origin = `${u.protocol}//${u.host}`;
    return DEV_ORIGINS.includes(origin);
  }
  return false;
}

/** Open an external link safely: only http(s) leaves the app. */
function openExternalSafely(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  void shell.openExternal(u.toString());
}

/**
 * Lock a webContents down: no navigation away from the bundled renderer, no
 * new windows, no webview embedding, no unexpected permissions.
 */
function applyWebContentsPolicy(contents: Electron.WebContents): void {
  const block = (raw: string, reason: string): void => {
    console.warn(`[FenxiDL] Blocked ${reason}: ${raw}`);
    if (/^https?:/i.test(raw)) openExternalSafely(raw);
  };

  // Electron 33 delivers these as a single `details` object where `url`
  // lives on the event itself; the trailing `url` argument is deprecated.
  contents.on('will-navigate', (details) => {
    if (isInternalRendererUrl(details.url)) return;
    details.preventDefault();
    block(details.url, 'navigation away from the app page');
  });

  // Covers sub-frames and in-page navigations that `will-navigate` misses.
  contents.on('will-frame-navigate', (details) => {
    if (isInternalRendererUrl(details.url)) return;
    details.preventDefault();
    block(details.url, 'frame navigation away from the app page');
  });

  contents.on('will-redirect', (details) => {
    if (isInternalRendererUrl(details.url)) return;
    details.preventDefault();
    block(details.url, 'redirect away from the app page');
  });

  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    console.warn('[FenxiDL] Blocked a <webview> attachment.');
    event.preventDefault();
  });
}

/** Deny every renderer permission except the ones the UI actually needs. */
function applyPermissionPolicy(targetSession: Electron.Session): void {
  const ALLOWED = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);
  targetSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (ALLOWED.has(permission)) {
      callback(true);
      return;
    }
    console.warn(`[FenxiDL] Denied a permission request: ${permission}`);
    callback(false);
  });
  targetSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
  targetSession.setDisplayMediaRequestHandler((_request, callback) => {
    // Screen capture is never needed by a download manager.
    callback({});
  });
}

// ---------------------------------------------------------------------- IPC

function registerIpc(): void {
  // ------------------------------------------------------------- snapshots
  handle('dl:snapshot', () => ok(redactSnapshot()));

  // ---------------------------------------------------------------- tasks
  handle('dl:createTask', (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('Invalid task payload.');
    const directory = raw.directory === undefined || raw.directory === null
      ? undefined
      : assertAllowedDirectory(raw.directory, 'directory');
    const input: TaskCreateInput = {
      url: validateUrl(asString(raw.url, 'url')),
      fileName: typeof raw.fileName === 'string' && raw.fileName.trim()
        ? assertSafeFileName(raw.fileName, 'fileName')
        : undefined,
      directory,
      categoryId: asOptionalEnum(raw.categoryId, 'categoryId', [
        'completed', 'programs', 'music', 'video', 'games', 'documents', 'archives', 'other',
      ] as const) as CategoryId | undefined,
      description: asOptionalString(raw.description, 'description', 4000),
      connections: asOptionalInt(raw.connections, 'connections', 1, 32),
      username: asStringOrNull(raw.username, 'username', 256),
      password: asStringOrNull(raw.password, 'password', 256),
      referer: raw.referer === undefined || raw.referer === null
        ? null
        : parseHttpUrl(raw.referer, 'referer').toString(),
      headers: sanitizeHeaderRecord(raw.headers, 'headers'),
      queueId: asStringOrNull(raw.queueId, 'queueId', 64),
      addToQueueOnly: raw.addToQueueOnly === true,
      startNow: raw.startNow === true,
      openWhenDone: raw.openWhenDone === true,
    };
    if (input.directory && settings.useLastPathForGeneral) {
      const rule = settings.categories.find((c) => c.id === 'completed');
      if (rule && previewAllowsDirectory(input.directory)) {
        // Persist the folder the user actually chose so the next general
        // download defaults there (spec string 1190).
        settings = {
          ...settings,
          categories: settings.categories.map((c) =>
            c.id === 'completed' ? { ...c, directory: input.directory as string } : c,
          ),
        };
        requireManager().applySettings(settings);
        void saveSettings(settings);
      }
    }
    const task = requireManager().createTask(input);
    // Three states, because "no explicit instruction" is genuinely different
    // from "start now":
    //   addToQueueOnly          -> the user chose 加入队列, never start here
    //   startNow                -> the user pressed 开始下载, always start
    //   neither (clipboard/API) -> fall back to the extension allow-list
    // Previously the allow-list gated every task, so pressing 开始下载 for a
    // .bin / extension-less / ?id= URL added it and left it queued until the
    // user also pressed 开始队列.
    const startsNow = input.addToQueueOnly === true
      ? false
      : input.startNow === true
        ? true
        : requireManager().shouldAutoStart(input.url);
    if (startsNow) requireManager().start(task.id);
    pushSnapshot();
    return ok(task);
  });

  handle('dl:setTaskOptions', (id: unknown, patch: unknown) => {
    if (!isRecord(patch)) throw new Error('Invalid options payload.');
    const allowed: Partial<DownloadTask> = {};
    if (patch.openWhenDone !== undefined) {
      allowed.openWhenDone = asBoolean(patch.openWhenDone, 'openWhenDone');
    }
    const updated = requireManager().updateTask(asString(id, 'id'), allowed);
    pushSnapshot();
    return ok(updated ?? null);
  });

  handle('dl:startTask', (id: unknown) => {
    const started = requireManager().start(asString(id, 'id'));
    pushSnapshot();
    return ok(started);
  });
  handle('dl:pauseTask', (id: unknown) => {
    requireManager().pause(asString(id, 'id'));
    pushSnapshot();
    return ok(true);
  });
  handle('dl:stopTask', (id: unknown) => {
    requireManager().stop(asString(id, 'id'));
    pushSnapshot();
    return ok(true);
  });
  handle('dl:removeTask', (id: unknown, deleteFile: unknown) => {
    const taskId = asString(id, 'id');
    const removeFile = asBoolean(deleteFile === undefined ? false : deleteFile, 'deleteFile');
    if (removeFile) {
      const task = requireManager().getTask(taskId);
      if (!task) throw new Error('The task no longer exists.');
      // Only ever delete this task's own file, and only inside its own folder.
      const safe = assertTaskOwnFile(task);
      requireManager().removeTask(taskId, false);
      void fsp.rm(safe, { force: true }).catch((err: unknown) => {
        broadcast('dl:log', `Could not delete ${safe}: ${(err as Error).message}`);
      });
    } else {
      requireManager().removeTask(taskId, false);
    }
    pushSnapshot();
    return ok(true);
  });
  handle('dl:removeCompleted', () => {
    requireManager().removeCompleted();
    pushSnapshot();
    return ok(true);
  });
  handle('dl:stopAll', () => {
    requireManager().stopAll();
    pushSnapshot();
    return ok(true);
  });
  handle('dl:updateTask', (id: unknown, patch: unknown) => {
    const taskId = asString(id, 'id');
    const task = requireManager().getTask(taskId);
    if (!task) throw new Error('The task no longer exists.');
    const allowed = buildTaskPatch(patch, task);
    const updated = requireManager().updateTask(taskId, allowed);
    pushSnapshot();
    return ok(updated ? stripTaskSecrets(updated) : null);
  });

  handle('dl:openFile', async (id: unknown) => {
    const task = requireManager().getTask(asString(id, 'id'));
    if (!task) throw new Error('The task no longer exists.');
    const target = assertTaskOwnFile(task);
    if (!fs.existsSync(target)) throw new Error('The downloaded file is no longer on disk.');
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return ok(true);
  });

  handle('dl:openFolder', async (id: unknown) => {
    const task = requireManager().getTask(asString(id, 'id'));
    if (!task) throw new Error('The task no longer exists.');
    const target = assertTaskOwnFile(task);
    shell.showItemInFolder(target);
    return ok(true);
  });

  // --------------------------------------------------------------- queues
  handle('dl:addQueue', (name: unknown, concurrency: unknown) => {
    const q = requireManager().addQueue(asString(name, 'name', 120).trim(), asInt(concurrency, 'concurrency', 1, 50));
    void saveAux();
    pushSnapshot();
    return ok(q);
  });
  handle('dl:updateQueue', (id: unknown, patch: unknown) => {
    if (!isRecord(patch)) throw new Error('Invalid queue patch.');
    const allowed: Partial<Queue> = {};
    if (patch.name !== undefined) allowed.name = asString(patch.name, 'name', 120).trim();
    if (patch.concurrency !== undefined) {
      allowed.concurrency = asInt(patch.concurrency, 'concurrency', 1, 50);
    }
    requireManager().updateQueue(asString(id, 'id'), allowed);
    void saveAux();
    pushSnapshot();
    return ok(true);
  });
  handle('dl:removeQueue', (id: unknown) => {
    requireManager().removeQueue(asString(id, 'id'));
    void saveAux();
    pushSnapshot();
    return ok(true);
  });
  handle('dl:moveToQueue', (taskId: unknown, queueId: unknown) => {
    requireManager().moveToQueue(asString(taskId, 'taskId'), queueId === null ? null : asString(queueId, 'queueId'));
    pushSnapshot();
    return ok(true);
  });
  handle('dl:startQueue', (queueId: unknown) => {
    requireManager().startQueue(queueId === null ? null : asString(queueId, 'queueId'));
    pushSnapshot();
    return ok(true);
  });
  handle('dl:stopQueue', (queueId: unknown) => {
    requireManager().stopQueue(queueId === null ? null : asString(queueId, 'queueId'));
    pushSnapshot();
    return ok(true);
  });

  // ------------------------------------------------------------ schedules
  handle('dl:setSchedules', (entries: unknown) => {
    const parsed = sanitizeSchedules(entries);
    requireManager().setSchedules(parsed);
    void saveAux();
    pushSnapshot();
    return ok(true);
  });

  // ------------------------------------------------------------- settings
  handle('dl:getSettings', () => ok(withheldCredentials(requireManager().getSettings())));
  handle('dl:saveSettings', async (next: unknown) => {
    if (!isRecord(next)) throw new Error('Invalid settings payload.');
    const current = requireManager().getSettings();
    // Secrets are write-only for the renderer: an unchanged masked value must
    // not overwrite the stored password with the mask.
    const payload: Record<string, unknown> = { ...next };
    if (payload.credentials !== undefined) {
      payload.credentials = mergeWithheldCredentialPasswords(payload.credentials, current);
    }
    payload.httpProxy = mergeWithheldProxyPassword(payload.httpProxy, current.httpProxy);
    payload.httpsProxy = mergeWithheldProxyPassword(payload.httpsProxy, current.httpsProxy);
    payload.ftpProxy = mergeWithheldProxyPassword(payload.ftpProxy, current.ftpProxy);

    const merged = mergeSettings(current, payload, {
      validateProgram: (program) => assertExecutableProgram(program, 'virusScan.program'),
      onSecurityChange: (message) => broadcast('dl:log', message),
    });
    // Directory fields must point somewhere the user could actually download to.
    assertAllowedDirectory(merged.defaultDirectory, 'defaultDirectory');
    for (const category of merged.categories) {
      try {
        assertAllowedDirectory(category.directory, `categories.${category.id}.directory`);
      } catch {
        // A category pointing outside the allow-list falls back to the default
        // root rather than failing the whole save.
        category.directory = merged.defaultDirectory;
      }
    }
    settings = merged;
    requireManager().applySettings(merged);
    await saveSettings(merged);
    applyLaunchAtStartup(merged);
    restartClipboardMonitor();
    pushSnapshot();
    return ok(withheldCredentials(merged));
  });

  // ------------------------------------------------------------ batch/new
  handle('dl:expandBatch', (spec: unknown) => {
    if (!isRecord(spec)) throw new Error('Invalid batch payload.');
    const parsed: BatchSpec = {
      template: asString(spec.template, 'template'),
      from: asInt(spec.from, 'from', -1e9, 1e9),
      to: asInt(spec.to, 'to', -1e9, 1e9),
      width: asInt(spec.width, 'width', 1, 10),
    };
    return ok(expandBatch(parsed));
  });
  handle('dl:suggestWidth', (to: unknown) => ok(suggestWidth(asNumber(to, 'to'))));

  handle('dl:probeUrl', async (url: unknown) => {
    // A probe makes the main process issue a request, so it must not be able
    // to bounce off the local machine or a metadata endpoint (SSRF).
    const target = parseHttpUrl(url, 'url');
    assertOutboundHostAllowed(target.toString(), { blockLoopback: true });
    const info = await probe(target.toString());
    return ok(info);
  });

  // ----------------------------------------------------------- filesystem
  handle('dl:chooseDirectory', async (current: unknown) => {
    const requested = typeof current === 'string' && current ? current : settings.defaultDirectory;
    let startDir = settings.defaultDirectory;
    try {
      // A path outside the allow-list only makes a bad default; never trust it.
      startDir = assertAllowedDirectory(requested, 'directory');
    } catch {
      startDir = settings.defaultDirectory;
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a folder',
      defaultPath: startDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return ok(null);
    const chosen = path.resolve(result.filePaths[0]);
    // A native picker is the user's consent: remember it for this session.
    userChosenDirectories.add(chosen);
    return ok(chosen);
  });

  handle('dl:checkPath', async (target: unknown) => {
    // Read-only probe: creating arbitrary directories was the original bug.
    let resolved: string;
    try {
      resolved = assertAllowedDirectory(target, 'directory');
    } catch (err) {
      return ok({ writable: false, message: (err as Error).message, allowed: false });
    }
    try {
      await fsp.access(resolved, fs.constants.W_OK);
      return ok({ writable: true, message: '', allowed: true });
    } catch (err) {
      return ok({ writable: false, message: (err as Error).message, allowed: true });
    }
  });

  // ------------------------------------------------------- import / export
  handle('dl:exportTasks', async (format: unknown) => {
    const kind = asEnum(format, 'format', ['text', 'fdx'] as const);
    const tasks = requireManager().listTasks();
    if (kind === 'text') {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export the download list as text',
        defaultPath: path.join(app.getPath('documents'), 'fenxidl-list.txt'),
        filters: [{ name: 'Text file', extensions: ['txt'] }],
      });
      if (result.canceled || !result.filePath) return ok(null);
      const body = tasks.map((t) => t.url).join('\r\n');
      await fsp.writeFile(result.filePath, `${body}\r\n`, 'utf8');
      hardenFilePermissions(result.filePath, 0o600);
      return ok(result.filePath);
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export the download list',
      defaultPath: path.join(app.getPath('documents'), 'fenxidl-list.fdx'),
      filters: [{ name: 'FenxiDL export file', extensions: ['fdx'] }],
    });
    if (result.canceled || !result.filePath) return ok(null);
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      // Credentials never leave the app through an export file.
      tasks: tasks.map((t) => ({
        url: t.url,
        fileName: t.fileName,
        directory: t.directory,
        categoryId: t.categoryId,
        description: t.description,
        connections: t.connections,
        referer: t.referer,
        queueId: t.queueId,
      })),
    };
    await fsp.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    hardenFilePermissions(result.filePath, 0o600);
    return ok(result.filePath);
  });

  handle('dl:importTasks', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import a download list',
      properties: ['openFile'],
      filters: [
        { name: 'Download lists', extensions: ['fdx', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return ok({ imported: 0 });
    const file = result.filePaths[0];
    const raw = await fsp.readFile(file, 'utf8');
    let urls: string[] = [];
    if (file.toLowerCase().endsWith('.fdx')) {
      const data = JSON.parse(raw) as { version?: number; tasks?: Array<{ url: string }> };
      if (data.version !== 1 || !Array.isArray(data.tasks)) {
        throw new Error('The export file is corrupt or from an incompatible version.');
      }
      urls = data.tasks.map((t) => t.url).filter((u) => typeof u === 'string');
    } else {
      urls = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^https?:\/\//i.test(l));
    }
    let imported = 0;
    const skipped: string[] = [];
    for (const url of urls.slice(0, 10_000)) {
      try {
        parseHttpUrl(url);
        const task = requireManager().createTask({ url: validateUrl(url), addToQueueOnly: true });
        requireManager().start(task.id);
        imported += 1;
      } catch (err) {
        skipped.push((err as Error).message);
      }
    }
    if (skipped.length > 0) {
      broadcast('dl:log', `Skipped ${skipped.length} imported entries: ${skipped[0]}`);
    }
    pushSnapshot();
    return ok({ imported, skipped: skipped.length });
  });

  // --------------------------------------------------------------- grabber
  handle('dl:grabberStart', (project: unknown) => {
    const parsed = validateGrabberProject(project);
    if (grabberHandle) throw new Error('A grabber run is already in progress.');
    assertOutboundHostAllowed(parsed.startUrl, { blockLoopback: true });
    grabberProject = parsed;
    grabberFiles = [];
    grabberStats = {
      status: 'exploring',
      pagesProcessed: 0,
      filesFound: 0,
      filesMatched: 0,
      filesDownloaded: 0,
    };
    broadcast('dl:grabberStats', grabberStats);
    grabberHandle = startGrabber(parsed, {
      onStats: (s) => {
        grabberStats = s;
        broadcast('dl:grabberStats', s);
      },
      onFiles: (files) => {
        grabberFiles = files;
        broadcast('dl:grabberFiles', files);
      },
      onLog: (message) => broadcast('dl:grabberLog', message),
    });
    void grabberHandle.promise.finally(() => {
      grabberHandle = null;
      broadcast('dl:grabberStats', { ...grabberStats, status: grabberStats.status === 'exploring' ? 'completed' : grabberStats.status });
    });
    return ok(true);
  });

  handle('dl:grabberStop', () => {
    grabberHandle?.stop();
    return ok(true);
  });

  handle('dl:grabberAddToTasks', (urls: unknown) => {
    if (!Array.isArray(urls)) throw new Error('Expected a list of URLs.');
    const project = grabberProject;
    let added = 0;
    for (const raw of urls.slice(0, 5000)) {
      if (typeof raw !== 'string') continue;
      try {
        const url = parseHttpUrl(raw).toString();
        assertOutboundHostAllowed(url, { blockLoopback: true });
        const match = grabberFiles.find((f) => f.absoluteUrl === raw);
        const target = project
          ? path.join(project.saveDirectory, relativeSavePath(project, match ?? {
              url,
              absoluteUrl: url,
              fileName: fileNameFromUrl(url),
              extension: '',
              linkText: '',
              sourcePage: '',
              depth: 0,
              sizeBytes: null,
            }))
          : undefined;
        const directory = target ? path.dirname(target) : project?.saveDirectory;
        if (directory) assertAllowedDirectory(directory, 'directory');
        const task = requireManager().createTask({
          url,
          directory,
          fileName: target ? assertSafeFileName(path.basename(target), 'fileName') : undefined,
          description: project?.useLinkTextAsDescription && match ? match.linkText : '',
          addToQueueOnly: !project?.downloadAllMatches,
        });
        if (project?.downloadAllMatches) requireManager().start(task.id);
        added += 1;
      } catch {
        /* skip rejected entries, count the rest */
      }
    }
    grabberStats = { ...grabberStats, filesDownloaded: grabberStats.filesDownloaded + added };
    broadcast('dl:grabberStats', grabberStats);
    pushSnapshot();
    return ok(added);
  });

  handle('dl:grabberSaveProject', async (project: unknown) => {
    const next = validateGrabberProject(project);
    const existing = await requireManager().loadGrabberProjects(grabberProjectsPath());
    const idx = existing.findIndex((p) => p.id === next.id);
    if (idx >= 0) existing[idx] = next;
    else existing.push(next);
    await requireManager().saveGrabberProjects(existing, grabberProjectsPath());
    hardenFilePermissions(grabberProjectsPath(), 0o600);
    return ok(true);
  });

  handle('dl:grabberListProjects', async () => {
    const list = await requireManager().loadGrabberProjects(grabberProjectsPath());
    return ok(list);
  });

  handle('dl:grabberDeleteProject', async (id: unknown) => {
    const target = asString(id, 'id', 64);
    const existing = await requireManager().loadGrabberProjects(grabberProjectsPath());
    await requireManager().saveGrabberProjects(existing.filter((p) => p.id !== target), grabberProjectsPath());
    hardenFilePermissions(grabberProjectsPath(), 0o600);
    return ok(true);
  });

  // --------------------------------------------------------------- system
  handle('dl:uiFlags', () =>
    ok({
      showStartDialog: settings.showStartDialog,
      showProgressDialog: settings.showProgressDialog,
      showCompleteDialog: settings.showCompleteDialog,
      showTipsOnStartup: settings.showTipsOnStartup,
      language: settings.language,
      plaintextSecrets: secretCodecOrNull() === null,
      // Surfaced so the UI can tell the user their queue list was reset
      // instead of silently starting with no queues.
      auxLoadError,
    }),
  );
  handle('dl:getSniffedMedia', () => ok(sniffedMedia.slice()));
  handle('dl:clearSniffedMedia', () => {
    sniffedMedia.length = 0;
    return ok(true);
  });
  handle('dl:snifferInfo', () =>
    ok({ running: sniffer !== null, port: sniffer?.port ?? SNIFFER_PORT }),
  );

  handle('dl:languages', () => ok(LANGUAGE_IDS));
  handle('dl:revealLogs', async () => {
    await shell.openPath(userDataDir());
    return ok(true);
  });
}

/**
 * Validate a grabber project payload.
 *
 * The project drives outbound requests and defines a save folder, so both the
 * URL and the folder are checked, and every numeric knob is bounded.
 */
function validateGrabberProject(raw: unknown): GrabberProject {
  if (!isRecord(raw)) throw new Error('Invalid grabber project.');
  const startUrl = parseHttpUrl(raw.startUrl, 'startUrl').toString();
  const saveDirectory = assertAllowedDirectory(raw.saveDirectory, 'saveDirectory');
  const listOf = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === 'string')
      .slice(0, 500)
      .map((x) => asString(x, field, 200));
  };
  return {
    id: asString(raw.id, 'id', 64),
    name: asString(raw.name, 'name', 200),
    startUrl,
    saveDirectory,
    onlyThisSite: raw.onlyThisSite === true,
    wholeSite: raw.wholeSite === true,
    maxDepth: asInt(raw.maxDepth, 'maxDepth', 0, 64),
    otherSiteDepth: asInt(raw.otherSiteDepth, 'otherSiteDepth', 0, 64),
    excludeParentDirs: raw.excludeParentDirs === true,
    includeTypes: listOf(raw.includeTypes, 'includeTypes'),
    excludeTypes: listOf(raw.excludeTypes, 'excludeTypes'),
    includePaths: listOf(raw.includePaths, 'includePaths'),
    excludePaths: listOf(raw.excludePaths, 'excludePaths'),
    minBytes: asInt(raw.minBytes, 'minBytes', 0, Number.MAX_SAFE_INTEGER),
    maxBytes: asInt(raw.maxBytes, 'maxBytes', 0, Number.MAX_SAFE_INTEGER),
    concurrentExplore: asInt(raw.concurrentExplore, 'concurrentExplore', 1, 10),
    concurrentDownload: asInt(raw.concurrentDownload, 'concurrentDownload', 1, 10),
    addToQueueOnClose: raw.addToQueueOnClose === true,
    useLinkTextAsDescription: raw.useLinkTextAsDescription === true,
    useRelativePaths: raw.useRelativePaths === true,
    convertLinksForOffline: raw.convertLinksForOffline === true,
    overwriteExisting: raw.overwriteExisting === true,
    downloadAllMatches: raw.downloadAllMatches === true,
    filters: Array.isArray(raw.filters)
      ? raw.filters.slice(0, 100).map((f) => {
          const item = isRecord(f) ? f : {};
          return {
            id: asString(item.id, 'filters.id', 64),
            name: asString(item.name, 'filters.name', 200),
            kind: asEnum(item.kind, 'filters.kind', ['include', 'exclude'] as const),
            patterns: listOf(item.patterns, 'filters.patterns'),
          };
        })
      : [],
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  };
}

/** Strip stored passwords before handing settings to the renderer. */
function withheldCredentials(next: AppSettings): AppSettings {
  return {
    ...next,
    credentials: next.credentials.map((c) => ({ ...c, password: c.password ? SECRET_MASK : '' })),
    httpProxy: { ...next.httpProxy, password: next.httpProxy.password ? SECRET_MASK : '' },
    httpsProxy: { ...next.httpsProxy, password: next.httpsProxy.password ? SECRET_MASK : '' },
    ftpProxy: { ...next.ftpProxy, password: next.ftpProxy.password ? SECRET_MASK : '' },
  };
}

/** Restore masked passwords from the current settings before validating. */
function mergeWithheldCredentialPasswords(raw: unknown, current: AppSettings) {
  if (!Array.isArray(raw)) return raw;
  const previous = new Map(current.credentials.map((c) => [`${c.site.toLowerCase()}|${c.username}`, c]));
  return raw.map((item) => {
    if (!isRecord(item)) return item;
    if (item.password !== SECRET_MASK) return item;
    const key = `${String(item.site ?? '').toLowerCase()}|${String(item.username ?? '')}`;
    const match = previous.get(key);
    return { ...item, password: match ? match.password : '' };
  });
}

function mergeWithheldProxyPassword(raw: unknown, current: AppSettings['httpProxy']) {
  if (!isRecord(raw)) return raw;
  if (raw.password !== SECRET_MASK) return raw;
  return { ...raw, password: current.password };
}

/** Would the directory policy accept this folder right now? */
function previewAllowsDirectory(directory: string): boolean {
  try {
    assertAllowedDirectory(directory, 'directory');
    return true;
  } catch {
    return false;
  }
}

function applyLaunchAtStartup(enabled: AppSettings): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled.launchAtStartup, path: process.execPath });
}

/**
 * Clipboard monitor: when the clipboard holds a URL that looks like a file
 * download, surface it to the renderer so it can offer a new task
 * (spec string 1061).
 */
function restartClipboardMonitor(): void {
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
  if (!settings.monitorClipboard) return;
  clipboardTimer = setInterval(() => {
    if (!settings.monitorClipboard) return;
    let text = '';
    try {
      text = clipboard.readText().trim();
    } catch {
      return;
    }
    if (!text || text === lastClipboardText) return;
    if (!/^https?:\/\/\S+$/i.test(text)) return;
    lastClipboardText = text;
    if (settings.monitorClipboard) broadcast('dl:clipboardUrl', text);
  }, 1200);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 900,
    minHeight: 520,
    show: false,
    title: 'FenxiDL',
    backgroundColor: '#101319',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  applyWebContentsPolicy(mainWindow.webContents);

  const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  // Verify the renderer actually loads inside an asar archive; a silent
  // failure used to leave a blank white window with no diagnostic.
  mainWindow.loadFile(indexPath).catch((err) => {
    console.error('Failed to load the renderer via loadFile:', err);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`Renderer failed to load: ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details.reason);
  });
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`RENDERER: ${message}`);
  });

  // DevTools only when explicitly requested: auto-opening it covers the app
  // window in development runs and makes screenshots look blank.
  if (process.env.FENXI_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function createTray(): void {
  // A 16x16 transparent placeholder keeps the tray clickable without shipping
  // binary art that would need licensing review.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    buf[i * 4 + 0] = 0x4c;
    buf[i * 4 + 1] = 0x8b;
    buf[i * 4 + 2] = 0xf5;
    buf[i * 4 + 3] = 0xff;
  }
  const image = nativeImage.createFromBuffer(buf, { width: size, height: size });
  tray = new Tray(image);
  tray.setToolTip('FenxiDL');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show FenxiDL', click: () => mainWindow?.show() },
      { label: 'Stop all downloads', click: () => manager?.stopAll() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => mainWindow?.show());
}

async function bootstrap(): Promise<void> {
  settings = await loadSettings();
  await loadAux();
  manager = new TaskManager({
    settings,
    queues,
    schedules,
    storagePath: statePath(),
  });
  await manager.load();

  applyPermissionPolicy(session.defaultSession);

  manager.on('changed', () => pushSnapshot());
  manager.on('progress', () => {
    if (manager) broadcast('dl:snapshot', redactSnapshot());
  });
  manager.on('log', (msg: string) => broadcast('dl:log', msg));
  manager.on('quotaExceeded', (msg: string) => {
    broadcast('dl:log', msg);
    if (Notification.isSupported()) {
      new Notification({ title: 'Download quota reached', body: msg }).show();
    }
  });
  manager.on('completed', (task: DownloadTask) => {
    if (!settings.showCompleteDialog) return;
    if (Notification.isSupported()) {
      new Notification({
        title: 'Download complete',
        body: task.fileName,
      }).show();
    }
  });
  manager.on('afterQueueAction', (action: string) => {
    void runAfterQueueAction(action);
  });

  // Media capture service: loopback only, standards-based interception.
  // Gated by both browser integration and the media bar toggle.
  if (settings.showMediaBar && settings.browserIntegration) {
    try {
      sniffer = await startSniffer({
        port: SNIFFER_PORT,
        onMedia: (media) => {
          sniffedMedia.unshift(media);
          if (sniffedMedia.length > 10) sniffedMedia.length = 10;
          broadcast('dl:mediaSniffed', sniffedMedia);
        },
        onLog: (m) => broadcast('dl:log', m),
      });
      broadcast('dl:log', `Media capture service listening on http://127.0.0.1:${sniffer.port}`);
    } catch (err) {
      broadcast('dl:log', `The media capture service could not start: ${(err as Error).message}`);
    }
  }

  registerIpc();
  createWindow();
  createTray();
  applyLaunchAtStartup(settings);
  restartClipboardMonitor();
  if (mainWindow) {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.error(`RENDERER[${level}]: ${message}`);
    });
  }
  manager.startBackgroundWork();

  if (isSmokeEnabled()) {
    void runSmokeCheck();
  }
}

/**
 * The GUI smoke check is a development/build tool, not a product feature: it
 * refuses to run in a packaged build so no test-driving code path is reachable
 * from the shipped application.
 */
function isSmokeEnabled(): boolean {
  if (process.env.FENXI_SMOKE !== '1') return false;
  if (app.isPackaged) {
    console.warn('[FenxiDL] FENXI_SMOKE is ignored in packaged builds.');
    return false;
  }
  return true;
}

/**
 * Automated GUI smoke check, enabled only by FENXI_SMOKE=1 in a dev build.
 *
 * It drives the real window (real IPC, real task manager) and writes the
 * rendered text plus a PNG so the build can be verified headlessly.
 */
async function runSmokeCheck(): Promise<void> {
  const outDir = process.env.FENXI_SMOKE_OUT || path.join(app.getPath('temp'), 'fenxidl-smoke');
  try {
    await fsp.mkdir(outDir, { recursive: true });
    if (!mainWindow) throw new Error('The main window was not created.');
    const win = mainWindow;
    const deadline = Date.now() + 20_000;
    let text = '';
    for (;;) {
      text = (await win.webContents.executeJavaScript('document.body.innerText')) as string;
      if (typeof text === 'string' && text.includes('新建下载')) break;
      if (Date.now() > deadline) throw new Error('The UI did not render in time.');
      await new Promise((r) => setTimeout(r, 250));
    }

    // Visible text plus accessible names: MD3 renders several destinations as
    // icon buttons, whose names live in aria-label/title rather than innerText.
    //
    // File-type shortcuts live inside a collapsed "分类" group so the rail fits
    // at small window heights, so they are asserted after expanding it rather
    // than being expected in the initial render.
    const requiredText = ['FenxiDL', '新建下载', '所有下载', '正在下载', '已完成', '分类', '开始队列', '清理已完成'];
    const missing = requiredText.filter((r) => !text.includes(r));
    if (missing.length > 0) throw new Error(`UI missing labels: ${missing.join(', ')}`);

    // Expand the category group (a flyout panel beside the rail) and confirm every
    // file-type destination is reachable.
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.md-nav-rail__item--group'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const panelText = (await win.webContents.executeJavaScript(
      `document.querySelector('.md-rail-category-panel') ? document.querySelector('.md-rail-category-panel').innerText : ''`,
    )) as string;
    const requiredTypes = ['程序', '音乐', '视频', '游戏', '文档', '压缩文件', '其他'];
    const missingTypes = requiredTypes.filter((r) => !panelText.includes(r));
    if (missingTypes.length > 0) {
      throw new Error(`Rail is missing file-type destinations: ${missingTypes.join(', ')}`);
    }
    // Close the panel again so later assertions see the default rail.
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.md-nav-rail__item--group'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 300));

    const interactiveNames = (await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + b.innerText).join(' | ')`,
    )) as string;
    // Selection-dependent actions (pause/stop/delete) appear in the contextual
    // app bar only after a row is selected, so they are asserted separately.
    const requiredActions = ['站点抓取', '选项', '计划任务', '批量', '媒体'];
    const requiredContextual = ['暂停', '停止', '删除'];
    const missingActions = requiredActions.filter((r) => !interactiveNames.includes(r));
    if (missingActions.length > 0) {
      throw new Error(`UI missing actionable controls: ${missingActions.join(', ')}`);
    }

    // Exercise the real IPC path: create a queued task and confirm it renders.
    const created = (await win.webContents.executeJavaScript(
      `window.fenxi.invoke('dl:createTask', { url: 'http://127.0.0.1:1/smoke.bin', fileName: 'smoke.bin', addToQueueOnly: true })`,
    )) as { ok: boolean; error?: string };
    if (!created || created.ok !== true) {
      throw new Error(`dl:createTask failed: ${created?.error ?? 'no response'}`);
    }
    await new Promise((r) => setTimeout(r, 700));

    const rows = (await win.webContents.executeJavaScript(
      'document.querySelectorAll("table.md-table tbody tr").length',
    )) as number;
    if (rows < 1) throw new Error('The task list did not render the created task.');

    // Select the first row and confirm the contextual app bar exposes the
    // selection actions; this also proves the MD3 navigation pattern works.
    const selectedOk = (await win.webContents.executeJavaScript(
      `(() => { const row = document.querySelector('table.md-table tbody tr'); if (!row) return 'no rows'; row.click(); return 'clicked'; })()`,
    )) as string;
    if (selectedOk !== 'clicked') throw new Error(`Could not select a row: ${selectedOk}`);
    await new Promise((r) => setTimeout(r, 400));

    const contextualNames = (await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('header button')).map((b) => (b.getAttribute('aria-label') || '') + ' ' + b.innerText).join(' | ')`,
    )) as string;
    const missingContextual = requiredContextual.filter((r) => !contextualNames.includes(r));
    if (missingContextual.length > 0) {
      throw new Error(`Contextual app bar missing actions: ${missingContextual.join(', ')}`);
    }

    const headerText = (await win.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("table.md-table thead th")).map(th => th.innerText.trim()).join("|")',
    )) as string;
    for (const col of ['文件名', '状态', '大小', '传输速率']) {
      if (!headerText.includes(col)) throw new Error(`Missing column: ${col} (${headerText})`);
    }

    const image = await win.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'main-window.png'), image.toPNG());

    // Clear the selection so the default app bar is captured as well.
    await win.webContents.executeJavaScript(
      `(() => { const b = Array.from(document.querySelectorAll('header button')).find(x => (x.getAttribute('aria-label')||'') === '取消选择'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const defaultShot = await win.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'main-window-default.png'), defaultShot.toPNG());

    // Close whatever dialog the selection flow may have opened, then open
    // Options and read back its tabs.
    // Leave the contextual app bar (clear the selection) so the default
    // app-bar actions - including Options - are reachable again.
    await win.webContents.executeJavaScript(
      `(() => { const b = Array.from(document.querySelectorAll('header button')).find(x => (x.getAttribute('aria-label')||'') === '取消选择'); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.getAttribute('aria-label') || x.getAttribute('title') || x.innerText || '').includes('选项')); if (b) b.click(); return !!b; })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const dialogText = (await win.webContents.executeJavaScript(
      'document.querySelector(".md-dialog") ? document.querySelector(".md-dialog").innerText : ""',
    )) as string;
    if (dialogText.length === 0) {
      const dump = (await win.webContents.executeJavaScript(
        'Array.from(document.querySelectorAll("button")).map(b => (b.getAttribute("aria-label")||"")+"|"+(b.getAttribute("title")||"")+"|"+b.innerText).join(" ;; ")',
      )) as string;
      throw new Error(`No dialog opened. Buttons: ${dump.slice(0, 600)}`);
    }
    for (const tab of ['常规', '连接', '下载', '代理', '站点管理', '拨号连接', '声音事件']) {
      if (!dialogText.includes(tab)) throw new Error(`Options dialog missing tab: ${tab} (dialog text: ${dialogText.slice(0,200)})`);
    }
    const dialogImage = await win.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, 'options-dialog.png'), dialogImage.toPNG());

    // Verify the dialog surface is opaque: a transparent dialog let the table
    // show through, which this assertion now guards against.
    const dialogBg = (await win.webContents.executeJavaScript(
      `(() => { const d = document.querySelector('.md-dialog'); if (!d) return 'missing'; const cs = getComputedStyle(d); return cs.backgroundColor; })()`,
    )) as string;
    if (dialogBg === 'missing') throw new Error('Options dialog element not found.');
    if (dialogBg.includes('rgba') && /rgba\([^)]*,\s*0?\.\d+\)/.test(dialogBg)) {
      throw new Error(`Dialog background is translucent: ${dialogBg}`);
    }
    const scrimOpacity = (await win.webContents.executeJavaScript(
      `getComputedStyle(document.querySelector('.md-scrim')).opacity`,
    )) as string;
    if (scrimOpacity !== '1') {
      throw new Error(`Scrim must not carry container opacity (got ${scrimOpacity}); it fades the dialog too.`);
    }

    // Close a dialog by its accessible name.
    // Diagnose whether the renderer survived the Options dialog interaction.
    const health = (await win.webContents.executeJavaScript(
      "JSON.stringify({ url: location.href, ready: document.readyState, len: document.body.innerText.length, rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1 })",
    )) as string;

    const closeDialog = async (): Promise<void> => {
      await win.webContents.executeJavaScript(
        `(() => { const b = Array.from(document.querySelectorAll('.md-dialog__header button')).find(x => (x.getAttribute('aria-label')||'') === '关闭'); if (b) b.click(); return !!b; })()`,
      );
      await new Promise((r) => setTimeout(r, 300));
    };
    await closeDialog();

    // Exercise the remaining dialogs so each MD3 surface is mounted at least once.
    const openByName = async (name: string): Promise<boolean> => {
      const info = (await win.webContents.executeJavaScript(
        `(() => {
           const all = Array.from(document.querySelectorAll('button'));
           const matches = all.filter(x => (x.getAttribute('aria-label')||'').includes(${JSON.stringify(name)}) || (x.getAttribute('title')||'').includes(${JSON.stringify(name)}) || (x.innerText||'').includes(${JSON.stringify(name)}));
           if (matches.length === 0) return { ok: false, count: 0 };
           // Skip the navigation rail: its FAB shares the "新建下载" name but
           // the rail can be scrolled out of view when dialogs auto-open.
           const preferred = matches.filter(x => !x.closest('.md-nav-rail'));
           const b = (preferred.length > 0 ? preferred : matches)[0];
           b.click();
           return { ok: true, count: matches.length, tag: b.className, text: (b.getAttribute('aria-label')||'') + '|' + (b.innerText||'') };
         })()`,
      )) as { ok: boolean; count: number; tag?: string; text?: string };
      await new Promise((r) => setTimeout(r, 600));
      if (!info.ok) {
        throw new Error(`No button matched "${name}".`);
      }
      return info.ok;
    };

    const dialogs: Array<{ name: string; file: string }> = [
      { name: '新建下载', file: 'dialog-new-task.png' },
      { name: '站点抓取', file: 'dialog-grabber.png' },
      { name: '计划任务及下载队列', file: 'dialog-scheduler.png' },
      { name: '批量下载', file: 'dialog-batch.png' },
      { name: '媒体嗅探', file: 'dialog-media.png' },
    ];
    for (const d of dialogs) {
      const opened = await openByName(d.name);
      if (!opened) throw new Error('openByName returned false');
      const mounted = (await win.webContents.executeJavaScript(
        `document.querySelector('.md-dialog') ? document.querySelector('.md-dialog__headline').innerText : ''`,
      )) as string;
      if (!mounted) {
        const dump = (await win.webContents.executeJavaScript(
          "document.querySelectorAll('.md-scrim').length + '|' + document.querySelectorAll('.md-dialog').length + '|' + document.body.innerText.slice(0,150)",
        )) as string;
        throw new Error(`Dialog did not mount: ${d.name} [${dump}] health=${health} crashed=${win.webContents.isCrashed()}`);
      }
      const shot = await win.webContents.capturePage();
      await fsp.writeFile(path.join(outDir, d.file), shot.toPNG());
      await closeDialog();
    }

    // Verify the light colour scheme resolves: set data-theme and confirm the
    // surface role actually changes.
    const lightCheck = (await win.webContents.executeJavaScript(
      `(() => {
         const root = document.documentElement;
         const before = getComputedStyle(root).getPropertyValue('--md-surface').trim();
         root.setAttribute('data-theme', 'light');
         const after = getComputedStyle(root).getPropertyValue('--md-surface').trim();
         root.removeAttribute('data-theme');
         return before + '->' + after;
       })()`,
    )) as string;
    if (lightCheck.split('->')[0] === lightCheck.split('->')[1]) {
      throw new Error(`Light theme tokens did not apply: ${lightCheck}`);
    }

    console.log(`SMOKE OK rows=${rows} out=${outDir}`);
    console.log(`SMOKE_COLUMNS=${headerText}`);
    console.log('SMOKE_ALL_CHECKS_PASSED');
    app.exit(0);
  } catch (err) {
    console.error(`SMOKE FAILED: ${(err as Error).message}`);
    app.exit(1);
  }
}

async function runAfterQueueAction(action: string): Promise<void> {
  broadcast('dl:log', `Queue finished; running the scheduled action: ${action}.`);
  if (action === 'exit') {
    app.quit();
    return;
  }
  // Shutdown, sleep and hibernate are OS-level actions. They are deliberately
  // reported rather than executed automatically so an unattended run cannot
  // power off the machine unexpectedly.
  const labels: Record<string, string> = {
    shutdown: 'shut down the computer',
    sleep: 'put the computer to sleep',
    hibernate: 'hibernate the computer',
    hangup: 'disconnect the dial-up connection',
  };
  const label = labels[action] ?? action;
  const confirmed = await dialog.showMessageBox(mainWindow ?? undefined!, {
    type: 'question',
    title: 'Queue finished',
    message: `The queue has finished. Do you want to ${label} now?`,
    buttons: ['Yes', 'No'],
    defaultId: 1,
    cancelId: 1,
  });
  if (confirmed.response !== 0) return;
  // The command table is fixed and selected by an enum, so nothing here can be
  // steered by renderer data (V-18).
  const { execFile } = await import('node:child_process');
  const command: { file: string; args: string[] } | null =
    action === 'shutdown' ? { file: 'shutdown', args: ['/s', '/t', '0'] }
      : action === 'sleep' ? { file: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] }
        : action === 'hibernate' ? { file: 'shutdown', args: ['/h'] }
          : action === 'hangup' ? { file: 'rasdial', args: ['/disconnect'] }
            : null;
  if (command) {
    execFile(command.file, command.args, (err) => {
      if (err) broadcast('dl:log', `The ${label} command failed: ${err.message}`);
    });
  }
}

// Single-instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    dialog.showErrorBox('FenxiDL could not start', String(err));
    app.quit();
  });

  // Keep running in the tray so scheduled queues can still fire; the tray owns
  // the window lifecycle and `before-quit` releases the services.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', () => {
    void manager?.dispose();
    void sniffer?.close();
    sniffer = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// Exported for the smoke harness and for unit tests of the validation policy.
export { isInternalRendererUrl, withheldCredentials as __withheldCredentials, validateGrabberProject as __validateGrabberProject, sanitizeVirusScan, CONNECTION_TYPE_IDS, LANGUAGE_IDS };