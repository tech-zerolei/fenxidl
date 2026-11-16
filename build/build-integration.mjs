import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['src/test/integration.ts'],
  bundle: true, platform: 'node', target: ['node20'], format: 'esm',
  outfile: 'dist/test/integration.mjs',
  external: ['electron'],
  logLevel: 'info',
});
