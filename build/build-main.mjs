/**
 * Build the Electron main process bundles (main + preload).
 *
 * Sourcemaps: off for release builds (keeps the packaged app small and does not
 * ship TypeScript sources), on for development. Control it with:
 *   FENXIDL_SOURCEMAP=1        force on (external .js.map next to the bundle)
 *   FENXIDL_SOURCEMAP=inline   inline as a data URL
 *   FENXIDL_SOURCEMAP=0        force off
 *   FENXIDL_DEV=1              on, the development default
 */
import * as esbuild from 'esbuild';
import { sourcemapMode, sourcemapLabel } from './env.mjs';

const map = sourcemapMode();

const shared = {
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'cjs',
  sourcemap: map,
  logLevel: 'info',
  external: ['electron'],
};

await esbuild.build({
  ...shared,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
});

await esbuild.build({
  ...shared,
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist/main/preload.js',
});

console.log(`main + preload built (sourcemap=${sourcemapLabel(map)})`);
