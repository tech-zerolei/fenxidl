/**
 * Shared type contracts between the main process and the renderer.
 *
 * The status names mirror the observed status machine of the original product
 * (see docs/FEATURE-SPEC.md §1.4): added -> connecting -> downloading ->
 * completed, with paused / stopped / error branches.
 */

export type TaskStatus =
  | 'queued'
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'error';

export type CategoryId = 'completed' | 'programs' | 'music' | 'video' | 'games' | 'documents' | 'archives' | 'other';

/** A contiguous byte range owned by one connection. */
export interface Segment {
  index: number;
  start: number;
  /** Inclusive end offset. */
  end: number;
  /** Bytes already persisted for this segment. */
  downloaded: number;
}

export interface TaskError {
  code: string;
  message: string;
  /** Whether the engine should keep retrying automatically. */
  retryable: boolean;
  at: number;
}

export interface DownloadTask {
  id: string;
  url: string;
  fileName: string;
  savePath: string;
  /** Final directory; kept separate so categories can re-resolve the folder. */
  directory: string;
  categoryId: CategoryId;
  description: string;
  status: TaskStatus;
  totalBytes: number;
  downloadedBytes: number;
  /** Bytes/second, smoothed by the engine. */
  speed: number;
  /** Seconds remaining, NaN when unknown. */
  eta: number;
  supportsResume: boolean;
  segments: Segment[];
  connections: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Queue membership; `null` means the primary (default) queue. */
  queueId: string | null;
  /** Optional per-task credentials overriding the site credential store. */
  username: string | null;
  password: string | null;
  referer: string | null;
  userAgent: string | null;
  /** Extra request headers parsed from the new-task dialog. */
  headers: Record<string, string>;
  error: TaskError | null;
  /** Set when a range request proved the server ignored Range. */
  restartedFromZero: boolean;
  /** Verification info captured on completion. */
  etag: string | null;
  lastModified: string | null;
  mimeType: string | null;
  /** Post-completion actions chosen for this task. */
  openWhenDone: boolean;
}

export interface Queue {
  id: string;
  name: string;
  /** Max simultaneous running tasks. */
  concurrency: number;
  isPrimary: boolean;
}

export type AfterQueueAction = 'none' | 'exit' | 'shutdown' | 'sleep' | 'hibernate' | 'hangup';

export interface ScheduleEntry {
  id: string;
  /** Target queue id, or null for the primary queue. */
  queueId: string | null;
  enabled: boolean;
  /** `once` uses `startAt`; `daily`/`weekly` use time-of-day plus weekday mask. */
  mode: 'once' | 'daily' | 'weekly' | 'interval';
  startAt: number | null;
  /** Minutes after midnight for recurring modes. */
  timeOfDay: number | null;
  /** Bitmask, bit 0 = Sunday. */
  weekdays: number;
  intervalMinutes: number | null;
  afterAction: AfterQueueAction;
}

export interface ProxySettings {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface SiteCredential {
  id: string;
  /** Host or host/path prefix. */
  site: string;
  username: string;
  password: string;
}

export interface QuotaSettings {
  enabled: boolean;
  /** Quota window start/end in minutes after midnight. */
  startMinute: number;
  endMinute: number;
  /** Megabyte allowance inside the window. */
  megabytes: number;
}

export interface CategoryRule {
  id: CategoryId;
  name: string;
  directory: string;
  /** Lowercase extensions without dots. */
  extensions: string[];
  rememberLastPath: boolean;
}

export interface VirusScanSettings {
  enabled: boolean;
  program: string;
  args: string;
}

export interface AppSettings {
  // General
  launchAtStartup: boolean;
  monitorClipboard: boolean;
  browserIntegration: boolean;
  autoStartExtensions: string[];
  showMediaBar: boolean;
  language: string;
  showTipsOnStartup: boolean;

  // Connection
  defaultConnections: number;
  serverConnectionOverrides: Record<string, number>;
  connectionTypeId: string;
  quota: QuotaSettings;

  // Downloads
  defaultDirectory: string;
  tempDirectory: string;
  useLastPathForGeneral: boolean;
  showStartDialog: boolean;
  showProgressDialog: boolean;
  showCompleteDialog: boolean;
  virusScan: VirusScanSettings;
  categories: CategoryRule[];

  // Proxy
  httpProxy: ProxySettings;
  httpsProxy: ProxySettings;
  ftpProxy: ProxySettings;
  ftpPassive: boolean;

  // Passwords
  credentials: SiteCredential[];

  // Dial-up
  useDialup: boolean;
  redialAttempts: number;
  redialIntervalSeconds: number;

  // Behaviour
  defaultQueueConcurrency: number;
  maxRetries: number;
  retryDelaySeconds: number;
  /** Global speed cap in bytes/second; 0 = unlimited. */
  globalSpeedLimit: number;
}

export interface TaskCreateInput {
  url: string;
  fileName?: string;
  directory?: string;
  categoryId?: CategoryId;
  description?: string;
  connections?: number;
  username?: string | null;
  password?: string | null;
  referer?: string | null;
  headers?: Record<string, string>;
  queueId?: string | null;
  /** When true the task is created in `queued` state and not started. */
  addToQueueOnly?: boolean;
  /** Open the file with its default application on completion. */
  openWhenDone?: boolean;
}

export interface ProgressSnapshot {
  tasks: DownloadTask[];
  queues: Queue[];
  schedules: ScheduleEntry[];
  settings: AppSettings;
  stats: {
    activeCount: number;
    totalSpeed: number;
    quotaUsedToday: number;
  };
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Grabber (site crawler) types. */
export interface GrabberFilter {
  id: string;
  name: string;
  kind: 'include' | 'exclude';
  /** Extensions or path fragments; semicolon separated in the UI. */
  patterns: string[];
}

export interface GrabberProject {
  id: string;
  name: string;
  startUrl: string;
  saveDirectory: string;
  onlyThisSite: boolean;
  wholeSite: boolean;
  maxDepth: number;
  otherSiteDepth: number;
  excludeParentDirs: boolean;
  includeTypes: string[];
  excludeTypes: string[];
  includePaths: string[];
  excludePaths: string[];
  minBytes: number;
  maxBytes: number;
  concurrentExplore: number;
  concurrentDownload: number;
  addToQueueOnClose: boolean;
  useLinkTextAsDescription: boolean;
  useRelativePaths: boolean;
  convertLinksForOffline: boolean;
  overwriteExisting: boolean;
  downloadAllMatches: boolean;
  filters: GrabberFilter[];
  createdAt: number;
}

export interface GrabberStats {
  status: 'idle' | 'exploring' | 'downloading' | 'completed' | 'stopped';
  pagesProcessed: number;
  filesFound: number;
  filesMatched: number;
  filesDownloaded: number;
}