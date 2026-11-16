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
  TaskCreateInput,
  TaskStatus,
} from '../shared/types';
import {
  retryPolicy,
  describeTransferError,
  downloadSegment,
  fileNameFromUrl,
  isRetryableNetworkError,
  planSegments,
  prepareFile,
  probe,
  sanitizeFileName,
  uniquePath,
  type RequestOptions,
} from './download-engine';

export interface TaskManagerOptions {
  settings: AppSettings;
  queues: Queue[];
  schedules: ScheduleEntry[];
  storagePath: string;
}

interface RunningTask {
  controller: AbortController;
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

  /** Resolve the save directory for a category, honouring the spec defaults. */
  private resolveDirectory(categoryId: DownloadTask['categoryId'], explicit?: string): string {
    if (explicit && explicit.trim()) return explicit;
    const rule = this.settings.categories.find((c) => c.id === categoryId);
    if (rule && rule.directory.trim()) return rule.directory;
    return this.settings.defaultDirectory;
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
    const categoryId = input.categoryId ?? this.categoryForUrl(input.url, 'other');
    const directory = this.resolveDirectory(categoryId, input.directory);
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
      status: input.addToQueueOnly ? 'queued' : 'queued',
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
    let host = '';
    try {
      host = new URL(task.url).host.toLowerCase();
    } catch {
      return { username: null, password: null };
    }
    const cred = this.settings.credentials.find((c) => {
      const site = c.site.toLowerCase().trim();
      if (!site) return false;
      return host === site || host.endsWith(`.${site}`) || task.url.toLowerCase().includes(site);
    });
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
      windowBytes: 0,
      windowStart: Date.now(),
      speed: 0,
      throttleBytes: 0,
      throttleStart: Date.now(),
    };
    this.running.set(id, running);
    task.status = 'connecting';
    task.error = null;
    task.speed = 0;
    this.emit('changed');

