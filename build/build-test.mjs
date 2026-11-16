import * as esbuild from 'esbuild';
const common = { bundle: true, platform: 'node', target: ['node20'], format: 'esm', logLevel: 'info' };
await esbuild.build({ ...common, entryPoints: ['src/test/engine.test.ts'], outfile: 'dist/test/engine.test.mjs' });
await esbuild.build({ ...common, entryPoints: ['src/test/sniffer.test.ts'], outfile: 'dist/test/sniffer.test.mjs' });
await esbuild.build({ ...common, entryPoints: ['src/test/proxy.test.ts'], outfile: 'dist/test/proxy.test.mjs' });
await esbuild.build({ ...common, entryPoints: ['src/test/tempdir.test.ts'], outfile: 'dist/test/tempdir.test.mjs', external: ['electron'] });
