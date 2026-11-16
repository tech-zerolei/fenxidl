/**
 * Integration test: drive the REAL TaskManager against a REAL HTTP server and
 * verify a complete download, hash equality, segment accounting and the
 * completed-state transition.
 *
 * Portability: the workspace (destination, staging temp dir, persistence file) is
 * allocated with `mkdtempSync`, so the run never depends on the host-wide
 * `os.tmpdir()/FenxiDL` directory being writable.
 *
 * Termination: `runScript` runs `cleanup()` on every path, disposes both
 * TaskManagers (which stops the 2s/30s/60s timers) and exits with a definite
 * code. `FENXIDL_TEST_FORCE_FAIL=1` exercises the failure path on purpose.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { TaskManager } from '../main/task-manager';
import { defaultSettings } from '../main/settings';
import type { AppSettings, Queue } from '../shared/types';
import { createWorkspace, forcedFailure, runScript, type TempWorkspace } from './harness';

/** Upper bound for the download itself (was 45s; raised after CI flakes). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Upper bound for the whole script, enforced by the watchdog. */
const SCRIPT_TIMEOUT_MS = 120_000;

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

/** Everything the run has to release, registered as soon as it exists. */
interface Resources {
  server: http.Server | null;
  manager: TaskManager | null;
  reloaded: TaskManager | null;
  workspace: TempWorkspace | null;
}

async function main(): Promise<void> {
  const resources: Resources = { server: null, manager: null, reloaded: null, workspace: null };
  const logs: string[] = [];

  await runScript({
    name: 'INTEGRATION',
    hardTimeoutMs: SCRIPT_TIMEOUT_MS,
    cleanup: async () => {
      const { server, manager, reloaded, workspace } = resources;
      // Dispose first: it stops the timers that used to keep the loop alive.
      for (const m of [manager, reloaded]) {
        if (!m) continue;
        try {
          await m.dispose();
        } catch (err) {
          console.error(`INTEGRATION: dispose failed: ${(err as Error).message}`);
        }
      }
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      workspace?.remove();
    },
    body: async () => {
      const size = 6 * 1024 * 1024 + 777;
      const body = crypto.randomBytes(size);
      const expected = crypto.createHash('sha256').update(body).digest('hex');

      const workspace = createWorkspace('fenxidl-int');
      resources.workspace = workspace;

      const server = makeServer(body);
      resources.server = server;
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;

      const settings: AppSettings = defaultSettings();
      settings.defaultDirectory = workspace.finalDir;
      settings.categories = settings.categories.map((c) => ({ ...c, directory: workspace.finalDir }));
      // Explicit staging directory: never inherit the shared os.tmpdir()/FenxiDL.
      settings.tempDirectory = workspace.tempDir;
      settings.defaultConnections = 6;
      settings.showStartDialog = false;

      const queues: Queue[] = [{ id: 'primary', name: 'Main', concurrency: 2, isPrimary: true }];
      const manager = new TaskManager({
        settings,
        queues,
        schedules: [],
        storagePath: workspace.storagePath,
      });
      resources.manager = manager;
      manager.on('log', (line: string) => logs.push(line));
      manager.on('changed', () => {
        for (const t of manager.listTasks()) {
          const line = `[state] ${t.status} ${t.downloadedBytes}/${t.totalBytes}${
            t.error ? ` err=${t.error.message}` : ''
          }`;
          // Keep the last few state lines for failure diagnostics only.
          if (logs[logs.length - 1] !== line) logs.push(line);
        }
      });
      await manager.load();

      if (forcedFailure()) {
        throw new Error('forced failure (FENXIDL_TEST_FORCE_FAIL=1): checking cleanup and exit code');
      }

      const task = manager.createTask({ url: `http://127.0.0.1:${port}/payload.bin` });

      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const current = manager.getTask(task.id);
          const tail = logs.slice(-8).join('\n  ');
          reject(
            new Error(
              `download did not finish in ${DOWNLOAD_TIMEOUT_MS}ms — ` +
                `status=${current?.status ?? 'missing'} ` +
                `downloaded=${current?.downloadedBytes ?? 0}/${current?.totalBytes ?? 0} ` +
                `error=${current?.error?.message ?? 'none'}\n  recent state:\n  ${tail}`,
            ),
          );
        }, DOWNLOAD_TIMEOUT_MS);
        manager.on('completed', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      manager.start(task.id);
      await finished;

      const done = manager.getTask(task.id);
      if (!done) throw new Error('task disappeared');
      if (done.status !== 'completed') {
        throw new Error(`status=${done.status}, error=${done.error?.message ?? 'none'}`);
      }
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
        storagePath: workspace.storagePath,
      });
      resources.reloaded = reloaded;
      await reloaded.load();
      const after = reloaded.getTask(task.id);
      if (!after) throw new Error('task was not persisted');
      if (after.status !== 'completed') throw new Error(`persisted status=${after.status}`);
      if (after.totalBytes !== size) throw new Error('persisted size changed');
      console.log('✔ PERSISTENCE OK: completed task survived a save/load cycle');
      console.log('ALL INTEGRATION CHECKS PASSED');
    },
  });
}

void main();
