/**
 * Integration test: drive the REAL TaskManager against a REAL HTTP server and
 * verify a complete download, hash equality, segment accounting and the
 * completed-state transition.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { TaskManager } from '../main/task-manager';
import { defaultSettings } from '../main/settings';
import type { Queue } from '../shared/types';

function makeServer(body: Buffer): http.Server {
  return http.createServer((req, res) => {
    if (!req.url?.startsWith('/payload.bin')) {
      res.writeHead(404, { 'Content-Length': '2' });
      res.end('nf');
      return;
    }
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
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      'Content-Disposition': 'attachment; filename="integration.bin"',
    });
    res.end(body);
  });
}

async function main(): Promise<void> {
  const size = 6 * 1024 * 1024 + 777;
  const body = crypto.randomBytes(size);
  const expected = crypto.createHash('sha256').update(body).digest('hex');

  const server = makeServer(body);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxidl-int-'));
  const settings = defaultSettings();
  settings.defaultDirectory = workDir;
  settings.categories = settings.categories.map((c) => ({ ...c, directory: workDir }));
  settings.defaultConnections = 6;
  settings.showStartDialog = false;

  const queues: Queue[] = [
    { id: 'primary', name: 'Main', concurrency: 2, isPrimary: true },
  ];
  const manager = new TaskManager({
    settings,
    queues,
    schedules: [],
    storagePath: path.join(workDir, 'state.json'),
  });
  await manager.load();

  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download did not finish in 45s')), 45_000);
    manager.on('completed', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const task = manager.createTask({ url: `http://127.0.0.1:${port}/payload.bin` });
  manager.start(task.id);
  await finished;

  const done = manager.getTask(task.id);
  if (!done) throw new Error('task disappeared');
  if (done.status !== 'completed') throw new Error(`status=${done.status}, error=${done.error?.message ?? 'none'}`);
  if (done.totalBytes !== size) throw new Error(`totalBytes ${done.totalBytes} != ${size}`);
  if (done.downloadedBytes !== size) throw new Error(`downloadedBytes ${done.downloadedBytes} != ${size}`);
  if (!fs.existsSync(done.savePath)) throw new Error('file was not written');

  const actual = crypto.createHash('sha256').update(fs.readFileSync(done.savePath)).digest('hex');
  if (actual !== expected) throw new Error('content hash mismatch — the file is corrupt');

  const segments = done.segments;
  if (segments.length < 2) throw new Error(`expected multiple segments, got ${segments.length}`);
  const covered = segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
  if (covered !== size) throw new Error(`segments cover ${covered}, expected ${size}`);
  for (const s of segments) {
    const segTotal = s.end - s.start + 1;
    if (s.downloaded !== segTotal) throw new Error(`segment ${s.index} incomplete: ${s.downloaded}/${segTotal}`);
  }
  if (done.categoryId !== 'completed') throw new Error('completed task must move to the completed category');

  console.log(
    `✔ INTEGRATION OK: ${size} bytes, ${segments.length} segments, hash verified, file=${path.basename(done.savePath)}`,
  );

  // Persistence: the state file must round-trip the completed task.
  await manager.saveNow();
  const reloaded = new TaskManager({
    settings,
    queues,
    schedules: [],
    storagePath: path.join(workDir, 'state.json'),
  });
  await reloaded.load();
  const after = reloaded.getTask(task.id);
  if (!after) throw new Error('task was not persisted');
  if (after.status !== 'completed') throw new Error(`persisted status=${after.status}`);
  if (after.totalBytes !== size) throw new Error('persisted size changed');
  console.log('✔ PERSISTENCE OK: completed task survived a save/load cycle');

  await manager.dispose();
  await reloaded.dispose();
  server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log('ALL INTEGRATION CHECKS PASSED');
}

main().catch((err) => {
  console.error('INTEGRATION FAILED:', err);
  process.exitCode = 1;
});
