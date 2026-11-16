/**
 * Site grabber: bounded same-site crawling with include/exclude filters.
 *
 * Behaviour derived from spec §5: depth limits (whole site / N levels / other
 * site depth), type and path filters, size range limits, concurrency caps of
 * 1-10 for both exploring and downloading, and live statistics for pages,
 * found, matched and downloaded counts.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { URL } from 'node:url';
import type { GrabberProject, GrabberStats } from '../shared/types';

export interface CrawlFoundFile {
  url: string;
  /** Resolved absolute URL. */
  absoluteUrl: string;
  fileName: string;
  /** Best-effort extension (lowercase, no dot). */
  extension: string;
  linkText: string;
  /** Page where the link was discovered. */
  sourcePage: string;
  depth: number;
  sizeBytes: number | null;
}

export interface GrabberCallbacks {
  onStats: (stats: GrabberStats) => void;
  onFiles: (files: CrawlFoundFile[]) => void;
  onLog: (message: string) => void;
}

export interface GrabberHandle {
  stop: () => void;
  promise: Promise<void>;
}

const DOWNLOADABLE_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'exe', 'msi',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts',
  'apk', 'dmg', 'deb', 'rpm', 'crx', 'xpi',
]);

const HTML_EXTENSIONS = new Set(['', 'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'cgi', 'shtml']);

function extensionOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const base = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

function normalizePatterns(raw: string[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    for (const piece of entry.split(';')) {
      const t = piece.trim().toLowerCase().replace(/^\*\.?/, '').replace(/^\./, '');
      if (t) out.push(t);
    }
  }
  return out;
}

/** Minimal HTML link extractor: href plus the anchor text. */
export function extractLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const results: Array<{ url: string; text: string }> = [];
  const anchor = /<a\b[^>]*?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const hrefRaw = m[1].replace(/^["']|["']$/g, '').trim();
    const innerText = m[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (!hrefRaw || /^(javascript|mailto|tel|data):/i.test(hrefRaw) || hrefRaw.startsWith('#')) continue;
    try {
      results.push({ url: new URL(hrefRaw, baseUrl).toString(), text: innerText });
    } catch {
      /* skip malformed */
    }
  }
  // Also capture plain image sources so galleries without links still yield files.
  const img = /<img\b[^>]*?src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  while ((m = img.exec(html)) !== null) {
    const src = m[1].replace(/^["']|["']$/g, '').trim();
    if (!src || src.startsWith('data:')) continue;
    try {
      results.push({ url: new URL(src, baseUrl).toString(), text: '' });
    } catch {
      /* skip */
    }
  }
  return results;
}

function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const go = (target: string, hops: number) => {
      if (hops > 6) {
        finish(() => reject(new Error('Too many redirects')));
        return;
      }
      const u = new URL(target);
      const transport = u.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FenxiDL Grabber)',
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Encoding': 'identity',
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            go(new URL(res.headers.location, target).toString(), hops + 1);
            return;
          }
          if (status >= 400) {
            res.resume();
            finish(() => reject(new Error(`HTTP ${status} for ${target}`)));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            // Cap page size so one huge page cannot exhaust memory.
            if (size <= 8 * 1024 * 1024) chunks.push(c);
          });
          res.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
          res.on('error', (e) => finish(() => reject(e)));
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
      });
      req.on('error', (e) => finish(() => reject(e)));
      req.end();
    };
    go(url, 0);
  });
}

/** Resolve a `HEAD` request for a size so size filters can be applied. */
function fetchSize(url: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const u = new URL(url);
      const transport = u.protocol === 'https:' ? https : http;
      const req = transport.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FenxiDL Grabber)', 'Accept-Encoding': 'identity' },
        },
        (res) => {
          const len = res.headers['content-length'];
          res.resume();
          const n = typeof len === 'string' ? Number(len) : NaN;
          done(Number.isFinite(n) && n > 0 ? n : null);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        done(null);
      });
      req.on('error', () => done(null));
      req.end();
    } catch {
      done(null);
    }
  });
}