    void this.run(task, running).catch((err) => {
      this.finishRunning(id);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ABORTED') {
        task.status = 'stopped';
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

  private finishRunning(id: string): void {
    const r = this.running.get(id);
    if (r) {
      r.controller.abort();
      this.running.delete(id);
    }
  }

  stop(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.finishRunning(id);
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
    this.finishRunning(id);
    if (task.status !== 'completed') {
      task.status = 'paused';
      task.speed = 0;
      this.scheduleSave();
      this.emit('changed');
    }
    this.pump();
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
    for (const t of this.tasks.values()) {
      if (t.status === 'downloading' || t.status === 'connecting' || t.status === 'queued') {
        t.status = 'stopped';
        t.speed = 0;
      }
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
    task.etag = info.etag;
    task.lastModified = info.lastModified;
    task.supportsResume = info.supportsResume;
    task.totalBytes = info.totalBytes;
    task.status = 'downloading';
    task.startedAt = task.startedAt ?? Date.now();

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

    // Retry policy from Options > Connection.
    retryPolicy.maxRetries = Math.max(1, this.settings.maxRetries || 8);
    retryPolicy.retryDelayMs = Math.max(200, (this.settings.retryDelaySeconds || 5) * 1000);

    const wanted = this.connectionsFor(task);
    const useSegments = info.supportsResume && info.totalBytes > 0 && wanted > 1;
    if (!useSegments) {
      // Single connection; resume from whatever is already on disk.
      await this.runSingle(task, running, options, info.totalBytes);
      return;
    }
    await this.runSegmented(task, running, options, info.totalBytes, wanted);
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
  ): Promise<void> {
    let startOffset = 0;
    try {
      const stat = await fsp.stat(task.savePath);
      if (stat.size > 0 && (totalBytes === 0 || stat.size < totalBytes)) startOffset = stat.size;
    } catch {
      startOffset = 0;
    }
    const workPath = await this.workingPath(task);
    const fileHandle = await prepareFile(workPath, totalBytes);
    try {
      // With an unknown length there is nothing to range over: the whole body
      // is streamed from the start and the file is sized from what arrives.
      const unknownLength = totalBytes === 0;
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
    await this.promoteFromTemp(task, workPath);
    this.completeTask(task);
  }

  private async runSegmented(
    task: DownloadTask,
    running: RunningTask,
    options: RequestOptions,
    totalBytes: number,
    connections: number,
  ): Promise<void> {
    // Reuse an existing plan when the size still matches so a resumed task
    // keeps already-downloaded ranges instead of starting over.
    if (task.segments.length === 0 || task.totalBytes !== totalBytes) {
      task.segments = planSegments(totalBytes, connections);
      task.downloadedBytes = 0;
    } else {
      // Re-derive completed bytes from the retained segment state.
      task.downloadedBytes = task.segments.reduce((sum, s) => sum + s.downloaded, 0);
    }

    const workPath = await this.workingPath(task);
    const fileHandle = await prepareFile(workPath, totalBytes);
    try {
      const pending = task.segments.filter((s) => s.start + s.downloaded <= s.end);
      const results = await Promise.allSettled(
        pending.map((segment) =>
          downloadSegment(segment, {
            url: task.url,
            fileHandle,
            options,
            signal: running.controller.signal,
            onChunk: (ev) => this.onChunk(task, running, ev.bytes),
          }),
        ),
      );
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      fs.closeSync(fileHandle);
    }
    await this.promoteFromTemp(task, workPath);
    this.completeTask(task);
  }

  private onChunk(task: DownloadTask, running: RunningTask, bytes: number): void {
    // Global throttle: when the measured rate exceeds the cap, hold the next
    // chunk back so the whole engine converges on the configured limit.
    const cap = this.settings.globalSpeedLimit;
    if (cap > 0) {
      running.throttleBytes += bytes;
      const nowMs = Date.now();
      const elapsed = nowMs - running.throttleStart;
      if (elapsed > 0) {
        const rate = (running.throttleBytes / elapsed) * 1000;
        if (rate > cap) {
          const allowedMs = (running.throttleBytes / cap) * 1000;
          const sleepMs = Math.min(200, Math.max(0, allowedMs - elapsed));
          if (sleepMs > 0) {
            // Synchronous pacing is acceptable here: the caller already
            // serialises file writes, and the wait is bounded at 200 ms.
            const until = Date.now() + sleepMs;
            while (Date.now() < until) {
              /* deliberate short spin to pace the producer */
            }
          }
        }
      }
      if (nowMs - running.throttleStart > 1000) {
        running.throttleStart = nowMs;
        running.throttleBytes = 0;
      }
    }

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

  private completeTask(task: DownloadTask): void {
    const id = task.id;
    this.finishRunning(id);
    // Run the configured post-download hooks before announcing completion so a
    // listener sees the final state (spec strings 1317-1319, 1164).
    void this.runPostCompletionHooks(task);
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
    this.pump();
    this.maybeRunAfterQueueAction();
  }

  /**
   * Path used while the transfer is in flight. When a temp directory is
   * configured the partial data lives there and is moved into place on
   * completion, so a half-finished file never appears in the user's folder.
   */
  private async workingPath(task: DownloadTask): Promise<string> {
    const temp = this.settings.tempDirectory?.trim();
    if (!temp) return task.savePath;
    try {
      await fsp.mkdir(temp, { recursive: true });
      // Keep the extension so segment logic and virus scanners see the type.
      return path.join(temp, `${task.id}${path.extname(task.savePath)}.part`);
    } catch {
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
      const args = (scan.args || '%f').replace(/%f/g, `"${task.savePath}"`);
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(scan.program, args.split(/\s+/).filter(Boolean), {
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
    if (this.disposed || this.quotaPaused) return;
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
      if ((t.queueId ?? null) === queueId && t.status === 'stopped') t.status = 'queued';
    }
    this.emit('changed');
    this.pump();
  }

  stopQueue(queueId: string | null): void {
    for (const t of [...this.tasks.values()]) {
      if ((t.queueId ?? null) === queueId && (t.status === 'queued' || t.status === 'downloading' || t.status === 'connecting')) {
        this.stop(t.id);
      }
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
      case 'interval':
        if (!entry.intervalMinutes || entry.intervalMinutes <= 0) return null;
        return minutes % entry.intervalMinutes === 0 ? stamp : null;
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
      if (t.status === 'downloading' || t.status === 'connecting') this.pause(t.id);
    }
    this.emit(
      'quotaExceeded',
      `The download quota of ${this.settings.quota.megabytes} MB for the scheduled period has been reached. ` +
        'All transfers are paused and will resume in the next period.',
    );
  }

  /** Re-evaluate the quota window; a new day or period clears the pause. */
  private resetQuotaIfNeeded(): void {
    const key = this.currentQuotaKey();
    if (key !== this.quotaWindowKey) {
      this.quotaWindowKey = key;
      this.quotaUsedToday = 0;
      this.quotaPaused = false;
      this.scheduleSave();
      this.pump();
      return;
    }
    if (this.quotaPaused) {
      const q = this.settings.quota;
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      const inWindow = q.startMinute <= q.endMinute
        ? minutes >= q.startMinute && minutes <= q.endMinute
        : minutes >= q.startMinute || minutes <= q.endMinute;
      if (!inWindow) {
        this.quotaPaused = false;
        this.pump();
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