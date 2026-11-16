/**
 * Build the renderer bundle and copy the HTML shell.
 *
 * Sourcemaps follow the same policy as the main build (see build/env.mjs):
 * release builds keep them off, `FENXIDL_DEV=1` (or `npm run build:dev`) turns
 * them on so a React stack trace in the DevTools points back to the .tsx source.
 */
import * as esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { devMode, sourcemapMode, sourcemapLabel } from './env.mjs';

const map = sourcemapMode();
const dev = devMode();

await mkdir('dist/renderer', { recursive: true });

await esbuild.build({
  entryPoints: ['src/renderer/main.tsx'],
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  format: 'iife',
  outfile: 'dist/renderer/bundle.js',
  loader: { '.css': 'css' },
  jsx: 'automatic',
  minify: !dev,
  sourcemap: map,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
console.log(`renderer built (minify=${dev ? 'off' : 'on'}, sourcemap=${sourcemapLabel(map)})`);
