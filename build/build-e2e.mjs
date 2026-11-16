import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['src/test/e2e-download.ts'],
  bundle: true, platform: 'node', target: ['node20'], format: 'esm',
  outfile: 'dist/test/e2e-download.mjs', logLevel: 'info',
});
