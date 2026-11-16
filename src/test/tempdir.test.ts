/**
 * Verify the temp-directory staging path: partial data lives in the temp
 * folder during transfer and is promoted to the final path on completion.
 *
 * Both directories come from `mkdtempSync` so the test never touches the shared
 * `os.tmpdir()/FenxiDL` staging directory (which may be owned by root on a
 * multi-user machine). Cleanup runs in `finally`, including the failure path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { TaskManager } from '../main/task-manager';
import { defaultSettings } from '../main/settings';
import type { AppSettings, Queue } from '../shared/types';
import { createWorkspace } from './harness';

/** Upper bound for the transfer; previously 40s. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

function makeServer(body: Buffer): http.Server {
  return http.createServer((req, res) => {
    const range = req.headers.range;
    if (typeof range === 'string') {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': String(slice.length),
          'Content-Type': 'application/octet-stream',
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, { 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
}

test('downloads stage in the temp directory and land at the final path', async () => {
  const size = 1 * 1024 * 1024 + 321;
  const body = crypto.randomBytes(size);
  const expected = crypto.createHash('sha256').update(body).digest('hex');

  const workspace = createWorkspace('fenxidl-temp');
  const server = makeServer(body);
  let manager: TaskManager | null = null;

  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const settings: AppSettings = defaultSettings();
    settings.defaultDirectory = workspace.finalDir;
    settings.categories = settings.categories.map((c) => ({ ...c, directory: workspace.finalDir }));
    settings.tempDirectory = workspace.tempDir;
    settings.defaultConnections = 4;

    const queues: Queue[] = [{ id: 'primary', name: 'Main', concurrency: 2, isPrimary: true }];
    manager = new TaskManager({
      settings,
      queues,
      schedules: [],
      storagePath: workspace.storagePath,
    });
    await manager.load();

    const created = manager.createTask({ url: `http://127.0.0.1:${port}/staged.bin` });
    const done = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const current = manager?.getTask(created.id);
        reject(
          new Error(
            `download did not finish in ${DOWNLOAD_TIMEOUT_MS}ms — ` +
              `status=${current?.status ?? 'missing'} ` +
              `downloaded=${current?.downloadedBytes ?? 0}/${current?.totalBytes ?? 0} ` +
              `error=${current?.error?.message ?? 'none'}`,
          ),
        );
      }, DOWNLOAD_TIMEOUT_MS);
      manager!.on('completed', () => {
        clearTimeout(t);
        resolve();
      });
    });

    manager.start(created.id);
    await done;

    const finalTask = manager.getTask(created.id);
    assert.equal(finalTask?.status, 'completed');
    assert.ok(fs.existsSync(finalTask!.savePath), 'final file must exist');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(finalTask!.savePath)).digest('hex');
    assert.equal(hash, expected, 'promoted file must be byte-identical');

    // The temp directory must be empty of our staged file after promotion.
    const leftovers = fs.readdirSync(workspace.tempDir).filter((f) => f.endsWith('.part'));
    assert.equal(leftovers.length, 0, `staged file was not cleaned up: ${leftovers.join(',')}`);
    assert.ok(fs.existsSync(path.join(workspace.finalDir)), 'final directory must survive');
  } finally {
    if (manager) await manager.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    workspace.remove();
  }
});
