/**
 * Build every unit test file.
 *
 * The entry list is DISCOVERED from `src/test/*.test.ts` instead of being
 * hard-coded. The previous hard-coded list is why `e2e-download.ts` and
 * `integration.ts` silently fell out of `npm test`: adding a file to the folder
 * did not add it to the script.
 *
 * Output: one `dist/test/<name>.test.mjs` per source file, run by
 * `node --test dist/test/`.
 */
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { sourcemapMode, sourcemapLabel } from './env.mjs';

const map = sourcemapMode();

const entries = readdirSync('src/test')
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

if (entries.length === 0) {
  console.error('build-test: no src/test/*.test.ts found');
  process.exit(1);
}

const common = {
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'esm',
  sourcemap: map,
  logLevel: 'info',
  // Every test bundle may touch settings/task-manager, which import electron.
  external: ['electron'],
};

await Promise.all(
  entries.map((file) =>
    esbuild.build({
      ...common,
      entryPoints: [`src/test/${file}`],
      outfile: `dist/test/${file.replace(/\.ts$/, '.mjs')}`,
    }),
  ),
);

console.log(`unit tests built: ${entries.length} file(s) (sourcemap=${sourcemapLabel(map)})`);
