import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: ['node20'],
  format: 'cjs',
  sourcemap: false,
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

console.log('main + preload built');
