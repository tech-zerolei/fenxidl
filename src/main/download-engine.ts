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
  // Keep well inside the 255-byte component limit. The extension has to be
  // counted against the budget: truncating the stem alone still overflowed
  // (a 381-byte name was produced for a 452-byte input, and the write failed
  // with ENAMETOOLONG).
  const LIMIT = 200;
  if (Buffer.byteLength(out, 'utf8') > LIMIT) {
    const ext = path.extname(out);
    const extBytes = Buffer.byteLength(ext, 'utf8');
    // Only keep an extension that is itself a reasonable size; a pathological
    // "extension" would otherwise eat the whole budget.
    const keepExt = extBytes > 0 && extBytes <= 32;
    const budget = Math.max(1, LIMIT - (keepExt ? extBytes : 0));
    const stem = keepExt ? out.slice(0, out.length - ext.length) : out;
    out = truncateToBytes(stem, budget) + (keepExt ? ext : '');
  }
  return out;
}

/**
 * Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`.
 *
 * Truncating the encoded buffer directly cuts multi-byte sequences in half,
 * which surfaces as U+FFFD in the file name; walking code points avoids that.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let used = 0;
  let result = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    result += ch;
  }
  return result;
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
 * Follow redirects manually.
 *
 * A redirect to a different origin must not carry the caller's credentials:
 * forwarding Authorization to whatever host the server names is a credential
 * leak. Only the origin that was asked for up front gets them.
 */
async function requestFollowing(
  rawUrl: string,
  options: RequestOptions,
  method: 'GET' | 'HEAD',
  extraHeaders: Record<string, string> = {},
  maxRedirects = 10,
): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
  const originHost = safeHost(rawUrl);
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const crossOrigin = safeHost(current) !== originHost;
    // Cross-origin hops must not carry any caller credential: not the basic
    // auth pair, and not a user-supplied Authorization/Cookie in the header
    // bag either (the old code only scrubbed the per-request extras, so a
    // task header leaked the session cookie to the redirect target).
    const hopOptions: RequestOptions = crossOrigin
      ? {
          ...options,
          username: null,
          password: null,
          headers: stripCredentialHeaders(options.headers ?? {}),
        }
      : options;
    const hopHeaders: Record<string, string> = crossOrigin
      ? stripCredentialHeaders(extraHeaders)
      : extraHeaders;
    const res = await rawRequest(current, hopOptions, method, hopHeaders);
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
  /** Overall deadline for this range, in milliseconds. */
  timeoutMs?: number;
  /**
   * Per-chunk pacing hook. When provided the stream is paused until the
   * returned promise settles, which implements rate limiting without blocking
   * the event loop.
   */
  pace?: (bytes: number) => Promise<void>;
  /** Retry policy for this transfer; defaults to the exported policy. */
  retry?: { maxRetries: number; retryDelayMs: number };
  /**
   * Strong validator of the bytes already on disk, sent as `If-Range`.
   *
   * A resume is only meaningful while the remote object is unchanged. Without
   * this header the server happily answers a range for the *new* version and
   * the resulting file is a silent mix of two revisions, reported as complete.
   * When the validator no longer matches, the server answers 200 with the whole
   * body, which the caller treats as "restart from zero".
   */
  ifRange?: string | null;
}

/**
 * Download one contiguous range into an already-open file at the right offset.
 * Retries transient failures with backoff, resuming from the segment's own
 * progress rather than restarting the range.
 */
