// Bundles src/ into app/app.js (one classic script, so app/index.html also works when opened straight from disk).
// `node scripts/build.mjs --watch` rebuilds on change.
import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', target: 'es2020', outfile: 'app/app.js',
  minify: !watch, sourcemap: watch, define: { __APP_VERSION__: JSON.stringify(version) }, logLevel: 'info',
};
if (watch) await (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
