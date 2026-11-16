/**
 * HTTP range probing and segmented download engine.
 *
 * Behaviour derived from the reverse-engineered spec (docs/FEATURE-SPEC.md):
 *  - multiple connections per file, with a per-server override (§2.1)
 *  - resume support detection, degrading to a single connection when the
 *    server ignores Range (§2.1, string 20786)
 *  - per-segment progress reporting for the details panel (§3, string 1305)
 *  - friendly mapping of transfer failures (§2.6)
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { Segment } from '../shared/types';

export interface ProbeResult {
  ok: boolean;
  finalUrl: string;
  totalBytes: number;
  supportsResume: boolean;
  /** Server-reported file name from Content-Disposition, if any. */
  fileName: string | null;
  mimeType: string | null;
  etag: string | null;
  lastModified: string | null;
  /** Status code observed on the probe response. */
  statusCode: number;
  error: string | null;
  requiresAuth: boolean;
}

export interface ProxyConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RequestOptions {
  username?: string | null;
  password?: string | null;
  referer?: string | null;
  userAgent?: string | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Proxy used for plain http requests. */
  httpProxy?: ProxyConfig | null;
  /** Proxy used for https requests. */
  httpsProxy?: ProxyConfig | null;
}

/**
 * Resolve the proxy for a URL. An https target uses the HTTPS proxy when it is
 * enabled, otherwise the HTTP proxy (matching the layered behaviour users
 * expect from the options dialog).
 */
export function proxyForUrl(rawUrl: string, options: RequestOptions): ProxyConfig | null {
  let scheme = '';
  try {
    scheme = new URL(rawUrl).protocol;
  } catch {
    return null;
  }
  const https = options.httpsProxy;
  const http = options.httpProxy;
  const usable = (p: ProxyConfig | null | undefined): p is ProxyConfig =>
    !!p && p.enabled && !!p.host.trim() && p.port > 0;
  if (scheme === 'https:') {
    if (usable(https)) return https;
    if (usable(http)) return http;
    return null;
  }
  return usable(http) ? http : null;
}

/** Proxy-Authorization header value, or null when no credentials are set. */
export function proxyAuthHeader(proxy: ProxyConfig): Record<string, string> {
  if (!proxy.username) return {};
  const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
  return { 'Proxy-Authorization': `Basic ${token}` };
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Retry policy shared with the task manager. The task manager sets these from
 * the user's Options > Connection values before starting a transfer.
 */
export const retryPolicy = {
  maxRetries: 8,
  retryDelayMs: 5000,
};

/** Transient network errors that justify an automatic retry. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED',
]);

export function isRetryableNetworkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

/** Human-readable English text for a transfer failure. */
export function describeTransferError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  const code = e?.code ?? '';
  switch (code) {
    case 'ENOSPC':
      return 'There is not enough free disk space to continue this download.';
    case 'EACCES':
    case 'EPERM':
      return 'The destination file or folder is not writable. Choose another save location.';
    case 'ENOENT':
      return 'The destination folder no longer exists.';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'The connection was reset by the server. The download will resume automatically.';
    case 'ETIMEDOUT':
      return 'The connection timed out. Check your network and the proxy settings.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'The server host name could not be resolved.';
    case 'ECONNREFUSED':
      return 'The server refused the connection.';
    default:
      return e?.message ? e.message : 'The download failed for an unknown reason.';
  }
}

function buildHeaders(options: RequestOptions, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Connection: 'keep-alive',
  };
  if (options.referer) headers.Referer = options.referer;
  if (options.username !== null && options.username !== undefined) {
    const token = Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return { ...headers, ...(options.headers ?? {}), ...(extra ?? {}) };
}

