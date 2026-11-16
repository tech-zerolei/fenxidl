/**
 * Electron main process: window lifecycle, tray, IPC surface and app services.
 *
 * The IPC channel names and payloads are the contract consumed by the
 * renderer; each handler validates its input and never trusts the renderer.
 */

import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell, Notification } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AppSettings,
  DownloadTask,
  GrabberProject,
  GrabberStats,
  IpcResult,
  Queue,
  ScheduleEntry,
  TaskCreateInput,
} from '../shared/types';
import { expandBatch, suggestWidth, type BatchSpec } from './batch';
import { fileNameFromUrl, probe } from './download-engine';
import { relativeSavePath, startGrabber, type CrawlFoundFile, type GrabberHandle } from './grabber';
import { startSniffer, type SniffedMedia, type SnifferHandle } from './media-sniffer';
import { defaultSettings, LANGUAGES } from './settings';
import { TaskManager } from './task-manager';

// esbuild emits CommonJS for the main process, so __dirname is available.
declare const __dirname: string;


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

function userDataDir(): string {
  return app.getPath('userData');
}

function statePath(): string {
  return path.join(userDataDir(), 'state.json');
}

function settingsPath(): string {
  return path.join(userDataDir(), 'settings.json');
}

function grabberProjectsPath(): string {
  return path.join(userDataDir(), 'grabber-projects.json');
}

async function loadSettings(): Promise<AppSettings> {
  const base = defaultSettings();
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Merge shallowly so new default fields appear after an update.
    const merged: AppSettings = { ...base, ...parsed };
    merged.categories = Array.isArray(parsed.categories) && parsed.categories.length
      ? parsed.categories
      : base.categories;
    merged.credentials = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    merged.serverConnectionOverrides = parsed.serverConnectionOverrides ?? {};
    return merged;
  } catch {
    return base;
  }
}

async function saveSettings(next: AppSettings): Promise<void> {
  await fsp.mkdir(userDataDir(), { recursive: true });
  const tmp = `${settingsPath()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fsp.rename(tmp, settingsPath());
}

async function loadAux(): Promise<void> {
  try {
    const raw = await fsp.readFile(path.join(userDataDir(), 'aux.json'), 'utf8');
    const data = JSON.parse(raw) as { queues?: Queue[]; schedules?: ScheduleEntry[] };
    queues = Array.isArray(data.queues) && data.queues.length ? data.queues : [];
    schedules = Array.isArray(data.schedules) ? data.schedules : [];
  } catch {
    queues = [];
    schedules = [];
  }
  if (queues.length === 0) {
    queues = [{ id: 'primary', name: 'Main download queue', concurrency: settings.defaultQueueConcurrency, isPrimary: true }];
  }
  if (!queues.some((q) => q.isPrimary)) {
    queues.unshift({ id: 'primary', name: 'Main download queue', concurrency: settings.defaultQueueConcurrency, isPrimary: true });
  }
}

async function saveAux(): Promise<void> {
  await fsp.mkdir(userDataDir(), { recursive: true });
  const tmp = path.join(userDataDir(), 'aux.json.tmp');
  await fsp.writeFile(tmp, JSON.stringify({ queues, schedules }, null, 2), 'utf8');
  await fsp.rename(tmp, path.join(userDataDir(), 'aux.json'));
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pushSnapshot(): void {
  if (!manager) return;
  queues = manager.getQueues();
  schedules = manager.getSchedules();
  broadcast('dl:snapshot', manager.snapshot());
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string, maxLen = 8192): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a string.`);
  if (v.length > maxLen) throw new Error(`${field} is too long.`);
  return v;
}

function asNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${field} must be a number.`);
  return v;
}

function validateUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error('Please enter a valid URL, including http:// or https://.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }
  return u.toString();
}

function registerIpc(): void {
  // ------------------------------------------------------------- snapshots
  handle('dl:snapshot', () => ok(requireManager().snapshot()));

  // ---------------------------------------------------------------- tasks
  handle('dl:createTask', (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('Invalid task payload.');
    const input: TaskCreateInput = {
      url: validateUrl(asString(raw.url, 'url')),
      fileName: typeof raw.fileName === 'string' ? asString(raw.fileName, 'fileName', 260) : undefined,
      directory: typeof raw.directory === 'string' ? asString(raw.directory, 'directory', 1024) : undefined,
      categoryId: typeof raw.categoryId === 'string' ? (raw.categoryId as TaskCreateInput['categoryId']) : undefined,
      description: typeof raw.description === 'string' ? asString(raw.description, 'description', 4000) : undefined,
      connections: typeof raw.connections === 'number' ? asNumber(raw.connections, 'connections') : undefined,
      username: typeof raw.username === 'string' ? raw.username : null,
      password: typeof raw.password === 'string' ? raw.password : null,
      referer: typeof raw.referer === 'string' ? raw.referer : null,
      headers: isRecord(raw.headers) ? (raw.headers as Record<string, string>) : {},
      queueId: typeof raw.queueId === 'string' ? raw.queueId : null,
      addToQueueOnly: raw.addToQueueOnly === true,
      openWhenDone: raw.openWhenDone === true,
    };
    if (input.directory && settings.useLastPathForGeneral) {
      const rule = settings.categories.find((c) => c.id === 'completed');
      if (rule) {
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
    // Honour the auto-start extension list (Options > General).
    const autoStart = !input.addToQueueOnly && requireManager().shouldAutoStart(input.url);
    if (autoStart) requireManager().start(task.id);
    pushSnapshot();
    return ok(task);
  });

  handle('dl:setTaskOptions', (id: unknown, patch: unknown) => {
    if (!isRecord(patch)) throw new Error('Invalid options payload.');
    const allowed: Partial<DownloadTask> = {};
    if (typeof patch.openWhenDone === 'boolean') allowed.openWhenDone = patch.openWhenDone;
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
    requireManager().removeTask(asString(id, 'id'), deleteFile === true);
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
    if (!isRecord(patch)) throw new Error('Invalid task patch.');
    const updated = requireManager().updateTask(asString(id, 'id'), patch as Partial<DownloadTask>);
    pushSnapshot();
    return ok(updated ?? null);
  });

  handle('dl:openFile', async (id: unknown) => {
    const task = requireManager().getTask(asString(id, 'id'));
    if (!task) throw new Error('The task no longer exists.');
    if (!fs.existsSync(task.savePath)) throw new Error('The downloaded file is no longer on disk.');
    const err = await shell.openPath(task.savePath);
    if (err) throw new Error(err);
    return ok(true);
  });

  handle('dl:openFolder', async (id: unknown) => {
    const task = requireManager().getTask(asString(id, 'id'));
    if (!task) throw new Error('The task no longer exists.');
    shell.showItemInFolder(task.savePath);
    return ok(true);
  });

  // --------------------------------------------------------------- queues
  handle('dl:addQueue', (name: unknown, concurrency: unknown) => {
    const q = requireManager().addQueue(asString(name, 'name', 120), asNumber(concurrency, 'concurrency'));
    void saveAux();
    pushSnapshot();
    return ok(q);
  });
  handle('dl:updateQueue', (id: unknown, patch: unknown) => {
    if (!isRecord(patch)) throw new Error('Invalid queue patch.');
    requireManager().updateQueue(asString(id, 'id'), patch as Partial<Queue>);
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
    if (!Array.isArray(entries)) throw new Error('Schedules must be an array.');
    requireManager().setSchedules(entries as ScheduleEntry[]);
    void saveAux();
    pushSnapshot();
    return ok(true);
  });

  // ------------------------------------------------------------- settings
  handle('dl:getSettings', () => ok(requireManager().getSettings()));
  handle('dl:saveSettings', async (next: unknown) => {
    if (!isRecord(next)) throw new Error('Invalid settings payload.');
    const merged = { ...requireManager().getSettings(), ...(next as Partial<AppSettings>) } as AppSettings;
    settings = merged;
    requireManager().applySettings(merged);
    await saveSettings(merged);
    applyLaunchAtStartup(merged);
    restartClipboardMonitor();
    pushSnapshot();
    return ok(merged);
  });

  // ------------------------------------------------------------ batch/new
  handle('dl:expandBatch', (spec: unknown) => {
    if (!isRecord(spec)) throw new Error('Invalid batch payload.');
    const parsed: BatchSpec = {
      template: asString(spec.template, 'template'),
      from: asNumber(spec.from, 'from'),
      to: asNumber(spec.to, 'to'),
      width: asNumber(spec.width, 'width'),
    };
    return ok(expandBatch(parsed));
  });
  handle('dl:suggestWidth', (to: unknown) => ok(suggestWidth(asNumber(to, 'to'))));

  handle('dl:probeUrl', async (url: unknown) => {
    const target = validateUrl(asString(url, 'url'));
    const info = await probe(target);
    return ok(info);
  });

  // ----------------------------------------------------------- filesystem
  handle('dl:chooseDirectory', async (current: unknown) => {
    const startDir = typeof current === 'string' && current ? current : settings.defaultDirectory;
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a folder',
      defaultPath: startDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return ok(null);
    return ok(result.filePaths[0]);
  });

  handle('dl:checkPath', async (target: unknown) => {
    const dir = asString(target, 'directory', 1024);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.access(dir, fs.constants.W_OK);
      return ok({ writable: true, message: '' });
    } catch (err) {
      return ok({ writable: false, message: (err as Error).message });
    }
  });

  // ------------------------------------------------------- import / export
  handle('dl:exportTasks', async (format: unknown) => {
    const kind = asString(format, 'format');
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
    for (const url of urls) {
      try {
        const task = requireManager().createTask({ url, addToQueueOnly: true });
        requireManager().start(task.id);
        imported += 1;
      } catch {
        /* skip invalid entries, count the rest */
      }
    }
    pushSnapshot();
    return ok({ imported });
  });

  // --------------------------------------------------------------- grabber
  handle('dl:grabberStart', (project: unknown) => {
    if (!isRecord(project)) throw new Error('Invalid grabber project.');
    const parsed = project as unknown as GrabberProject;
    if (!parsed.startUrl || !/^https?:\/\//i.test(parsed.startUrl)) {
      throw new Error('The start page must be a valid http or https URL.');
    }
    if (grabberHandle) throw new Error('A grabber run is already in progress.');
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
    for (const raw of urls) {
      if (typeof raw !== 'string') continue;
      const match = grabberFiles.find((f) => f.absoluteUrl === raw);
      try {
        const target = project
          ? path.join(project.saveDirectory, relativeSavePath(project, match ?? {
              url: raw,
              absoluteUrl: raw,
              fileName: fileNameFromUrl(raw),
              extension: '',
              linkText: '',
              sourcePage: '',
              depth: 0,
              sizeBytes: null,
            }))
          : undefined;
        const task = requireManager().createTask({
          url: raw,
          directory: target ? path.dirname(target) : project?.saveDirectory,
          fileName: target ? path.basename(target) : undefined,
          description: project?.useLinkTextAsDescription && match ? match.linkText : '',
          addToQueueOnly: !project?.downloadAllMatches,
        });
        if (project?.downloadAllMatches) requireManager().start(task.id);
        added += 1;
      } catch {
        /* skip */
      }
    }
    grabberStats = { ...grabberStats, filesDownloaded: grabberStats.filesDownloaded + added };
    broadcast('dl:grabberStats', grabberStats);
    pushSnapshot();
    return ok(added);
  });

  handle('dl:grabberSaveProject', async (project: unknown) => {
    if (!isRecord(project)) throw new Error('Invalid grabber project.');
    const existing = await requireManager().loadGrabberProjects(grabberProjectsPath());
    const next = project as unknown as GrabberProject;
    const idx = existing.findIndex((p) => p.id === next.id);
    if (idx >= 0) existing[idx] = next;
    else existing.push(next);
    await requireManager().saveGrabberProjects(existing, grabberProjectsPath());
    return ok(true);
  });

  handle('dl:grabberListProjects', async () => {
    const list = await requireManager().loadGrabberProjects(grabberProjectsPath());
    return ok(list);
  });

  handle('dl:grabberDeleteProject', async (id: unknown) => {
    const target = asString(id, 'id');
    const existing = await requireManager().loadGrabberProjects(grabberProjectsPath());
    await requireManager().saveGrabberProjects(existing.filter((p) => p.id !== target), grabberProjectsPath());
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

  handle('dl:languages', () => ok(LANGUAGES));
  handle('dl:revealLogs', async () => {
    await shell.openPath(userDataDir());
    return ok(true);
  });
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
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links always leave the app, never navigate the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

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

  manager.on('changed', () => pushSnapshot());
  manager.on('progress', () => {
    if (manager) broadcast('dl:snapshot', manager.snapshot());
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

  if (process.env.FENXI_SMOKE === '1') {
    void runSmokeCheck();
  }
}

/**
 * Automated GUI smoke check, enabled only by FENXI_SMOKE=1.
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
    const requiredText = ['FenxiDL', '新建下载', '所有下载', '正在下载', '已完成', '程序', '开始队列', '清理已完成'];
    const missing = requiredText.filter((r) => !text.includes(r));
    if (missing.length > 0) throw new Error(`UI missing labels: ${missing.join(', ')}`);

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
      if (!opened) throw new Error(`Could not open dialog: ${d.name}`);
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
  const { exec } = await import('node:child_process');
  const command =
    action === 'shutdown' ? 'shutdown /s /t 0'
      : action === 'sleep' ? 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'
        : action === 'hibernate' ? 'shutdown /h'
          : action === 'hangup' ? 'rasdial /disconnect'
            : '';
  if (command) exec(command);
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

  app.on('window-all-closed', () => {
    // Keep running in the tray so scheduled queues can still fire.
    if (process.platform !== 'darwin') {
      // no-op: the tray owns the lifecycle
    }
  });

  app.on('before-quit', () => {
    void manager?.dispose();
    void sniffer?.close();
    sniffer = null;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}