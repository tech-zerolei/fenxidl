/**
 * Media sniffer: a local HTTP capture service plus manifest parsing so the app
 * can offer the media files a page actually requests (spec §8).
 *
 * This is the standards-based replacement for the original product's
 * kernel-level network filter drivers. Nothing is injected into the browser's
 * process; a page holding the standard browser-extension handoff (or a user
 * pasting a media URL) supplies the request URLs.
 */

import * as http from 'node:http';
import { URL } from 'node:url';

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
}

export interface SnifferHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the local capture service.
 *
 * Accepted requests (all JSON, all bound to loopback):
 *   POST /report  { url, mimeType?, sizeBytes? }
 *   GET  /health
 *
 * The service refuses cross-origin writes by requiring a matching Origin or
 * no Origin at all, and rejects payloads above 64 KiB.
 */
export async function startSniffer(opts: SnifferOptions): Promise<SnifferHandle> {
  const host = opts.host ?? '127.0.0.1';
  const seen = new Map<string, SniffedMedia>();

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    // Loopback-only, and only for our own extension origins.
    res.setHeader('Access-Control-Allow-Origin', origin ?? 'null');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ ok: true, intercepted: seen.size }),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/report') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid json');
        return;
      }
      const rec = body as Record<string, unknown>;
      const url = typeof rec.url === 'string' ? rec.url : '';
      if (!/^https?:\/\//i.test(url)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid url');
        return;
      }
      const mime = typeof rec.mimeType === 'string' ? rec.mimeType : null;
      const kind = classifyMedia(url, mime);
      if (!kind) {
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: false }));
        return;
      }
      if (seen.has(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: true, duplicate: true }));
        return;
      }
      const entry: SniffedMedia = {
        url,
        kind,
        mimeType: mime ?? '',
        sizeBytes: typeof rec.sizeBytes === 'number' ? rec.sizeBytes : null,
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
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: true }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve());
  });

  const actual = (server.address() as { port: number }).port;
  return {
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Export for callers that want the recent media list semantics. */
export const RECENT_MEDIA_LIMIT = 10;