function parseContentDisposition(value: string | undefined): string | null {
  if (!value) return null;
  // RFC 6266 / 5987: filename* takes precedence over plain filename.
  const star = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (star) {
    const raw = star[1].trim().replace(/^["']|["']$/g, '');
    const parts = raw.split("''");
    const encoded = parts.length === 2 ? parts[1] : raw;
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(value);
  if (plain) {
    const v = (plain[2] ?? plain[1]).trim();
    // Browsers send latin1 here; recover UTF-8 when the bytes look like it.
    try {
      const buf = Buffer.from(v, 'latin1');
      const decoded = buf.toString('utf8');
      if (!decoded.includes('\uFFFD')) return decoded;
    } catch {
      /* ignore */
    }
    return v;
  }
  return null;
}

/** Derive a safe file name from a URL path, honouring percent-encoding. */
export function fileNameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return 'download';
    const decoded = decodeURIComponent(last);
    return sanitizeFileName(decoded) || 'download';
  } catch {
    return 'download';
  }
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Strip characters that are illegal on Windows and trim trailing dots. */
export function sanitizeFileName(name: string): string {
  let out = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  out = out.replace(/[. ]+$/, '');
  if (!out) return 'download';
  const base = out.split('.')[0].toLowerCase();
  if (RESERVED_WINDOWS_NAMES.has(base)) out = `_${out}`;
  // Keep well inside the 255-byte component limit.
  if (Buffer.byteLength(out, 'utf8') > 200) {
    const ext = path.extname(out);
    const stem = out.slice(0, out.length - ext.length);
    out = Buffer.from(stem, 'utf8').subarray(0, 180).toString('utf8') + ext;
  }
  return out;
}

/**
 * Pick a non-colliding path in `directory`. `exclude` lists paths already
 * claimed by other tasks so two tasks never target the same file.
 */
export function uniquePath(directory: string, fileName: string, exclude: Set<string> = new Set()): string {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(directory, fileName);
  let counter = 1;
  while (exclude.has(candidate) || fs.existsSync(candidate)) {
    candidate = path.join(directory, `${stem} (${counter})${ext}`);
    counter += 1;
    if (counter > 9999) break;
  }
  return candidate;
}

function requestUrl(rawUrl: string, options: RequestOptions, method: 'GET' | 'HEAD', headers: Record<string, string>) {
  const url = new URL(rawUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const timeout = options.timeoutMs ?? 30_000;
  return { url, transport, timeout, method, headers };
}

/** Perform one HTTP request and resolve with the raw response. */
function rawRequest(
  rawUrl: string,
  options: RequestOptions,
  method: 'GET' | 'HEAD',
  extraHeaders: Record<string, string> = {},
): Promise<http.IncomingMessage> {
  const proxy = proxyForUrl(rawUrl, options);

  return new Promise((resolve, reject) => {
    const { url, timeout, headers } = requestUrl(rawUrl, options, method, buildHeaders(options, extraHeaders));

    const settle = (req: http.ClientRequest): void => {
      req.setTimeout(timeout, () => {
        req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
      });
      req.on('error', reject);
      req.end();
    };

    if (proxy && url.protocol === 'https:') {
      // HTTPS over a proxy needs a CONNECT tunnel, then TLS inside it.
      const connectHeaders: Record<string, string> = {
        Host: `${url.hostname}:${url.port || 443}`,
        ...proxyAuthHeader(proxy),
      };
      const connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${url.hostname}:${url.port || 443}`,
        headers: connectHeaders,
        timeout,
      });
      connectReq.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(Object.assign(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`), { code: 'EPROXY' }));
          return;
        }
        const tunneled = https.request(
          {
            host: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers,
            createConnection: () => socket as never,
            servername: url.hostname,
          },
          (r) => resolve(r),
        );
        settle(tunneled);
      });
      connectReq.on('timeout', () => {
        connectReq.destroy(Object.assign(new Error('Proxy connection timed out'), { code: 'ETIMEDOUT' }));
      });
      connectReq.on('error', (err) =>
        reject(Object.assign(err as Error, { code: (err as NodeJS.ErrnoException).code ?? 'EPROXY' })),
      );
      connectReq.end();
      return;
    }

    if (proxy) {
      // Plain HTTP through a proxy uses the absolute-form request target.
      const req = http.request(
        {
          host: proxy.host,
          port: proxy.port,
          method,
          // Absolute URI form is required by RFC 7230 for proxied requests.
          path: url.toString(),
          headers: { ...headers, Host: url.host, ...proxyAuthHeader(proxy) },
        },
        (r) => resolve(r),
      );
      settle(req);
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (r) => resolve(r),
    );
    settle(req);
  });
}

/**
 * Follow redirects manually so credentials and headers survive cross-host
 * redirects only when they were explicitly configured.
 */
