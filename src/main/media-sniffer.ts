/**
 * Media sniffer: a local HTTP capture service plus manifest parsing so the app
 * can offer the media files a page actually requests (spec §8).
 *
 * This is the standards-based replacement for the original product's
 * kernel-level network filter drivers. Nothing is injected into the browser's
 * process; a page holding the standard browser-extension handoff (or a user
 * pasting a media URL) supplies the request URLs.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { URL } from 'node:url';
import { assertOutboundHostAllowed, isRecord } from './validate';

export interface SniffedMedia {
  url: string;
  /** Coarse kind: what the floating bar offers to download (spec 20852/20853). */
  kind: 'video' | 'audio';
  mimeType: string;
  /** Content-Length when the server reported one. */
  sizeBytes: number | null;
  /** Raw manifest text when the URL was an HLS/DASH playlist. */
  manifestUrl: string | null;
  /** Parsed stream variants for playlists. */
  variants: Array<{ url: string; bandwidth: number | null; resolution: string | null }>;
  /** Duration in seconds when the manifest declared it. */
  durationSeconds: number | null;
  /** Video resolution as "WxH" when known (spec string 20897). */
  resolution: string | null;
  discoveredAt: number;
}

/** MIME prefixes the original considers media (from its extracted MIME list). */
const VIDEO_MIMES = new Set([
  'video/mp4', 'video/x-mp4', 'video/x-m4v', 'video/m4v', 'video/mp4v-es',
  'video/webm', 'video/x-flv', 'video/flv', 'video/quicktime', 'video/x-msvideo',
  'video/msvideo', 'video/avi', 'video/mpeg', 'video/mpg', 'video/x-mpeg',
  'video/x-mpg', 'video/mpg4', 'video/x-mpg4', 'video/divx', 'video/x-ms-wmv',
  'video/x-ms-asf', 'video/3gpp', 'video/x-matroska', 'video/mp2t', 'video/f4v',
]);

const AUDIO_MIMES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'audio/mp4', 'audio/m4a',
  'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/wav', 'audio/x-wav',
  'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac', 'audio/x-ms-wma',
  'audio/x-mod', 'audio/x-pn-realaudio', 'audio/webm',
]);

export function classifyMedia(url: string, mimeType: string | null): 'video' | 'audio' | null {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (VIDEO_MIMES.has(mime)) return 'video';
  if (AUDIO_MIMES.has(mime)) return 'audio';
  // Fall back to the extension when the server sends a generic type.
  let ext = '';
  try {
    const base = new URL(url).pathname.split('/').pop() ?? '';
    ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  } catch {
    return null;
  }
  if (['mp4', 'webm', 'flv', 'mkv', 'mov', 'avi', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm3u8', 'mpd'].includes(ext)) {
    return 'video';
  }
  if (['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'].includes(ext)) return 'audio';
  return null;
}

/** Parse an HLS playlist into byte-range-free absolute variant URLs. */
export function parseHlsManifest(text: string, baseUrl: string): {
  variants: Array<{ url: string; bandwidth: number | null; resolution: string | null }>;
  durations: number[];
} {
  const variants: Array<{ url: string; bandwidth: number | null; resolution: string | null }> = [];
  const durations: number[] = [];

  // Master playlist: #EXT-X-STREAM-INF then the URI on the next line.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
      const bw = /BANDWIDTH=(\d+)/.exec(attrs);
      const res = /RESOLUTION=(\d+x\d+)/.exec(attrs);
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j] || lines[j].startsWith('#')) continue;
        try {
          variants.push({
            url: new URL(lines[j], baseUrl).toString(),
            bandwidth: bw ? Number(bw[1]) : null,
            resolution: res ? res[1] : null,
          });
        } catch {
          /* skip malformed */
        }
        break;
      }
    }
    if (line.startsWith('#EXTINF:')) {
      const d = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      if (Number.isFinite(d) && d > 0) durations.push(d);
    }
  }
  return { variants, durations };
}

