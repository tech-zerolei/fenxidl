import * as esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

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
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
console.log('renderer built');
