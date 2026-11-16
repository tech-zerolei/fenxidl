/**
 * Shared scaffolding for the process-level test scripts (integration / e2e).
 *
 * Why this file exists:
 * - The integration test used to inherit `settings.tempDirectory` from
 *   `defaultSettings()`, i.e. `os.tmpdir()/FenxiDL`. That directory is created by
 *   root on some machines (multi-user Linux, or after a `sudo` run) and then a
 *   normal user can never write into it again, so the test failed on a perfectly
 *   healthy build. Every script now allocates its own throw-away directories.
 * - The failure path used to leave `TaskManager` timers (save 2s, scheduler 30s,
 *   quota 60s) alive, so the process never exited and CI hung until the job
 *   timeout (observed: `exit 124`). Cleanup is now centralised in `finally`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A disposable set of directories used by one test run. */
export interface TempWorkspace {
  /** Root of the workspace; contains every other directory. */
  root: string;
  /** Final destination directory for downloaded files. */
  finalDir: string;
  /** Staging directory handed to `settings.tempDirectory`. */
  tempDir: string;
  /** Persistence file used by TaskManager. */
  storagePath: string;
  /** Remove the whole workspace; never throws. */
  remove(): void;
}

/** Create an isolated, writable workspace under the OS temp directory. */
export function createWorkspace(prefix: string): TempWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const finalDir = path.join(root, 'downloads');
  const tempDir = path.join(root, 'tmp');
  fs.mkdirSync(finalDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  return {
    root,
    finalDir,
    tempDir,
    storagePath: path.join(root, 'state.json'),
    remove() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (err) {
        console.warn(`cleanup: could not remove ${root}: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Run one async test body with cleanup that always executes, then exit the
 * process with a deterministic code.
 *
 * A hard watchdog guarantees the process never outlives `hardTimeoutMs` even if
 * a future change leaks a handle again: the run is reported as failed instead of
 * hanging until the CI job timeout.
 */
export async function runScript(options: {
  /** Human readable name used in log lines, e.g. `INTEGRATION`. */
  name: string;
  /** Body of the test; throwing marks the run as failed. */
  body: () => Promise<void>;
  /** Orderly cleanup: dispose managers, close servers, remove directories. */
  cleanup: () => Promise<void> | void;
  /** Absolute upper bound for the whole run. */
  hardTimeoutMs: number;
}): Promise<never> {
  const { name, body, cleanup, hardTimeoutMs } = options;
  const startedAt = Date.now();
  const watchdog = setTimeout(() => {
    console.error(`${name} TIMEOUT: still running after ${hardTimeoutMs}ms, forcing exit 1`);
    process.exit(1);
  }, hardTimeoutMs);

  let code = 0;
  try {
    await body();
  } catch (err) {
    code = 1;
    console.error(`${name} FAILED:`, err instanceof Error ? (err.stack ?? err.message) : err);
  } finally {
    clearTimeout(watchdog);
    try {
      await cleanup();
    } catch (err) {
      code = 1;
      console.error(`${name} CLEANUP FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`${name} EXIT ${code} after ${Date.now() - startedAt}ms`);
  // Exit explicitly: a leaked handle must not turn a pass into a hang.
  process.exit(code);
}

/** Format a promise rejection / task state into one readable line. */
export function describeState(label: string, value: unknown): string {
  try {
    return `${label}=${JSON.stringify(value)}`;
  } catch {
    return `${label}=<unserialisable>`;
  }
}

/** True when the failure-injection switch is set (used to prove cleanup works). */
export function forcedFailure(): boolean {
  return process.env.FENXIDL_TEST_FORCE_FAIL === '1';
}