async function requestFollowing(
  rawUrl: string,
  options: RequestOptions,
  method: 'GET' | 'HEAD',
  extraHeaders: Record<string, string> = {},
  maxRedirects = 10,
): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await rawRequest(current, options, method, extraHeaders);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume(); // drain
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error(`Too many redirects while requesting ${rawUrl}`);
}

/**
 * Probe a URL for size and resume support.
 *
 * A `GET` with `Range: bytes=0-0` is used rather than `HEAD` because some
 * servers answer `HEAD` without `Content-Length` or without range headers.
 */
export async function probe(url: string, options: RequestOptions = {}): Promise<ProbeResult> {
  const base: ProbeResult = {
    ok: false,
    finalUrl: url,
    totalBytes: 0,
    supportsResume: false,
    fileName: null,
    mimeType: null,
    etag: null,
    lastModified: null,
    statusCode: 0,
    error: null,
    requiresAuth: false,
  };

  if (!/^https?:/i.test(url)) {
    return { ...base, error: 'Only http and https URLs are supported by this engine.' };
  }

  let res: http.IncomingMessage;
  let finalUrl: string;
  try {
    const r = await requestFollowing(url, options, 'GET', { Range: 'bytes=0-0' });
    res = r.res;
    finalUrl = r.finalUrl;
  } catch (err) {
    return { ...base, error: describeTransferError(err) };
  }

  const status = res.statusCode ?? 0;
  const headers = res.headers;

  if (status === 401 || status === 407) {
    res.resume();
    return {
      ...base,
      finalUrl,
      statusCode: status,
      requiresAuth: true,
      error: status === 401 ? 'The server requires a user name and password.' : 'The proxy requires authentication.',
    };
  }
  if (status >= 400) {
    res.resume();
    return { ...base, finalUrl, statusCode: status, error: `The server responded with HTTP ${status}.` };
  }

  // A 206 answer proves range support; a 200 answer to a range request means
  // the server (or a proxy) ignored Range and will always send the whole body.
  const contentRange = headers['content-range'];
  let total = 0;
  let supportsResume = false;
  if (status === 206 && typeof contentRange === 'string') {
    const m = /\/(\d+)\s*$/.exec(contentRange);
    if (m) {
      total = Number(m[1]);
      supportsResume = Number.isFinite(total) && total > 0;
    }
  }
  if (!total) {
    const len = headers['content-length'];
    const parsed = typeof len === 'string' ? Number(len) : 0;
    // With status 200 the length is the complete body.
    total = Number.isFinite(parsed) ? parsed : 0;
  }
  if (status === 200) supportsResume = false;

  res.destroy(); // we only needed the headers

  const fileName =
    parseContentDisposition(headers['content-disposition'] as string | undefined) ?? fileNameFromUrl(finalUrl);
  const mime = typeof headers['content-type'] === 'string' ? headers['content-type'].split(';')[0].trim() : null;

  return {
    ok: true,
    finalUrl,
    totalBytes: total,
    supportsResume,
    fileName,
    mimeType: mime,
    etag: typeof headers.etag === 'string' ? headers.etag : null,
    lastModified: typeof headers['last-modified'] === 'string' ? headers['last-modified'] : null,
    statusCode: status,
    error: null,
    requiresAuth: false,
  };
}

/** Split a known length into `count` contiguous segments. */
export function planSegments(totalBytes: number, count: number, minChunk = 256 * 1024): Segment[] {
  if (totalBytes <= 0) return [];
  let n = Math.max(1, Math.floor(count));
  // Never create segments smaller than minChunk; fewer connections is faster.
  const maxUseful = Math.max(1, Math.floor(totalBytes / minChunk));
  n = Math.min(n, maxUseful);
  const per = Math.floor(totalBytes / n);
  const segments: Segment[] = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * per;
    const end = i === n - 1 ? totalBytes - 1 : start + per - 1;
    segments.push({ index: i, start, end, downloaded: 0 });
  }
  return segments;
}

export interface SegmentWriteEvent {
  /** Bytes written in this chunk. */
  bytes: number;
  /** Absolute offset of the written chunk. */
  offset: number;
  segmentIndex: number;
  /** Bytes downloaded so far within the segment. */
  segmentDownloaded: number;
}

