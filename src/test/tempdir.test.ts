/**
 * Verify the temp-directory staging path: partial data lives in the temp
 * folder during transfer and is promoted to the final path on completion.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { TaskManager } from '../main/task-manager';
import { defaultSettings } from '../main/settings';
import type { Queue } from '../shared/types';

test('downloads stage in the temp directory and land at the final path', async () => {
  const size = 1 * 1024 * 1024 + 321;
  const body = crypto.randomBytes(size);
  const expected = crypto.createHash('sha256').update(body).digest('hex');

  const server = http.createServer((req, res) => {
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  const finalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxidl-final-'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxidl-temp-'));

  const settings = defaultSettings();
  settings.defaultDirectory = finalDir;
  settings.categories = settings.categories.map((c) => ({ ...c, directory: finalDir }));
  settings.tempDirectory = tempDir;
  settings.defaultConnections = 4;

  const queues: Queue[] = [{ id: 'primary', name: 'Main', concurrency: 2, isPrimary: true }];
  const manager = new TaskManager({
    settings,
    queues,
    schedules: [],
    storagePath: path.join(finalDir, 'state.json'),
  });
  await manager.load();

  const done = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 40_000);
    manager.on('completed', () => {
      clearTimeout(t);
      resolve();
    });
  });

  const task = manager.createTask({ url: `http://127.0.0.1:${port}/staged.bin` });
  manager.start(task.id);
  await done;

  const finalTask = manager.getTask(task.id);
  assert.equal(finalTask?.status, 'completed');
  assert.ok(fs.existsSync(finalTask!.savePath), 'final file must exist');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(finalTask!.savePath)).digest('hex');
  assert.equal(hash, expected, 'promoted file must be byte-identical');

  // The temp directory must be empty of our staged file after promotion.
  const leftovers = fs.readdirSync(tempDir).filter((f) => f.endsWith('.part'));
  assert.equal(leftovers.length, 0, `staged file was not cleaned up: ${leftovers.join(',')}`);

  await manager.dispose();
  server.close();
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});