/** Parse a DASH MPD into its representation URLs. */
export function parseDashManifest(xml: string, baseUrl: string): {
  variants: Array<{ url: string; bandwidth: number | null; resolution: string | null }>;
  durationSeconds: number | null;
} {
  const variants: Array<{ url: string; bandwidth: number | null; resolution: string | null }> = [];
  const dur = /mediaPresentationDuration="P(?:T)?([\d.]+)S"/.exec(xml);
  const rep = /<Representation\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = rep.exec(xml)) !== null) {
    const attrs = m[1];
    // Parse attributes properly: a naive /width="(\d+)"/ also matches inside
    // bandwidth="..." and produced nonsense resolutions.
    const attr = (name: string): string | null => {
      const m2 = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
      return m2 ? m2[1] : null;
    };
    const bwRaw = attr('bandwidth');
    const widthRaw = attr('width');
    const heightRaw = attr('height');
    const bw = bwRaw !== null && /^\d+$/.test(bwRaw) ? [bwRaw, bwRaw] : null;
    const width = widthRaw !== null && /^\d+$/.test(widthRaw) ? [widthRaw, widthRaw] : null;
    const height = heightRaw !== null && /^\d+$/.test(heightRaw) ? [heightRaw, heightRaw] : null;
    // A Representation may hold a BaseURL child; otherwise it is not directly fetchable.
    const tail = xml.slice(m.index);
    const baseMatch = /<BaseURL>([^<]+)<\/BaseURL>/.exec(tail);
    if (!baseMatch) continue;
    try {
      variants.push({
        url: new URL(baseMatch[1].trim(), baseUrl).toString(),
        bandwidth: bw ? Number(bw[1]) : null,
        resolution: width && height ? `${width[1]}x${height[1]}` : null,
      });
    } catch {
      /* skip */
    }
  }
  return { variants, durationSeconds: dur ? Number(dur[1]) : null };
}

export interface SnifferOptions {
  port: number;
  host?: string;
  /** Called for every accepted report. */
  onMedia: (media: SniffedMedia) => void;
  onLog?: (message: string) => void;
  /**
   * Extension IDs allowed to post. When empty, any `chrome-extension://`
   * origin is accepted (the shipped extension has no stable ID until a
   * distributor pins one in the manifest); arbitrary web origins never are.
   */
  allowedExtensionIds?: string[];
  /**
   * Shared secret additionally required for requests that carry no
   * `chrome-extension://` origin. Generated when omitted.
   */
  token?: string;
}

export interface SnifferHandle {
  port: number;
  /** Shared secret accepted in the `X-Fenxi-Token` header. */
  token: string;
  close: () => Promise<void>;
}

/** Reason a request was refused; used for logging and tests. */
export type SnifferRejection =
  | 'origin-not-allowed'
  | 'token-required'
  | 'token-invalid'
  | 'blocked-host'
  | 'invalid-json'
  | 'invalid-url'
  | 'body-too-large'
  | 'not-found';

function originOf(req: http.IncomingMessage): string {
  const origin = req.headers.origin;
  if (Array.isArray(origin)) return origin[0] ?? '';
  return origin ?? '';
}

/**
 * Classify an Origin header.
 *
 * `chrome-extension://<id>` is the only origin class that may write without a
 * token: it is a locally installed extension. `null`, `file://` and a missing
 * Origin all require the shared token. Every web origin is refused, which is
 * what stops an arbitrary page from injecting forged media entries.
 */