export interface DownloadController {
  promise: Promise<void>;
  cancel: () => void;
}

export interface SegmentContext {
  url: string;
  fileHandle: number;
  options: RequestOptions;
  signal: AbortSignal;
  onChunk: (event: SegmentWriteEvent) => void;
  /**
   * When true no Range header is sent and the whole body is streamed from
   * offset 0. Used for servers without range support and for unknown lengths.
   */
  streamWhole?: boolean;
  timeoutMs?: number;
}

/**
 * Download one contiguous range into an already-open file at the right offset.
 * Retries transient failures with backoff, resuming from the segment's own
 * progress rather than restarting the range.
 */
export async function downloadSegment(segment: Segment, ctx: SegmentContext): Promise<void> {
  const { url, fileHandle, options, signal } = ctx;
  const streamWhole = ctx.streamWhole === true;
  let attempt = 0;
  let offset = streamWhole ? 0 : segment.start + segment.downloaded;
  const end = streamWhole ? Number.POSITIVE_INFINITY : segment.end;
  // A bounded end lets the reader stop early if a server over-sends.
  const boundedEnd = Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER;

  while (offset <= end) {
    if (signal.aborted) throw Object.assign(new Error('Download cancelled'), { code: 'ABORTED' });
    try {
      const rangeHeaders: Record<string, string> = streamWhole
        ? {}
        : { Range: `bytes=${offset}-${boundedEnd}` };
      const res = await requestFollowing(url, options, 'GET', rangeHeaders);
      const status = res.res.statusCode ?? 0;
      if (streamWhole ? status !== 200 : status !== 206 && status !== 200) {
        res.res.resume();
        throw Object.assign(new Error(`Unexpected HTTP ${status} for the download request`), { code: 'EBADSTATUS' });
      }
      // A 200 answer to a range request means the server ignored Range; the
      // caller restarts in single-connection mode, so surface a distinct code.
      if (!streamWhole && status === 200 && offset !== 0) {
        res.res.destroy();
        throw Object.assign(new Error('Server ignored the Range request'), { code: 'ENORANGE' });
      }

      await new Promise<void>((resolve, reject) => {
        const stream = res.res;
        const onAbort = () => {
          stream.destroy();
          reject(Object.assign(new Error('Download cancelled'), { code: 'ABORTED' }));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        stream.on('data', (chunk: Buffer) => {
          if (signal.aborted) return;
          // Guard against servers that over-send past the requested range.
          const allowed = streamWhole ? chunk.length : Math.min(chunk.length, boundedEnd - offset + 1);
          if (allowed <= 0) return;
          const slice = allowed === chunk.length ? chunk : chunk.subarray(0, allowed);
          try {
            fs.writeSync(fileHandle, slice, 0, slice.length, offset);
          } catch (err) {
            stream.destroy();
            reject(err);
            return;
          }
          offset += slice.length;
          segment.downloaded += slice.length;
          ctx.onChunk({
            bytes: slice.length,
            offset: offset - slice.length,
            segmentIndex: segment.index,
            segmentDownloaded: segment.downloaded,
          });
          if (!streamWhole && offset > boundedEnd) stream.destroy();
        });
        stream.on('end', () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
        stream.on('error', (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      });
      if (!streamWhole && offset > boundedEnd) return;
      if (streamWhole) return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ABORTED' || code === 'ENORANGE' || signal.aborted) throw err;
      attempt += 1;
      if (!isRetryableNetworkError(err) && code !== 'EBADSTATUS') throw err;
      if (attempt > retryPolicy.maxRetries) throw err;
      const backoff = Math.min(
        Math.max(250, retryPolicy.retryDelayMs) * 2 ** (attempt - 1),
        60_000,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/** Ensure the target file exists at the expected size without clobbering data. */
export async function prepareFile(filePath: string, totalBytes: number): Promise<number> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  let handle: number;
  try {
    handle = fs.openSync(filePath, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      handle = fs.openSync(filePath, 'w+');
    } else {
      throw err;
    }
  }
  if (totalBytes > 0) {
    const stat = fs.fstatSync(handle);
    if (stat.size !== totalBytes) {
      // Preallocate so segment writes never extend the file concurrently.
      fs.ftruncateSync(handle, totalBytes);
    }
  }
  return handle;
}