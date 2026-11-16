/**
 * Build the end-to-end download script (`npm run test:e2e` runs it after this).
 *
 * `electron` is externalised: the test bundle imports `../main/download-engine`,
 * which resolves settings through the electron module graph.
 */
import * as esbuild from 'esbuild';
import { sourcemapMode, sourcemapLabel } from './env.mjs';

const map = sourcemapMode();

await esbuild.build({
  entryPoints: ['src/test/e2e-download.ts'],
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'esm',
  sourcemap: map,
  external: ['electron'],
  outfile: 'dist/test/e2e-download.mjs',
  logLevel: 'info',
});

console.log(`e2e script built (sourcemap=${sourcemapLabel(map)})`);
