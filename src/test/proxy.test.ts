/**
 * Verify the proxy path is real: run a minimal HTTP forward proxy and confirm
 * downloads traverse it (absolute-form requests) and that the proxy config is
 * respected by proxyForUrl.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { proxyForUrl, probe, planSegments, prepareFile, downloadSegment } from '../main/download-engine';
import type { RequestOptions } from '../main/download-engine';

const proxyOff = { enabled: false, host: '', port: 0, username: '', password: '' };
const proxyOn = (port: number) => ({ enabled: true, host: '127.0.0.1', port, username: '', password: '' });

test('proxyForUrl prefers the HTTPS proxy for https targets and falls back', () => {
  const httpP = { enabled: true, host: 'h1', port: 1, username: '', password: '' };
  const httpsP = { enabled: true, host: 'h2', port: 2, username: '', password: '' };
  assert.equal(proxyForUrl('https://a', { httpProxy: httpP, httpsProxy: httpsP })?.host, 'h2');
  assert.equal(proxyForUrl('https://a', { httpProxy: httpP, httpsProxy: proxyOff })?.host, 'h1');
  assert.equal(proxyForUrl('http://a', { httpProxy: httpP, httpsProxy: httpsP })?.host, 'h1');
  assert.equal(proxyForUrl('http://a', { httpProxy: proxyOff, httpsProxy: httpsP }), null);
});

test('downloads traverse an HTTP proxy and produce identical bytes', async () => {
  const size = 512 * 1024;
  const body = crypto.randomBytes(size);
  const expected = crypto.createHash('sha256').update(body).digest('hex');

  const origin = http.createServer((req, res) => {
    const range = req.headers.range;
    if (typeof range === 'string') {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': String(slice.length),
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  const originPort = (origin.address() as { port: number }).port;

  // Minimal forward proxy using absolute-form request targets.
  const seen: string[] = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    const target = new URL(req.url ?? '');
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end('proxy error');
    });
    req.pipe(upstream);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxy.address() as { port: number }).port;

  const url = `http://127.0.0.1:${originPort}/f.bin`;
  const options: RequestOptions = { httpProxy: proxyOn(proxyPort) };

  const info = await probe(url, options);
  assert.equal(info.ok, true, `probe failed: ${info.error}`);
  assert.equal(info.totalBytes, size);
  assert.ok(seen.length > 0, 'the proxy must have been used for the probe');
  assert.ok(
    seen.every((u) => u.startsWith('http://')),
    `proxied requests must use absolute-form targets, saw: ${seen[0]}`,
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxidl-proxy-'));
  const out = path.join(dir, 'out.bin');
  const segments = planSegments(info.totalBytes, 4);
  const handle = await prepareFile(out, info.totalBytes);
  await Promise.all(
    segments.map((seg) =>
      downloadSegment(seg, {
        url,
        fileHandle: handle,
        options,
        signal: new AbortController().signal,
        onChunk: () => undefined,
      }),
    ),
  );
  fs.closeSync(handle);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  assert.equal(actual, expected, 'proxied download must be byte-identical');
  assert.ok(seen.length >= 1 + segments.length, `expected proxy traffic for every segment, saw ${seen.length}`);

  origin.close();
  proxy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
