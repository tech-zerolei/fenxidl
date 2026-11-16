/**
 * Task orchestration: queue scheduling, per-task lifecycle, speed accounting,
 * quota enforcement and persistence.
 *
 * Mirrors the reverse-engineered behaviour in docs/FEATURE-SPEC.md:
 *  - concurrency per queue and per server (§2.1, string 1306/226)
 *  - quota windows that pause and resume transfers (§2.3, 20408/20409)
 *  - resume with graceful degradation when Range is unsupported (§2.1)
 *  - segment-level progress for the details view (§3)
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AppSettings,
  DownloadTask,
  GrabberProject,
  ProgressSnapshot,
  Queue,
  ScheduleEntry,
  Segment,
  TaskCreateInput,
  TaskStatus,
} from '../shared/types';
import {
  describeTransferError,
  downloadSegment,
  fileNameFromUrl,
  isRetryableNetworkError,
  planSegments,
  prepareFile,
  probe,
  sanitizeFileName,
  statWorkFile,
  uniquePath,
  type RequestOptions,
} from './download-engine';
import { buildScanArgv, hostMatchesSite } from './validate';

export interface TaskManagerOptions {
  settings: AppSettings;
  queues: Queue[];
  schedules: ScheduleEntry[];
  storagePath: string;
}

interface RunningTask {
  controller: AbortController;
  /** Unique per start(); stale cleanup handlers compare against it. */
  token: number;
  /** Why the run is ending, so the terminal status matches the user's action. */
  intent: 'running' | 'pause' | 'stop';
  /** Bytes counted in the current speed sample window. */
  windowBytes: number;
  windowStart: number;
  speed: number;
  /** Bytes counted in the current throttle second. */
  throttleBytes: number;
  throttleStart: number;
}