export function classifySnifferOrigin(
  origin: string,
  allowedExtensionIds: string[],
): 'extension' | 'token' | 'reject' {
  const value = origin.trim();
  if (!value || value === 'null' || value === 'file://') return 'token';
  const match = /^chrome-extension:\/\/([a-z0-9]+)\/?$/i.exec(value);
  if (match) {
    const id = match[1].toLowerCase();
    if (allowedExtensionIds.length === 0) return 'extension';
    return allowedExtensionIds.map((x) => x.toLowerCase()).includes(id) ? 'extension' : 'reject';
  }
  // A web origin is always refused, even when it presents the shared token.
  // A page that could write media entries would be able to plant an arbitrary
  // download target, and browsers always send Origin for cross-origin POSTs,
  // so no legitimate page needs this. The token path exists for callers that
  // send no Origin at all (native tools, the app itself).
  return 'reject';
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

/**
 * Start the local capture service.
 *
 * Accepted requests (all JSON, all bound to loopback):
 *   POST /report  { url, mimeType?, sizeBytes? }   (header X-Fenxi-Token)
 *   GET  /health                                    (header X-Fenxi-Token)
 *
 * Security properties:
 *  - Only a `chrome-extension://` origin or a caller presenting the shared
 *    token may talk to the service; every other origin gets 403 and the
 *    response never reflects the request's Origin back.
 *  - Reported URLs must be ordinary public http(s) targets, so an injected
 *    entry cannot point the downloader at cloud metadata or a local service.
 *  - Payloads above 64 KiB are rejected.
 */
export async function startSniffer(opts: SnifferOptions): Promise<SnifferHandle> {
  const host = opts.host ?? '127.0.0.1';
  const seen = new Map<string, SniffedMedia>();
  const allowedExtensionIds = opts.allowedExtensionIds ?? [];
  const token = opts.token && opts.token.length >= 16 ? opts.token : crypto.randomBytes(32).toString('hex');

  const reject = (res: http.ServerResponse, status: number, reason: SnifferRejection): void => {
    // Never echo the request Origin back: that is the original CORS bug.
    sendJson(res, status, { accepted: false, error: reason });
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A single, fixed policy: extensions are trusted by origin, nothing else.
    const origin = originOf(req);
    const originClass = classifySnifferOrigin(origin, allowedExtensionIds);
    if (originClass === 'extension') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Fenxi-Token');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      if (originClass === 'reject') {
        reject(res, 403, 'origin-not-allowed');
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (originClass === 'reject') {
      opts.onLog?.(`Refused a media report from origin ${origin || '(none)'}.`);
      reject(res, 403, 'origin-not-allowed');
      return;
    }

    const presented = req.headers['x-fenxi-token'];
    const presentedToken = Array.isArray(presented) ? presented[0] ?? '' : presented ?? '';
    let tokenOk = false;
    if (presentedToken.length === token.length) {
      try {
        tokenOk = crypto.timingSafeEqual(Buffer.from(presentedToken), Buffer.from(token));
      } catch {
        tokenOk = false;
      }
    }
    if (originClass === 'token' && !tokenOk) {
      reject(res, 401, presentedToken ? 'token-invalid' : 'token-required');
      return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
      sendJson(res, 200, { ok: true, intercepted: seen.size });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/report') {
      reject(res, 404, 'not-found');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > 64 * 1024) {
        aborted = true;
        reject(res, 413, 'body-too-large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(res, 400, 'invalid-json');
        return;
      }
      if (!isRecord(body)) {
        reject(res, 400, 'invalid-json');
        return;
      }
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!/^https?:\/\//i.test(url) || url.length > 4096) {
        reject(res, 400, 'invalid-url');
        return;
      }
      try {
        // An entry becomes a download target, so it must not address the
        // machine itself or a link-local/metadata endpoint.
        assertOutboundHostAllowed(url, { blockLoopback: true });
      } catch {
        opts.onLog?.(`Refused a media report for a non-public address.`);
        reject(res, 400, 'blocked-host');
        return;
      }
      const mime = typeof body.mimeType === 'string' ? body.mimeType.slice(0, 200) : null;
      const kind = classifyMedia(url, mime);
      if (!kind) {
        sendJson(res, 202, { accepted: false });
        return;
      }
      if (seen.has(url)) {
        sendJson(res, 200, { accepted: true, duplicate: true });
        return;
      }
      const entry: SniffedMedia = {
        url,
        kind,
        mimeType: mime ?? '',
        sizeBytes: typeof body.sizeBytes === 'number' && Number.isFinite(body.sizeBytes) ? body.sizeBytes : null,
        manifestUrl: null,
        variants: [],
        durationSeconds: null,
        resolution: null,
        discoveredAt: Date.now(),
      };
      seen.set(url, entry);
      // Keep the recent window bounded, as the original offers the last ten.
      if (seen.size > 50) {
        const oldest = [...seen.entries()].sort((a, b) => a[1].discoveredAt - b[1].discoveredAt)[0];
        if (oldest) seen.delete(oldest[0]);
      }
      opts.onMedia(entry);
      opts.onLog?.(`Sniffed ${kind}: ${url}`);
      sendJson(res, 200, { accepted: true });
    });
  });

  await new Promise<void>((resolve, reject2) => {
    server.once('error', reject2);
    server.listen(opts.port, host, () => resolve());
  });

  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Export for callers that want the recent media list semantics. */
export const RECENT_MEDIA_LIMIT = 10;