/** Run a bounded worker pool over `items`. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, 10));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    }),
  );
}

export function startGrabber(project: GrabberProject, callbacks: GrabberCallbacks): GrabberHandle {
  const stats: GrabberStats = {
    status: 'exploring',
    pagesProcessed: 0,
    filesFound: 0,
    filesMatched: 0,
    filesDownloaded: 0,
  };
  let stopped = false;
  const report = () => callbacks.onStats({ ...stats });

  const includeTypes = normalizePatterns(project.includeTypes);
  const excludeTypes = normalizePatterns(project.excludeTypes);
  const includePaths = normalizePatterns(project.includePaths);
  const excludePaths = normalizePatterns(project.excludePaths);

  const startUrl = project.startUrl.trim();
  let startHost = '';
  try {
    const u = new URL(startUrl);
    startHost = u.host.toLowerCase();
  } catch {
    callbacks.onLog('The start page URL is not valid.');
    stats.status = 'stopped';
    report();
    return { stop: () => undefined, promise: Promise.resolve() };
  }

  const visited = new Set<string>();
  const found = new Map<string, CrawlFoundFile>();
  const state = { emitted: false };

  const matchesFilters = (candidate: CrawlFoundFile): boolean => {
    if (excludeTypes.length && excludeTypes.includes(candidate.extension)) return false;
    if (includeTypes.length && !includeTypes.includes(candidate.extension)) return false;
    const lower = candidate.absoluteUrl.toLowerCase();
    for (const bad of excludePaths) if (lower.includes(bad)) return false;
    if (includePaths.length) {
      const okPath = includePaths.some((good) => lower.includes(good));
      if (!okPath) return false;
    }
    if (project.minBytes > 0 && candidate.sizeBytes !== null && candidate.sizeBytes < project.minBytes) return false;
    if (project.maxBytes > 0 && candidate.sizeBytes !== null && candidate.sizeBytes > project.maxBytes) return false;
    return true;
  };

  const run = async (): Promise<void> => {
    // Breadth-first crawl by depth level so the depth cap is respected.
    let frontier = [startUrl];
    const levels = Math.max(0, project.maxDepth);
    const limit = project.wholeSite ? levels : Math.min(levels, 64);

    for (let depth = 0; depth <= limit; depth += 1) {
      if (stopped || frontier.length === 0) break;
      const next: string[] = [];
      await pool(frontier, project.concurrentExplore, async (pageUrl) => {
        if (stopped) return;
        const key = pageUrl.split('#')[0];
        if (visited.has(key)) return;
        visited.add(key);

        let html: string;
        try {
          html = await fetchText(key);
        } catch (err) {
          callbacks.onLog(`Could not read ${key}: ${(err as Error).message}`);
          return;
        }
        stats.pagesProcessed += 1;
        report();

        for (const link of extractLinks(html, key)) {
          if (stopped) return;
          const abs = link.url.split('#')[0];
          let parsed: URL;
          try {
            parsed = new URL(abs);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(parsed.protocol)) continue;

          const sameHost = parsed.host.toLowerCase() === startHost;
          if (project.onlyThisSite && !sameHost) continue;
          // Cross-site files are still collectable; cross-site pages are only
          // crawled up to the "other site depth".
          if (!sameHost && depth > project.otherSiteDepth) {
            // Do not descend further, but still record the file.
          }

          const ext = extensionOf(abs);
          const isPage = HTML_EXTENSIONS.has(ext);
          const isFile = DOWNLOADABLE_EXTENSIONS.has(ext);

          if (isFile) {
            stats.filesFound += 1;
            if (found.has(abs)) continue;
            const rel = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'file');
            const candidate: CrawlFoundFile = {
              url: abs,
              absoluteUrl: abs,
              fileName: rel,
              extension: ext,
              linkText: link.text,
              sourcePage: key,
              depth,
              sizeBytes: null,
            };
            if (matchesFilters(candidate)) {
              // Size filters need the real length.
              if (project.minBytes > 0 || project.maxBytes > 0) {
                candidate.sizeBytes = await fetchSize(abs);
                if (!matchesFilters(candidate)) {
                  report();
                  continue;
                }
              }
              found.set(abs, candidate);
              stats.filesMatched += 1;
              report();
            } else {
              report();
            }
            continue;
          }

          if (isPage && depth < limit) {
            if (!sameHost && depth >= project.otherSiteDepth) continue;
            if (project.excludeParentDirs && parsed.pathname.endsWith('/..')) continue;
            if (!visited.has(abs)) next.push(abs);
          }
        }
      });
      frontier = [...new Set(next)];
      if (!state.emitted && found.size > 0) {
        state.emitted = true;
        callbacks.onFiles([...found.values()]);
      }
    }

    if (stopped) {
      stats.status = 'stopped';
    } else {
      stats.status = found.size > 0 ? 'completed' : 'completed';
    }
    callbacks.onFiles([...found.values()]);
    report();
    callbacks.onLog(
      `Finished: ${stats.pagesProcessed} pages processed, ${stats.filesFound} files found, ` +
        `${stats.filesMatched} matched.`,
    );
  };

  const promise = run().catch((err) => {
    callbacks.onLog(`The grabber stopped after an error: ${(err as Error).message}`);
    stats.status = 'stopped';
    report();
  });

  return {
    stop: () => {
      stopped = true;
    },
    promise,
  };
}

/** Build a relative save path for a grabbed file when that option is enabled. */
export function relativeSavePath(project: GrabberProject, file: CrawlFoundFile): string {
  if (!project.useRelativePaths) return file.fileName;
  try {
    const u = new URL(file.absoluteUrl);
    const segments = u.pathname.split('/').filter(Boolean);
    return path.join(...segments);
  } catch {
    return file.fileName;
  }
}