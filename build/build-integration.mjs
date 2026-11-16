/**
 * Build the TaskManager integration script (`npm run test:integration` runs it).
 *
 * This bundle pulls in the real `TaskManager`, `download-engine` and `settings`,
 * so it needs `electron` externalised (settings imports it for app paths).
 */
import * as esbuild from 'esbuild';
import { sourcemapMode, sourcemapLabel } from './env.mjs';

const map = sourcemapMode();

await esbuild.build({
  entryPoints: ['src/test/integration.ts'],
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'esm',
  sourcemap: map,
  external: ['electron'],
  outfile: 'dist/test/integration.mjs',
  logLevel: 'info',
});

console.log(`integration script built (sourcemap=${sourcemapLabel(map)})`);