export async function downloadSegment(segment: Segment, ctx: SegmentContext): Promise<void> {
  const { url, fileHandle, options, signal } = ctx;
  const streamWhole = ctx.streamWhole === true;
  // Retry limits come from the caller so that two tasks with different
  // Option values cannot overwrite each other's policy (the previous global
  // mutable object did exactly that).
  const policy = ctx.retry ?? retryPolicy;
  const maxRetries = Math.max(0, policy.maxRetries);
  const retryDelayMs = Math.max(1, policy.retryDelayMs);

  const end = streamWhole ? Number.POSITIVE_INFINITY : segment.end;
  // A bounded end lets the reader stop early if a server over-sends.
  const boundedEnd = Number.isFinite(end) ? end : Number.MAX_SAFE_INTEGER;
  let offset = streamWhole ? 0 : segment.start + segment.downloaded;

  // Consecutive failures, not a lifetime budget: a transfer that keeps making
  // progress must never burn through its retries.
  let consecutiveFailures = 0;
  // Guards against a server that answers 2xx with an empty body forever.
  let emptyResponses = 0;
  const startedAt = Date.now();

  while (offset <= end) {
    if (signal.aborted) throw cancelledError();
    if (ctx.timeoutMs && Date.now() - startedAt > ctx.timeoutMs) {
      throw Object.assign(new Error('The transfer took too long and was abandoned.'), { code: 'ETIMEDOUT' });
    }

    const before = offset;
    let progressMade = false;
    try {
      const rangeHeaders: Record<string, string> = streamWhole
        ? {}
        : { Range: `bytes=${offset}-${boundedEnd}` };
      // Only a partial request can be validated: `If-Range` on a whole-body
      // request would just be ignored. Sending it makes the server fall back to
      // 200 (the full new body) when the validator no longer matches, which is
      // exactly the signal that the local bytes are from an older revision.
      const sentIfRange = !streamWhole && offset > 0 && !!ctx.ifRange;
      if (sentIfRange) rangeHeaders['If-Range'] = ctx.ifRange as string;
      const res = await requestFollowing(url, options, 'GET', rangeHeaders);
      const status = res.res.statusCode ?? 0;
      if (streamWhole ? status !== 200 : status !== 206 && status !== 200) {
        res.res.resume();
        throw Object.assign(new Error(`Unexpected HTTP ${status} for the download request`), { code: 'EBADSTATUS', status });
      }
      // A 200 answer to a range request means the server ignored Range; the
      // caller restarts in single-connection mode, so surface a distinct code.
      if (!streamWhole && status === 200 && offset !== 0) {
        res.res.resume();
        if (sentIfRange) {
          // The validator did not match: the remote object changed since these
          // bytes were fetched. Mixing the two revisions would corrupt the file.
          throw Object.assign(
            new Error('The file changed on the server since the transfer started.'),
            { code: 'ECHANGED' },
          );
        }
        throw Object.assign(new Error('Server ignored the Range request'), { code: 'ENORANGE' });
      }

      await new Promise<void>((resolve, reject) => {
        const stream = res.res;
        let settled = false;
        const onAbort = (): void => {
          stream.destroy();
          finishReject(cancelledError());
        };
        // Watchdog for *this response*, on top of the per-range deadline that is
        // only checked between requests. A server that answers 206 and then goes
        // silent never reaches the loop-top check, so the old code waited
        // forever (the request-level socket timeout does not fire once headers
        // and some body have arrived).
        let watchdog: NodeJS.Timeout | null = null;
        if (ctx.timeoutMs) {
          const remaining = Math.max(1, ctx.timeoutMs - (Date.now() - startedAt));
          watchdog = setTimeout(() => {
            stream.destroy();
            finishReject(
              Object.assign(new Error('The transfer took too long and was abandoned.'), { code: 'ETIMEDOUT' }),
            );
          }, remaining);
        }
        const cleanup = (): void => {
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          signal.removeEventListener('abort', onAbort);
          stream.removeListener('data', onData);
          stream.removeListener('end', finishOk);
          stream.removeListener('error', finishReject);
          stream.removeListener('close', onClose);
        };
        function finishOk(): void {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }
        function finishReject(err: unknown): void {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        }
        // A connection dropped mid-body emits 'close' without 'end'; without
        // this the promise would hang forever and the task would look alive.
        const onClose = (): void => {
          finishReject(Object.assign(new Error('The connection closed before the range completed.'), { code: 'ECONNRESET' }));
        };

        const onData = (chunk: Buffer): void => {
          if (settled || signal.aborted) return;
          // Guard against servers that over-send past the requested range.
          const allowed = streamWhole ? chunk.length : Math.min(chunk.length, boundedEnd - offset + 1);
          if (allowed <= 0) {
            // Everything requested has arrived; stop reading and settle.
            stream.pause();
            finishOk();
            return;
          }
          const slice = allowed === chunk.length ? chunk : chunk.subarray(0, allowed);
          let written: number;
          try {
            written = writeFullySync(fileHandle, slice, offset);
          } catch (err) {
            finishReject(err);
            return;
          }
          offset += written;
          segment.downloaded += written;
          progressMade = true;
          ctx.onChunk({
            bytes: written,
            offset: offset - written,
            segmentIndex: segment.index,
            segmentDownloaded: segment.downloaded,
          });

          if (!streamWhole && offset > boundedEnd) {
            // Range complete: settle immediately instead of destroy(), which
            // never emits 'end'/'error' and used to leak the promise and fd.
            stream.pause();
            finishOk();
            return;
          }
          // Backpressure: let the caller pace the producer without blocking
          // the event loop (replaces the old synchronous spin loop).
          if (ctx.pace) {
            stream.pause();
            ctx.pace(slice.length).then(
              () => { if (!settled && !signal.aborted) stream.resume(); },
              (err: unknown) => finishReject(err),
            );
          }
        };

        signal.addEventListener('abort', onAbort, { once: true });
        stream.on('data', onData);
        stream.on('end', finishOk);
        stream.on('error', finishReject);
        stream.on('close', onClose);
      });

      if (!streamWhole && offset > boundedEnd) return;
      if (streamWhole) return;

      // A 2xx with no usable bytes would otherwise spin here at request speed.
      if (offset === before) {
        emptyResponses += 1;
        if (emptyResponses >= Math.max(3, maxRetries)) {
          throw Object.assign(
            new Error('The server keeps answering without sending any data.'),
            { code: 'ENODATA' },
          );
        }
        await sleep(Math.min(retryDelayMs, 1000));
        continue;
      }
      // Progress was made: a later failure starts a fresh retry budget.
      consecutiveFailures = 0;
      emptyResponses = 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (signal.aborted) throw cancelledError();
      if (code === 'ABORTED' || code === 'ENORANGE' || code === 'ECHANGED') throw err;
      // The overall deadline is a budget for the whole range, not a transient
      // failure: retrying would just restart the clock and never give up.
      if (code === 'ETIMEDOUT' && ctx.timeoutMs && Date.now() - startedAt >= ctx.timeoutMs) throw err;
      // A definitive HTTP answer (4xx) will not improve by retrying, except
      // for the rate-limit / transient 5xx families.
      if (code === 'EBADSTATUS' && !isRetryableStatus((err as { status?: number }).status)) throw err;
      if (!isRetryableNetworkError(err) && code !== 'EBADSTATUS' && code !== 'ENODATA') throw err;

      consecutiveFailures += 1;
      if (consecutiveFailures > maxRetries) throw err;
      if (progressMade) continue;
      const backoff = Math.min(Math.max(250, retryDelayMs) * 2 ** (consecutiveFailures - 1), 60_000);
      await sleep(backoff);
    }
  }
}

