/**
 * End-to-end check: start a local range-capable HTTP server, download a file
 * through the real segmented engine and verify byte identity.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { downloadSegment, planSegments, prepareFile, probe } from '../main/download-engine';
import type { RequestOptions } from '../main/download-engine';

function makeServer(body: Buffer, opts: { ranges: boolean }) {
  return http.createServer((req, res) => {
    // Serve only the known path so a missing-file case is genuinely a 404.
    if (!req.url || !req.url.startsWith('/payload.bin')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': '9' });
      res.end('not found');
      return;
    }
    const range = req.headers.range;
    if (opts.ranges && typeof range === 'string') {
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
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'Content-Disposition': 'attachment; filename="payload.bin"',
    });
    res.end(body);
  });
}

async function main(): Promise<void> {
  const size = 3 * 1024 * 1024 + 12345;
  const body = crypto.randomBytes(size);
  const expected = crypto.createHash('sha256').update(body).digest('hex');

  // 1. Range-capable server: probe + segmented download must be byte-identical.
  const rangeServer = makeServer(body, { ranges: true });
  await new Promise<void>((r) => rangeServer.listen(0, '127.0.0.1', () => r()));
  const port1 = (rangeServer.address() as { port: number }).port;
  const url1 = `http://127.0.0.1:${port1}/payload.bin`;

  const info = await probe(url1);
  if (!info.ok) throw new Error(`probe failed: ${info.error}`);
  if (!info.supportsResume) throw new Error('expected resume support');
  if (info.totalBytes !== size) throw new Error(`expected ${size}, got ${info.totalBytes}`);
  if (info.fileName !== 'payload.bin') throw new Error(`filename: ${info.fileName}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxidl-e2e-'));
  const outPath = path.join(dir, 'out.bin');
  const segments = planSegments(info.totalBytes, 8);
  const handle = await prepareFile(outPath, info.totalBytes);
  const options: RequestOptions = {};
  const controller = new AbortController();
  let bytes = 0;
  await Promise.all(
    segments.map((seg) =>
      downloadSegment(seg, {
        url: url1,
        fileHandle: handle,
        options,
        signal: controller.signal,
        onChunk: (ev) => {
          bytes += ev.bytes;
        },
      }),
    ),
  );
  fs.closeSync(handle);
  const got = fs.readFileSync(outPath);
  const actual = crypto.createHash('sha256').update(got).digest('hex');
  if (got.length !== size) throw new Error(`size mismatch: ${got.length} vs ${size}`);
  if (actual !== expected) throw new Error('content hash mismatch');
  if (bytes !== size) throw new Error(`byte counter mismatch: ${bytes} vs ${size}`);
  console.log(`✔ segmented download: ${segments.length} segments, ${bytes} bytes, hash ok`);

  // 2. Server without range support: probe must report no resume.
  const plainServer = makeServer(body, { ranges: false });
  await new Promise<void>((r) => plainServer.listen(0, '127.0.0.1', () => r()));
  const port2 = (plainServer.address() as { port: number }).port;
  const info2 = await probe(`http://127.0.0.1:${port2}/payload.bin`);
  if (!info2.ok) throw new Error(`probe2 failed: ${info2.error}`);
  if (info2.supportsResume) throw new Error('expected no resume support');
  if (info2.totalBytes !== size) throw new Error(`probe2 size ${info2.totalBytes}`);
  console.log('✔ non-range server detected correctly');

  // 3. 404 must surface a friendly error, not throw.
  const info3 = await probe(`http://127.0.0.1:${port2}/missing.bin`);
  if (info3.ok) throw new Error('expected failure for missing file');
  if (info3.statusCode !== 404) throw new Error(`expected status 404, got ${info3.statusCode}`);
  if (!info3.error || !info3.error.includes('404')) throw new Error(`unexpected error text: ${info3.error}`);
  console.log('✔ missing file reported as an error result (HTTP 404)');

  // 4. Resume: pre-fill part of the file and confirm the engine only fetches the rest.
  const seg = planSegments(size, 4)[1];
  const half = Math.floor((seg.end - seg.start + 1) / 2);
  seg.downloaded = half;
  const partialHandle = await prepareFile(outPath, size);
  const zeros = Buffer.alloc(size);
  fs.writeSync(partialHandle, zeros, 0, size, 0);
  let resumeBytes = 0;
  await downloadSegment(seg, {
    url: url1,
    fileHandle: partialHandle,
    options,
    signal: new AbortController().signal,
    onChunk: (ev) => {
      resumeBytes += ev.bytes;
    },
  });
  fs.closeSync(partialHandle);
  const remaining = seg.end - seg.start + 1 - half;
  if (resumeBytes !== remaining) throw new Error(`resume fetched ${resumeBytes}, expected ${remaining}`);
  console.log(`✔ resume fetched only the remaining ${resumeBytes} bytes`);

  rangeServer.close();
  plainServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ALL E2E CHECKS PASSED');
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
});