const SPEED_WINDOW_MS = 700;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export class TaskManager extends EventEmitter {
  private tasks = new Map<string, DownloadTask>();
  private queues: Queue[];
  private schedules: ScheduleEntry[];
  private settings: AppSettings;
  private running = new Map<string, RunningTask>();
  private storagePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private quotaTimer: NodeJS.Timeout | null = null;
  private quotaUsedToday = 0;
  private quotaWindowKey = '';
  private quotaPaused = false;
  private disposed = false;
  /** Monotonic counter backing RunningTask.token. */
  private runTokenSeq = 0;
  /**
   * Tasks the user stopped explicitly, and tasks a queue-level stop parked.
   * Both live only in memory: after a restart everything is `paused` and the
   * user resumes it deliberately.
   */
  private userStopped = new Set<string>();
  private queueStopped = new Set<string>();
  /**
   * While true, {@link pump} refuses to start anything.
   *
   * Aborting a transfer is asynchronous: `run()`'s rejection handler runs on a
   * later tick and calls pump(), so a bulk stop that aborted several tasks
   * could have a queued task started again *after* the stop loop finished.
   * stopAll()/stopQueue() set this for the duration of the operation.
   */
  private pumpHalted = false;
  /** Tasks paused by the quota latch, resumed when the latch clears. */
  private quotaPausedIds = new Set<string>();

  constructor(opts: TaskManagerOptions) {
    super();
    this.settings = opts.settings;
    this.queues = opts.queues;
    this.schedules = opts.schedules;
    this.storagePath = opts.storagePath;
  }

  /** Load persisted state. Missing or corrupt state starts empty. */
  async load(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.storagePath, 'utf8');
      const data = JSON.parse(raw) as { tasks?: DownloadTask[]; quota?: { key: string; used: number } };
      for (const task of data.tasks ?? []) {
        // Anything that was mid-flight must wait for an explicit start.
        if (task.status === 'downloading' || task.status === 'connecting') {
          task.status = 'paused';
          task.speed = 0;
        }
        task.speed = 0;
        task.eta = Number.NaN;
        this.tasks.set(task.id, task);
      }
      if (data.quota && data.quota.key === this.currentQuotaKey()) {
        this.quotaUsedToday = data.quota.used;
        this.quotaWindowKey = data.quota.key;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.emit('log', `Could not read saved state: ${describeTransferError(err)}`);
      }
    }
    this.quotaWindowKey = this.currentQuotaKey();
  }

  /** Debounced persistence so a burst of progress updates writes once. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 800);
  }

  async saveNow(): Promise<void> {
    const payload = {
      version: 1,
      tasks: [...this.tasks.values()].map((t) => ({
        ...t,
        // Persist only durable fields; live speed is recomputed.
        speed: 0,
        eta: Number.NaN,
      })),
      quota: { key: this.quotaWindowKey, used: this.quotaUsedToday },
    };
    try {
      await fsp.mkdir(path.dirname(this.storagePath), { recursive: true });
      const tmp = `${this.storagePath}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fsp.rename(tmp, this.storagePath);
    } catch (err) {
      this.emit('log', `Could not save state: ${describeTransferError(err)}`);
    }
  }

  private currentQuotaKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  }

  snapshot(): ProgressSnapshot {
    const tasks = [...this.tasks.values()];
    let totalSpeed = 0;
    for (const t of tasks) totalSpeed += t.speed;
    return {
      tasks,
      queues: this.queues,
      schedules: this.schedules,
      settings: this.settings,
      stats: {
        activeCount: tasks.filter((t) => t.status === 'downloading' || t.status === 'connecting').length,
        totalSpeed,
        quotaUsedToday: this.quotaUsedToday,
      },
    };
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  getQueues(): Queue[] {
    return this.queues;
  }

  getSchedules(): ScheduleEntry[] {
    return this.schedules;
  }

  listTasks(): DownloadTask[] {
    return [...this.tasks.values()];
  }

  getTask(id: string): DownloadTask | undefined {
    return this.tasks.get(id);
  }

  // ---------------------------------------------------------------- creation

  /**
   * Resolve the save directory for a category, honouring the spec defaults.
   *
   * Order: the caller's explicit choice, then the category rule, then — for a
   * *general* download with "use the last path" enabled — the remembered
   * folder, then the global default.
   *
   * The remembered folder currently arrives in the `completed` archive rule's
   * `directory` (that is where `index.ts` stores it, see
   * {@link rememberedGeneralDirectory}). Reading it here is what makes the
   * option work at all: without this branch the value was written and never
   * consulted, because `categoryForUrl` skips the `completed` rule.
   * The clean fix is a dedicated `lastGeneralDirectory` setting; until then
   * this keeps the option functional and confined to general downloads.
   */
  private resolveDirectory(
    categoryId: DownloadTask['categoryId'],
    explicit?: string,
    inferred = false,
  ): string {
    if (explicit && explicit.trim()) return explicit;
    // A general download — one whose folder was inferred from the URL rather
    // than chosen by the caller — follows the remembered folder when the option
    // is on. Category rules, which the user configured explicitly, still win
    // for their own extensions.
    // `other` is the general-download bucket: no extension rule matched, so the
    // user has expressed no per-type preference and the remembered folder wins.
    if (inferred && categoryId === 'other') {
      const remembered = this.rememberedGeneralDirectory();
      if (remembered) return remembered;
    }
    const rule = this.settings.categories.find((c) => c.id === categoryId);
    if (rule && rule.directory.trim()) return rule.directory;
    return this.settings.defaultDirectory;
  }

  /**
   * The folder the user picked for the previous general download, or ''.
   *
   * `index.ts` (spec string 1190) persists that choice by overwriting the
   * `completed` category's `directory`, and `categoryForUrl` deliberately skips
   * `completed` — so the value was stored but never read back, and the option
   * silently did nothing. Reading it here fixes the behaviour without touching
   * the IPC layer. See reports/engine.md item 18 for the decoupled version.
   */
  private rememberedGeneralDirectory(): string {
    if (!this.settings.useLastPathForGeneral) return '';
    const completed = this.settings.categories.find((c) => c.id === 'completed');
    const dir = completed?.directory?.trim() ?? '';
    if (!dir) return '';
    // Guard against a nonsense value acting as a download root.
    return path.isAbsolute(dir) ? dir : '';
  }

  private categoryForUrl(url: string, fallback: DownloadTask['categoryId']): DownloadTask['categoryId'] {
    const name = fileNameFromUrl(url).toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot < 0) return fallback;
    const ext = name.slice(dot + 1);
    for (const rule of this.settings.categories) {
      if (rule.id === 'completed') continue;
      if (rule.extensions.some((e) => e === ext)) return rule.id;
    }
    return fallback;
  }

  /** Whether the URL's extension is in the auto-start list (string 1270). */
  shouldAutoStart(url: string): boolean {
    const list = this.settings.autoStartExtensions;
    if (!Array.isArray(list) || list.length === 0) return true;
    const name = fileNameFromUrl(url).toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    const ext = name.slice(dot + 1);
    return list.includes(ext);
  }

  createTask(input: TaskCreateInput): DownloadTask {
    // `inferred` records whether the category came from the URL rather than
    // from the caller; resolveDirectory uses it to apply "use the last path"
    // only to general downloads.
    const inferred = input.categoryId === undefined;
    const categoryId = input.categoryId ?? this.categoryForUrl(input.url, 'other');
    const directory = this.resolveDirectory(categoryId, input.directory, inferred);
    const fileName = sanitizeFileName(input.fileName?.trim() || fileNameFromUrl(input.url));
    const claimed = new Set([...this.tasks.values()].map((t) => t.savePath));
    const savePath = uniquePath(directory, fileName, claimed);
    const now = Date.now();
    const task: DownloadTask = {
      id: `t${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      url: input.url,
      fileName: path.basename(savePath),
      savePath,
      directory,
      categoryId,
      description: input.description?.trim() || '',
      // A new task never starts on its own, whatever `addToQueueOnly` says:
      // the caller decides by calling start()/pump(). The old
      // `addToQueueOnly ? 'queued' : 'queued'` spelled the same value twice and
      // implied a distinction that does not exist.
      status: 'queued',
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      eta: Number.NaN,
      supportsResume: false,
      segments: [],
      connections: clamp(input.connections ?? this.settings.defaultConnections, 1, 32),
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      queueId: input.queueId ?? null,
      username: input.username ?? null,
      password: input.password ?? null,
      referer: input.referer ?? null,
      userAgent: null,
      headers: input.headers ?? {},
      error: null,
      restartedFromZero: false,
      etag: null,
      lastModified: null,
      mimeType: null,
      openWhenDone: input.openWhenDone === true,
    };
    this.tasks.set(task.id, task);
    this.scheduleSave();
    this.emit('changed');
    return task;
  }

  updateTask(id: string, patch: Partial<DownloadTask>): DownloadTask | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    // Never let a caller overwrite identity or live counters directly.
    const { id: _id, segments: _segments, ...rest } = patch;
    Object.assign(task, rest);
    this.scheduleSave();
    this.emit('changed');
    return task;
  }

  removeTask(id: string, deleteFile = false): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.stop(id);
    this.tasks.delete(id);
    if (deleteFile) {
      void fsp.rm(task.savePath, { force: true }).catch(() => undefined);
    }
    this.scheduleSave();
    this.emit('changed');
  }

  removeCompleted(): void {
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'completed') this.tasks.delete(t.id);
    }
    this.scheduleSave();
    this.emit('changed');
  }

  // ------------------------------------------------------------- lifecycle

  /** Credentials for a host: task-level override, then the site store. */
  private credentialsFor(task: DownloadTask): { username: string | null; password: string | null } {
    if (task.username) return { username: task.username, password: task.password };
    // Match on `hostname`, not `host`: `host` keeps the port, so a site stored
    // as `example.com` would never match `example.com:8443`.
    let hostname = '';
    try {
      hostname = new URL(task.url).hostname.toLowerCase();
    } catch {
      return { username: null, password: null };
    }
    // Only an exact host or a real sub-domain may match. The old
    // `task.url.toLowerCase().includes(site)` branch handed the stored Basic
    // auth to any URL that merely *mentioned* the site — `http://evil/?bank.com`
    // or `http://evil/bank.com/x.bin` both leaked the credentials.
    const cred = this.settings.credentials.find((c) => hostMatchesSite(hostname, c.site));
    return cred ? { username: cred.username, password: cred.password } : { username: null, password: null };
  }

  /**
   * Connection count for a task. A per-server override wins, then the task's
   * own value, then the connection-type preset, then the global default.
   */
  private connectionsFor(task: DownloadTask): number {
    let host = '';
    try {
      host = new URL(task.url).host.toLowerCase();
    } catch {
      /* keep task default */
    }
    const override = this.settings.serverConnectionOverrides[host];
    if (typeof override === 'number' && override > 0) return clamp(override, 1, 32);
    if (task.connections > 0) return clamp(task.connections, 1, 32);
    return clamp(this.settings.defaultConnections, 1, 32);
  }

  /** Start a task. Returns false when it cannot start right now. */
  start(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (this.running.has(id)) return false;
    if (task.status === 'completed') return false;
    if (this.quotaPaused) return false;

    const controller = new AbortController();
    const running: RunningTask = {
      controller,
      // Each start gets a fresh token. Cleanup handlers compare it before
      // touching state so a stale run() can never abort or overwrite the run
      // that replaced it (that race used to leave tasks permanently stuck).
      token: ++this.runTokenSeq,
      intent: 'running',
      windowBytes: 0,
      windowStart: Date.now(),
      speed: 0,
      throttleBytes: 0,
      throttleStart: Date.now(),
    };
    this.running.set(id, running);
    // A new run supersedes any previous stop bookkeeping for this task.
    this.userStopped.delete(id);
    this.queueStopped.delete(id);
    task.status = 'connecting';
    task.error = null;
    task.speed = 0;
    this.emit('changed');

    void this.run(task, running).catch((err) => {
      const current = this.running.get(id);
      // A newer run owns this task now; leave it alone.
      if (!current || current.token !== running.token) return;
      this.running.delete(id);

      const code = (err as NodeJS.ErrnoException).code;
      const intent = running.intent;
      if (code === 'ABORTED' || intent !== 'running') {
        // Honour what the user actually asked for.
        task.status = intent === 'pause' ? 'paused' : 'stopped';
      } else {
        task.status = 'error';
        task.error = {
          code: code ?? 'UNKNOWN',
          message: describeTransferError(err),
          retryable: isRetryableNetworkError(err),
          at: Date.now(),
        };
      }
      task.speed = 0;
      this.scheduleSave();
      this.emit('changed');
      this.pump();
    });

    return true;
  }

  /**
   * Stop the active run for a task. The caller's intent decides the terminal
   * status, so pause() and stop() no longer both collapse into "stopped".
   */
  private finishRunning(id: string, intent: 'pause' | 'stop' | 'running' = 'stop'): void {
    const r = this.running.get(id);
    if (r) {
      r.intent = intent;
      r.controller.abort();
      this.running.delete(id);
    }
  }

  stop(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.finishRunning(id, 'stop');
    // Recorded so startQueue() does not resurrect a task the user stopped.
    this.userStopped.add(id);
    if (task.status !== 'completed') {
      task.status = 'stopped';
      task.speed = 0;
      this.scheduleSave();
      this.emit('changed');
    }
    this.pump();
  }

  pause(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.finishRunning(id, 'pause');
    // A pause is not a stop: the user expects startQueue() to leave it alone,
    // but an explicit start() must be able to resume it.
    this.userStopped.delete(id);
    if (task.status !== 'completed') {
      task.status = 'paused';
      task.speed = 0;
      this.scheduleSave();
      this.emit('changed');
    }
    this.pump();
  }

  stopAll(): void {
    // Halt the scheduler for the whole operation. Each stop() used to pump the
    // queues, and that pump started a task which had been waiting for a free
    // slot — but the running-id snapshot was already taken, so the freshly
    // started transfer outlived stopAll() and quietly kept writing (observed: a
    // task still in `downloading` right after stopAll()).
    const wasHalted = this.pumpHalted;
    this.pumpHalted = true;
    try {
      for (const id of [...this.running.keys()]) this.finishRunning(id, 'stop');
      for (const t of this.tasks.values()) {
        if (t.status === 'downloading' || t.status === 'connecting' || t.status === 'queued') {
          t.status = 'stopped';
          t.speed = 0;
          this.userStopped.add(t.id);
        }
      }
    } finally {
      this.pumpHalted = wasHalted;
    }
    this.scheduleSave();
    this.emit('changed');
  }

  /** The actual transfer implementation for one task. */
  private async run(task: DownloadTask, running: RunningTask): Promise<void> {
    const creds = this.credentialsFor(task);
    const options: RequestOptions = {
      username: creds.username,
      password: creds.password,
      referer: task.referer,
      userAgent: task.userAgent,
      headers: task.headers,
      // Proxy settings from Options > Proxy are applied to every request,
      // including the initial probe and each segment.
      httpProxy: this.settings.httpProxy,
      httpsProxy: this.settings.httpsProxy,
    };

    const info = await probe(task.url, options);
    if (running.controller.signal.aborted) return;
    if (!info.ok) {
      if (info.requiresAuth) {
        throw Object.assign(new Error(info.error ?? 'Authentication required'), { code: 'EAUTH' });
      }
      throw Object.assign(new Error(info.error ?? 'The download could not be started.'), { code: 'EPROBE' });
    }

    task.mimeType = info.mimeType;
    // A resume is only valid while the remote object is unchanged. Compare the
    // validators captured by the previous run against the probe we just made:
    // if the file was replaced in between, the partial bytes on disk belong to
    // a different revision and mixing them would produce a corrupt file that we
    // would otherwise announce as complete.
    const changedRemotely = this.remoteObjectChanged(task, info);
    if (changedRemotely) {
      this.emit(
        'log',
        `The file changed on the server; ${task.fileName} will be downloaded again from the start.`,
      );
      task.segments = [];
      task.downloadedBytes = 0;
      task.restartedFromZero = true;
    }
    task.etag = info.etag;
    task.lastModified = info.lastModified;
    task.supportsResume = info.supportsResume;
    task.totalBytes = info.totalBytes;
    task.status = 'downloading';
    task.startedAt = task.startedAt ?? Date.now();
    // Sent with every ranged request so the server itself tells us when the
    // object changed mid-transfer (it answers 200 instead of 206).
    const ifRange = info.etag ?? info.lastModified ?? null;

    // Honour the server-provided name when the task kept the URL-derived one.
    if (info.fileName) {
      const suggested = sanitizeFileName(info.fileName);
      const currentBase = path.basename(task.savePath);
      const urlBase = sanitizeFileName(fileNameFromUrl(task.url));
      if (currentBase === urlBase && suggested !== currentBase) {
        const claimed = new Set([...this.tasks.values()].filter((t) => t.id !== task.id).map((t) => t.savePath));
        task.savePath = uniquePath(task.directory, suggested, claimed);
        task.fileName = path.basename(task.savePath);
      }
    }

    // Extension correction from the reported MIME type (spec string 20513).
    const corrected = this.correctExtension(task.savePath, info.mimeType);
    if (corrected && corrected !== task.savePath) {
      const claimed = new Set([...this.tasks.values()].filter((t) => t.id !== task.id).map((t) => t.savePath));
      task.savePath = uniquePath(task.directory, path.basename(corrected), claimed);
      task.fileName = path.basename(task.savePath);
    }

    this.emit('changed');

    // Retry policy is resolved per transfer (see retryPolicyFor) so that two
    // concurrent tasks with different Options no longer overwrite each other.

    const wanted = this.connectionsFor(task);
    const useSegments = info.supportsResume && info.totalBytes > 0 && wanted > 1;
    if (!useSegments) {
      // Single connection; resume from whatever is already on disk.
      await this.runSingle(task, running, options, info.totalBytes, ifRange);
      return;
    }
    await this.runSegmented(task, running, options, info.totalBytes, wanted, ifRange);
  }

  /**
   * Whether the probe shows a different remote object than the one the local
   * partial data belongs to.
   *
   * ETag is authoritative when both sides have one; `Last-Modified` is the
   * weaker fallback used only when no ETag is available at all. A missing
   * validator on either side is "unknown" and never restarts the transfer,
   * because a server that does not expose validators would otherwise force a
   * full re-download on every single resume.
   */
  private remoteObjectChanged(
    task: DownloadTask,
    info: { etag: string | null; lastModified: string | null },
  ): boolean {
    const before = task.etag;
    if (before && info.etag) return before.trim() !== info.etag.trim();
    if (before || info.etag) return false; // one side unknown: cannot prove a change
    const beforeLm = task.lastModified;
    if (beforeLm && info.lastModified) return beforeLm.trim() !== info.lastModified.trim();
    return false;
  }

  private correctExtension(filePath: string, mime: string | null): string | null {
    if (!mime) return null;
    const map: Record<string, string> = {
      'text/html': '.html',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'audio/mpeg': '.mp3',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/x-flv': '.flv',
      'application/x-msdownload': '.exe',
      'application/json': '.json',
      'text/plain': '.txt',
    };
    const want = map[mime.toLowerCase()];
    if (!want) return null;
    const cur = path.extname(filePath).toLowerCase();
    if (!cur || cur === want) return null;
    // Only correct when the current extension is absent or generic.
    if (!['', '.bin', '.download', '.tmp', '.dat', '.php', '.asp', '.aspx', '.jsp', '.cgi'].includes(cur)) {
      return null;
    }
    return filePath.slice(0, filePath.length - cur.length) + want;
  }

  private async runSingle(
    task: DownloadTask,
    running: RunningTask,
    options: RequestOptions,
    totalBytes: number,
    ifRange: string | null,
  ): Promise<void> {
    const workPath = await this.workingPath(task);
    // Read the watermark BEFORE prepareFile preallocates, otherwise the file
    // always looks complete and the transfer restarts from zero.
    const onDisk = await statWorkFile(workPath);
    const unknownLength = totalBytes === 0;

    // Resume only when the bytes on disk belong to the same remote object and
    // actually exist. Anything inconsistent is discarded and refetched, which
    // is the only safe choice: skipping "already done" ranges that are not on
    // disk is what used to produce all-zero files reported as completed.
    let startOffset = 0;
    if (!unknownLength && task.supportsResume && onDisk > 0 && onDisk < totalBytes) {
      startOffset = onDisk;
    }
    if (unknownLength || !task.supportsResume || startOffset === 0) {
      // Nothing trustworthy to keep: start from a clean file.
      await fsp.rm(workPath, { force: true });
    }

    // The counter must describe bytes that are really on disk. It used to keep
    // accumulating across restarts (three interrupted runs reported 150 %),
    // which broke the percentage and the ETA.
    task.downloadedBytes = startOffset;

    // Single connection: let the file grow with the data so its size keeps
    // meaning "bytes actually fetched" and resume can trust it.
    const fileHandle = await prepareFile(workPath, totalBytes, { preallocate: false });
    try {
      const segment = {
        index: 0,
        start: unknownLength ? 0 : startOffset,
        end: unknownLength ? 0 : totalBytes - 1,
        downloaded: 0,
      };
      await downloadSegment(segment, {
        url: task.url,
        fileHandle,
        options,
        signal: running.controller.signal,
        streamWhole: unknownLength || !task.supportsResume,
        retry: this.retryPolicyFor(),
        timeoutMs: this.segmentTimeoutMs(),
        pace: (bytes) => this.pace(running, bytes),
        // Only a genuine resume needs validating; a fresh start has no bytes
        // whose revision could disagree with the server.
        ifRange: startOffset > 0 ? ifRange : null,
        onChunk: (ev) => {
          this.onChunk(task, running, ev.bytes);
        },
      });
      if (unknownLength) {
        // Unknown length: size the file to exactly what arrived.
        const size = fs.fstatSync(fileHandle).size;
        fs.ftruncateSync(fileHandle, size);
        task.totalBytes = size;
        task.downloadedBytes = size;
      }
    } finally {
      fs.closeSync(fileHandle);
    }

    // Never announce a file as complete unless the bytes are really there.
    await this.assertComplete(task, workPath);
    await this.promoteFromTemp(task, workPath);
    this.completeTask(task);
  }

  /**
   * Verify a finished work file before it is promoted. A size mismatch means
   * the transfer lied about its progress, which must surface as an error
   * instead of a "completed" task holding a broken file.
   */
  private async assertComplete(task: DownloadTask, workPath: string): Promise<void> {
    const size = await statWorkFile(workPath);
    if (size === 0 && task.totalBytes === 0) {
      throw Object.assign(new Error('The server returned an empty file.'), { code: 'EEMPTY' });
    }
    if (task.totalBytes > 0 && size !== task.totalBytes) {
      throw Object.assign(
        new Error(`The download is incomplete: ${size} of ${task.totalBytes} bytes were written.`),
        { code: 'EINCOMPLETE' },
      );
    }
    task.downloadedBytes = size;
  }

  private async runSegmented(
    task: DownloadTask,
    running: RunningTask,
    options: RequestOptions,
    totalBytes: number,
    connections: number,
    ifRange: string | null,
  ): Promise<void> {
    const workPath = await this.workingPath(task);

    // Segment progress is only meaningful together with the data it describes.
    // The sidecar is written next to the work file, so whenever the temp files
    // vanish (OS cleanup, changed temp folder, a different machine) the
    // bookkeeping vanishes with them. Trusting stale counters without the bytes
    // is what used to yield an all-zero file marked completed.
    const onDisk = await statWorkFile(workPath);
    const sidecar = await this.readProgressSidecar(workPath, totalBytes);
    // The sidecar records the validator it was written under, so a file
    // replaced on the server invalidates the bookkeeping even when the temp
    // directory still holds data.
    const trustworthy =
      !!sidecar
      && sidecar.totalBytes === totalBytes
      && this.sameEtag(sidecar.etag, ifRange)
      // A preallocated file is exactly totalBytes long. Anything smaller means
      // the data we think we have is not actually there.
      && onDisk === totalBytes
      && sidecar.segments.length > 0;

    if (!trustworthy) {
      if (onDisk > 0 || sidecar) {
        this.emit('log', `Discarding unverifiable partial data for ${task.fileName}; restarting it.`);
      }
      task.segments = planSegments(totalBytes, connections);
      task.downloadedBytes = 0;
      await fsp.rm(workPath, { force: true });
      await fsp.rm(this.sidecarPath(workPath), { force: true });
    } else {
      // Clamp restored counters so a hand-edited state file cannot overshoot.
      task.segments = sidecar.segments.map((s) => {
        const length = s.end - s.start + 1;
        const done = Math.min(Math.max(0, s.downloaded), length);
        return { index: s.index, start: s.start, end: s.end, downloaded: done };
      });
      task.downloadedBytes = task.segments.reduce((sum, s) => sum + s.downloaded, 0);
    }

    const fileHandle = await prepareFile(workPath, totalBytes);
    try {
      const pending = task.segments.filter((s) => s.start + s.downloaded <= s.end);
      const retry = this.retryPolicyFor();
      const timeoutMs = this.segmentTimeoutMs();
      const results = await Promise.allSettled(
        pending.map((segment) =>
          downloadSegment(segment, {
            url: task.url,
            fileHandle,
            options,
            signal: running.controller.signal,
            retry,
            timeoutMs,
            pace: (bytes) => this.pace(running, bytes),
            // Ranges that start at 0 need no validator; the others do.
            ifRange: segment.start + segment.downloaded > 0 ? ifRange : null,
            onChunk: (ev) => {
              this.onChunk(task, running, ev.bytes);
              this.scheduleSidecarSave(task, workPath, ifRange);
            },
          }),
        ),
      );
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      fs.closeSync(fileHandle);
    }

    // Every range must be fully accounted for before the file is announced.
    const short = task.segments.find((s) => s.downloaded !== s.end - s.start + 1);
    if (short) {
      throw Object.assign(
        new Error(`Segment ${short.index} is incomplete (${short.downloaded} of ${short.end - short.start + 1} bytes).`),
        { code: 'EINCOMPLETE' },
      );
    }

    await this.assertComplete(task, workPath);
    await fsp.rm(this.sidecarPath(workPath), { force: true });
    await this.promoteFromTemp(task, workPath);
    this.completeTask(task);
  }

  private sidecarPath(workPath: string): string {
    return `${workPath}.progress.json`;
  }

  /** Compare two ETags, treating a missing value as "unknown, still equal". */
  private sameEtag(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return true;
    return a.trim() === b.trim();
  }

  /**
   * Debounce timers for sidecar writes, keyed by work path. A single shared
   * timer would let one task's progress update cancel another task's write and
   * leave the second sidecar stale on disk.
   */
  private sidecarTimers = new Map<string, NodeJS.Timeout>();

  private scheduleSidecarSave(task: DownloadTask, workPath: string, etag: string | null): void {
    if (this.sidecarTimers.has(workPath)) return;
    const timer = setTimeout(() => {
      this.sidecarTimers.delete(workPath);
      void this.writeProgressSidecar(task, workPath, etag);
    }, 1000);
    this.sidecarTimers.set(workPath, timer);
  }

  private async writeProgressSidecar(
    task: DownloadTask,
    workPath: string,
    etag: string | null,
  ): Promise<void> {
    const payload = {
      version: 1,
      totalBytes: task.totalBytes,
      etag,
      segments: task.segments.map((s) => ({
        index: s.index, start: s.start, end: s.end, downloaded: s.downloaded,
      })),
    };
    try {
      await fsp.writeFile(this.sidecarPath(workPath), JSON.stringify(payload), 'utf8');
    } catch {
      /* best effort: a missing sidecar only costs a restart */
    }
  }

  private async readProgressSidecar(
    workPath: string,
    totalBytes: number,
  ): Promise<{ totalBytes: number; etag: string | null; segments: Segment[] } | null> {
    try {
      const raw = await fsp.readFile(this.sidecarPath(workPath), 'utf8');
      const data = JSON.parse(raw) as {
        version?: number; totalBytes?: number; etag?: string | null; segments?: Segment[];
      };
      if (data.version !== 1 || !Array.isArray(data.segments)) return null;
      if (typeof data.totalBytes !== 'number' || data.totalBytes !== totalBytes) return null;
      const segments = data.segments.filter(
        (s): s is Segment =>
          !!s && Number.isFinite(s.start) && Number.isFinite(s.end) && Number.isFinite(s.downloaded),
      );
      if (segments.length === 0) return null;
      return { totalBytes: data.totalBytes, etag: data.etag ?? null, segments };
    } catch {
      return null;
    }
  }

  /**
   * Rate limiting as an async hook. The previous implementation spun on
   * `while (Date.now() < until)` inside the stream's data callback, which
   * blocked the whole event loop (measured at >2 s of lag) and still exceeded
   * the configured cap. Callers pause the stream while this promise settles.
   *
   * The model is a token bucket: `throttleBytes` is the amount of data that has
   * arrived but has not yet been "paid for" at the configured rate, and it is
   * refilled by the time that actually elapsed. Two details matter for accuracy:
   *  - the refill per call is capped at 250 ms worth, so an idle period cannot
   *    bank an unbounded burst that is then spent at once;
   *  - the wait is never discarded at a window boundary. The earlier code reset
   *    the accounting every second, which threw away the accumulated deficit and
   *    made the transfer run ~25 % over the configured cap.
   */
  private async pace(running: RunningTask, bytes: number): Promise<void> {
    const cap = this.settings.globalSpeedLimit;
    if (cap <= 0) return;
    const now = Date.now();
    if (running.throttleStart <= 0) {
      running.throttleStart = now;
      running.throttleBytes = 0;
    }
    const elapsed = Math.max(0, now - running.throttleStart);
    running.throttleStart = now;
    // Credit for the time since the last chunk, bounded to a small burst.
    const refill = (Math.min(elapsed, 250) / 1000) * cap;
    running.throttleBytes = Math.max(0, running.throttleBytes - refill) + bytes;

    // How long this backlog should take to drain at the configured rate.
    const waitMs = (running.throttleBytes / cap) * 1000;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, Math.ceil(waitMs))));
    }
  }

  private onChunk(task: DownloadTask, running: RunningTask, bytes: number): void {
    task.downloadedBytes += bytes;
    running.windowBytes += bytes;
    this.quotaUsedToday += bytes / (1024 * 1024);

    const now = Date.now();
    const elapsed = now - running.windowStart;
    if (elapsed >= SPEED_WINDOW_MS) {
      const instant = (running.windowBytes / elapsed) * 1000;
      // Exponential smoothing keeps the displayed rate readable.
      running.speed = running.speed === 0 ? instant : running.speed * 0.6 + instant * 0.4;
      task.speed = running.speed;
      if (task.totalBytes > 0 && running.speed > 1) {
        task.eta = Math.max(0, (task.totalBytes - task.downloadedBytes) / running.speed);
      } else {
        task.eta = Number.NaN;
      }
      running.windowBytes = 0;
      running.windowStart = now;
      this.emit('progress');
    }
    this.checkQuota();
  }

  /** Retry policy for one transfer, taken from the current settings. */
  private retryPolicyFor(): { maxRetries: number; retryDelayMs: number } {
    return {
      maxRetries: Math.max(0, Math.floor(this.settings.maxRetries ?? 8)),
      retryDelayMs: Math.max(200, (this.settings.retryDelaySeconds ?? 5) * 1000),
    };
  }

  /** Overall per-range deadline, generous but finite. */
  private segmentTimeoutMs(): number {
    return 30 * 60 * 1000;
  }

  private completeTask(task: DownloadTask): void {
    const id = task.id;
    this.finishRunning(id, 'running');
    task.status = 'completed';
    task.speed = 0;
    task.eta = 0;
    task.finishedAt = Date.now();
    if (task.totalBytes > 0) task.downloadedBytes = task.totalBytes;
    else task.totalBytes = task.downloadedBytes;
    // A completed task moves to the completed category like the original.
    task.categoryId = 'completed';
    this.scheduleSave();
    this.emit('changed');
    this.emit('completed', task);
    // Post-download hooks are deliberately fire-and-forget (a virus scan must not
    // hold the queue), so they run after the state is final. The old comment
    // claimed the opposite of what the code did, and the floating promise had no
    // rejection handler, so any hook failure surfaced as an unhandled rejection.
    void this.runPostCompletionHooks(task).catch((err: unknown) => {
      this.emit('log', `Post-download action failed: ${(err as Error).message}`);
    });
    this.pump();
    this.maybeRunAfterQueueAction();
  }

  /**
   * Path used while the transfer is in flight. When a temp directory is
   * configured the partial data lives there and is moved into place on
   * completion, so a half-finished file never appears in the user's folder.
   */
  /**
   * Where a transfer writes while it is in flight.
   *
   * A directory that merely exists is not necessarily writable: a previous run
   * (possibly by another user, or a container) can leave a read-only temp
   * folder behind, and mkdir alone succeeds on it. Probing with a real write is
   * the only reliable check, and failing that we fall back to the destination
   * folder instead of failing every download.
   */
  private async workingPath(task: DownloadTask): Promise<string> {
    const temp = this.settings.tempDirectory?.trim();
    if (!temp) return task.savePath;
    try {
      await fsp.mkdir(temp, { recursive: true });
      const probeFile = path.join(temp, `.fenxidl-probe-${process.pid}`);
      await fsp.writeFile(probeFile, '');
      await fsp.rm(probeFile, { force: true });
      // Keep the extension so segment logic and virus scanners see the type.
      return path.join(temp, `${task.id}${path.extname(task.savePath)}.part`);
    } catch {
      this.emit('log', `The temp folder is not writable (${temp}); staging next to the destination instead.`);
      return task.savePath;
    }
  }

  /** Move the finished temp file to its final location. */
  private async promoteFromTemp(task: DownloadTask, workPath: string): Promise<void> {
    if (workPath === task.savePath) return;
    try {
      await fsp.mkdir(path.dirname(task.savePath), { recursive: true });
      // rename fails across volumes; fall back to copy + remove.
      try {
        await fsp.rename(workPath, task.savePath);
      } catch {
        await fsp.copyFile(workPath, task.savePath);
        await fsp.rm(workPath, { force: true });
      }
    } catch (err) {
      this.emit('log', `Could not move the finished file into place: ${(err as Error).message}`);
    }
  }

  /**
   * Post-download hooks: virus scan, then open the file when requested.
   * Failures are reported through the log channel and never fail the download.
   */
  private async runPostCompletionHooks(task: DownloadTask): Promise<void> {
    const scan = this.settings.virusScan;
    if (scan.enabled && scan.program.trim()) {
      // Build the argv from the template with quote awareness: splitting on
      // whitespace tore a path like "/tmp/a b.bin" into two arguments, so the
      // scanner received a truncated file name. `%f` always expands to exactly
      // one argument holding the whole path.
      const argv = buildScanArgv(scan.args, task.savePath);
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(scan.program, argv, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', (err) => this.emit('log', `Virus scan could not start: ${err.message}`));
        child.unref();
        this.emit('log', `Started virus scan for ${task.fileName}.`);
      } catch (err) {
        this.emit('log', `Virus scan failed to launch: ${(err as Error).message}`);
      }
    }
    if (task.openWhenDone) {
      try {
        const { shell } = await import('electron');
        const err = await shell.openPath(task.savePath);
        if (err) this.emit('log', `Could not open ${task.fileName}: ${err}`);
      } catch (err) {
        this.emit('log', `Could not open the file: ${(err as Error).message}`);
      }
    }
  }

  // ----------------------------------------------------------------- queues

  /** Number of running tasks belonging to a queue. */
  private runningInQueue(queueId: string | null): number {
    let count = 0;
    for (const [id] of this.running) {
      const t = this.tasks.get(id);
      if (t && (t.queueId ?? null) === queueId) count += 1;
    }
    return count;
  }

  /** Fill free slots in every queue from its queued tasks. */
  pump(): void {
    if (this.disposed || this.quotaPaused || this.pumpHalted) return;
    for (const queue of this.queues) {
      const queueId = queue.isPrimary ? null : queue.id;
      let free = queue.concurrency - this.runningInQueue(queueId);
      if (free <= 0) continue;
      const waiting = [...this.tasks.values()]
        .filter((t) => (t.queueId ?? null) === queueId && t.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const task of waiting) {
        if (free <= 0) break;
        if (this.start(task.id)) free -= 1;
      }
    }
  }

  startQueue(queueId: string | null): void {
    for (const t of this.tasks.values()) {
      if ((t.queueId ?? null) !== queueId) continue;
      // Resume what the queue stopped, and never resurrect what the user
      // stopped by hand (that distinction used to be lost entirely).
      if (t.status === 'stopped' && (!this.userStopped.has(t.id) || this.queueStopped.has(t.id))) {
        t.status = 'queued';
      }
    }
    this.queueStopped.clear();
    this.userStopped.clear();
    this.emit('changed');
    this.pump();
  }

  /**
   * Stop every task of a queue.
   *
   * Tasks that were waiting for a concurrency slot are only "held": they never
   * started, so they are parked in `stopped` while recording that the stop came
   * from the queue and not from the user. A task the user stopped on purpose
   * keeps `queueStopped = false`, which lets startQueue() tell the two apart.
   */
  stopQueue(queueId: string | null): void {
    // Same hazard as stopAll(): stop() pumps, and an abort triggered here can
    // free a slot for a task of *another* queue before this loop finishes.
    const wasHalted = this.pumpHalted;
    this.pumpHalted = true;
    try {
      for (const t of [...this.tasks.values()]) {
        if ((t.queueId ?? null) !== queueId) continue;
        if (t.status === 'queued') {
          // Never started: remember that this was a queue-level stop so a later
          // startQueue() can put it back without reviving user-stopped tasks.
          t.status = 'stopped';
          t.speed = 0;
          this.queueStopped.add(t.id);
        } else if (t.status === 'downloading' || t.status === 'connecting') {
          // Park it under the queue's authority, not the user's: stop() marks
          // the task user-stopped, which would block startQueue() from
          // resuming it.
          this.stopInternal(t.id);
          this.queueStopped.add(t.id);
        }
      }
    } finally {
      this.pumpHalted = wasHalted;
    }
    this.scheduleSave();
    this.emit('changed');
  }

  /**
   * The part of {@link stop} that changes state, without touching the user-stop
   * bookkeeping or pumping. Used by stopQueue(), which owns both decisions.
   */
  private stopInternal(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.finishRunning(id, 'stop');
    if (task.status !== 'completed') {
      task.status = 'stopped';
      task.speed = 0;
    }
  }

  addQueue(name: string, concurrency: number): Queue {
    const queue: Queue = {
      id: `q${Date.now().toString(36)}`,
      name,
      concurrency: clamp(concurrency, 1, 50),
      isPrimary: false,
    };
    this.queues.push(queue);
    this.scheduleSave();
    this.emit('changed');
    return queue;
  }

  updateQueue(id: string, patch: Partial<Queue>): void {
    const q = this.queues.find((x) => x.id === id);
    if (!q) return;
    if (patch.name !== undefined) q.name = patch.name;
    if (patch.concurrency !== undefined) q.concurrency = clamp(patch.concurrency, 1, 50);
    this.scheduleSave();
    this.emit('changed');
  }

  removeQueue(id: string): void {
    const q = this.queues.find((x) => x.id === id);
    if (!q || q.isPrimary) return;
    for (const t of this.tasks.values()) {
      if (t.queueId === id) t.queueId = null;
    }
    this.queues = this.queues.filter((x) => x.id !== id);
    this.scheduleSave();
    this.emit('changed');
  }

  moveToQueue(taskId: string, queueId: string | null): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.queueId = queueId;
    this.scheduleSave();
    this.emit('changed');
    this.pump();
  }

  // ------------------------------------------------------------- schedules

  setSchedules(entries: ScheduleEntry[]): void {
    this.schedules = entries;
    this.scheduleSave();
    this.emit('changed');
  }

  private lastScheduleRun = new Map<string, string>();
  /** When each interval schedule last fired, in epoch ms. */
  private lastIntervalRunAt = new Map<string, number>();

  /** Called once per minute to fire due schedule entries. */
  tickSchedules(): void {
    const now = new Date();
    for (const entry of this.schedules) {
      if (!entry.enabled) continue;
      const key = this.scheduleKey(entry, now);
      if (!key) continue;
      if (this.lastScheduleRun.get(entry.id) === key) continue;
      this.lastScheduleRun.set(entry.id, key);
      this.emit('log', `Schedule "${entry.id}" fired; starting its queue.`);
      this.startQueue(entry.queueId);
      if (entry.afterAction !== 'none') this.pendingAfterAction = { queueId: entry.queueId, action: entry.afterAction };
    }
  }

  private scheduleKey(entry: ScheduleEntry, now: Date): string | null {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const day = now.getDay();
    const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    switch (entry.mode) {
      case 'once': {
        if (entry.startAt === null) return null;
        const target = new Date(entry.startAt);
        const same = target.getFullYear() === now.getFullYear()
          && target.getMonth() === now.getMonth()
          && target.getDate() === now.getDate()
          && target.getHours() === now.getHours()
          && target.getMinutes() === now.getMinutes();
        return same ? stamp : null;
      }
      case 'daily':
        if (entry.timeOfDay === null) return null;
        return entry.timeOfDay === minutes ? stamp : null;
      case 'weekly':
        if (entry.timeOfDay === null) return null;
        if ((entry.weekdays & (1 << day)) === 0) return null;
        return entry.timeOfDay === minutes ? stamp : null;
      case 'interval': {
        if (!entry.intervalMinutes || entry.intervalMinutes <= 0) return null;
        // Deduplicate on elapsed time rather than on the wall clock: the old
        // "minutes % interval === 0" test both missed ticks (the 30 s timer
        // rarely lands exactly on the minute) and, because the dedup key was
        // the date alone, fired at most once per day.
        const nowMs = now.getTime();
        const last = this.lastIntervalRunAt.get(entry.id);
        const periodMs = entry.intervalMinutes * 60_000;
        if (last !== undefined && nowMs - last < periodMs) return null;
        this.lastIntervalRunAt.set(entry.id, nowMs);
        return `${stamp}#${Math.floor(nowMs / periodMs)}`;
      }
      default:
        return null;
    }
  }

  private pendingAfterAction: { queueId: string | null; action: ScheduleEntry['afterAction'] } | null = null;

  private maybeRunAfterQueueAction(): void {
    const pending = this.pendingAfterAction;
    if (!pending) return;
    const stillActive = [...this.tasks.values()].some(
      (t) =>
        (t.queueId ?? null) === pending.queueId
        && (t.status === 'downloading' || t.status === 'connecting' || t.status === 'queued'),
    );
    if (stillActive) return;
    this.pendingAfterAction = null;
    this.emit('afterQueueAction', pending.action);
  }

  // ----------------------------------------------------------------- quota

  /** Enforce the rolling download quota (spec §2.3). */
  private checkQuota(): void {
    const q = this.settings.quota;
    if (!q.enabled || q.megabytes <= 0) return;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const inWindow = q.startMinute <= q.endMinute
      ? minutes >= q.startMinute && minutes <= q.endMinute
      : minutes >= q.startMinute || minutes <= q.endMinute;
    if (!inWindow) return;
    if (this.quotaUsedToday >= q.megabytes) {
      this.pauseAllForQuota();
    }
  }

  private pauseAllForQuota(): void {
    if (this.quotaPaused) return;
    this.quotaPaused = true;
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'downloading' || t.status === 'connecting') {
        // Remember who was paused *by the quota*: clearing the latch has to
        // resume exactly these tasks, because pump() only ever starts tasks in
        // the `queued` state and a paused task would otherwise stay stuck.
        this.quotaPausedIds.add(t.id);
        this.pause(t.id);
      }
    }
    this.emit(
      'quotaExceeded',
      `The download quota of ${this.settings.quota.megabytes} MB for the scheduled period has been reached. ` +
        'All transfers are paused and will resume in the next period.',
    );
  }

  /** Put tasks that the quota paused back into the queue. */
  private resumeFromQuota(): void {
    const ids = [...this.quotaPausedIds];
    this.quotaPausedIds.clear();
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (!task) continue;
      if (task.status === 'paused' || task.status === 'stopped') {
        task.status = 'queued';
        task.speed = 0;
      }
    }
    if (ids.length > 0) {
      this.emit('changed');
      this.scheduleSave();
    }
    this.pump();
  }

  /** Re-evaluate the quota window; a new day or period clears the pause. */
  private resetQuotaIfNeeded(): void {
    const q = this.settings.quota;

    // Turning the quota off (or raising the allowance above what was used)
    // must release the latch immediately. It used to stay set forever, so the
    // only way out was restarting the app.
    if (!q.enabled || q.megabytes <= 0 || this.quotaUsedToday < q.megabytes) {
      if (this.quotaPaused) {
        this.quotaPaused = false;
        this.emit('log', 'The download quota is no longer exceeded; resuming.');
        this.resumeFromQuota();
      }
    }

    const key = this.currentQuotaKey();
    if (key !== this.quotaWindowKey) {
      this.quotaWindowKey = key;
      this.quotaUsedToday = 0;
      this.quotaPaused = false;
      this.scheduleSave();
      this.resumeFromQuota();
      return;
    }
    if (this.quotaPaused && q.enabled && q.megabytes > 0) {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const inWindow = q.startMinute <= q.endMinute
        ? minutes >= q.startMinute && minutes <= q.endMinute
        : minutes >= q.startMinute || minutes <= q.endMinute;
      // Outside the window the transfer is allowed again, and the next window
      // gives the user a fresh allowance for the day.
      if (!inWindow) {
        this.quotaUsedToday = 0;
        this.quotaPaused = false;
        this.resumeFromQuota();
      }
    }
  }

  // ------------------------------------------------------------- utilities

  applySettings(next: AppSettings): void {
    this.settings = next;
    this.scheduleSave();
    this.emit('changed');
  }

  // ------------------------------------------------------------ grabber io

  async saveGrabberProjects(projects: GrabberProject[], file: string): Promise<void> {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ version: 1, projects }, null, 2), 'utf8');
  }

  async loadGrabberProjects(file: string): Promise<GrabberProject[]> {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const data = JSON.parse(raw) as { version?: number; projects?: GrabberProject[] };
      if (data.version !== 1 || !Array.isArray(data.projects)) {
        throw new Error('The grabber project file is corrupt or from an incompatible version.');
      }
      return data.projects;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  startBackgroundWork(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => this.tickSchedules(), 30_000);
    this.quotaTimer = setInterval(() => this.resetQuotaIfNeeded(), 60_000);
    this.pump();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    // Pending sidecar writes would otherwise keep the process alive and touch
    // files after the manager is gone.
    for (const timer of this.sidecarTimers.values()) clearTimeout(timer);
    this.sidecarTimers.clear();
    for (const id of [...this.running.keys()]) this.finishRunning(id);
    await this.saveNow();
  }

  /** Status helper used by the UI batch actions. */
  setStatusBatch(ids: string[], status: TaskStatus): void {
    for (const id of ids) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (status === 'queued' || status === 'stopped') {
        t.status = status;
        t.speed = 0;
      }
    }
    this.emit('changed');
    this.pump();
  }
}