/**
 * Write `buf` at `position` and return the number of bytes actually written.
 *
 * `fs.writeSync` is allowed to write *less* than requested: the kernel returns
 * a short count when the request crosses a limit (a signal interrupt, a full
 * pipe/socket page, a filesystem that caps a single write). The old code
 * ignored the return value entirely, advanced the offset by the full chunk
 * length and reported success — so a short write silently left a hole of
 * uninitialised file content while every progress counter said the range was
 * complete. Looping here is the only way to make the write authoritative.
 *
 * `ENOSPC`/`EDQUOT` are surfaced immediately with a distinguishable code so the
 * caller can fail cleanly and leave the partial file resumable.
 */
function writeFullySync(fh: number, buf: Buffer, position: number): number {
  let done = 0;
  while (done < buf.length) {
    let n: number;
    try {
      n = fs.writeSync(fh, buf, done, buf.length - done, position + done);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') {
        // Nothing more can land on this device. Report how far we got so the
        // caller can keep the bytes already on disk for a later resume.
        throw Object.assign(
          new Error('There is not enough free disk space to finish the download.'),
          { code: 'ENOSPC', written: done, cause: err },
        );
      }
      throw err;
    }
    if (n <= 0) {
      throw Object.assign(
        new Error('The disk stopped accepting data for this download.'),
        { code: 'EWRITEZERO', written: done },
      );
    }
    done += n;
  }
  return done;
}

function cancelledError(): Error {
  return Object.assign(new Error('Download cancelled'), { code: 'ABORTED' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Statuses where retrying the same range can plausibly succeed. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Open (creating if needed) the file a transfer writes into.
 *
 * Two rules matter for correctness:
 *  - Never truncate a file that is *larger* than the remote object. The old
 *    implementation called ftruncate unconditionally, which silently destroyed
 *    local data when a stale file of the same name already existed.
 *  - Preallocation must not destroy the resume watermark. Callers therefore use
 *    {@link statWorkFile} to read the true byte count *before* the file is
 *    extended, and the returned size is never used to infer progress.
 */
export async function prepareFile(
  filePath: string,
  totalBytes: number,
  opts: { preallocate?: boolean } = {},
): Promise<number> {
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
    if (stat.size > totalBytes) {
      fs.closeSync(handle);
      throw Object.assign(
        new Error('The destination file is larger than the remote file.'),
        { code: 'ESIZECONFLICT' },
      );
    }
    // Preallocating is only needed when several connections write the same fd
    // concurrently. For a single connection it is actively harmful: the file
    // then always looks full-size, destroying the byte watermark that resume
    // depends on.
    const preallocate = opts.preallocate !== false;
    if (preallocate && stat.size < totalBytes) {
      fs.ftruncateSync(handle, totalBytes);
    }
  }
  return handle;
}

/**
 * Size of a work file on disk, or 0 when it does not exist. Read this *before*
 * {@link prepareFile} preallocates, otherwise every file looks complete.
 */
export async function statWorkFile(filePath: string): Promise<number> {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}
/** Host of a URL, or '' when it cannot be parsed. */
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/** Copy `headers` without any credential-bearing entries. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.includes(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}
