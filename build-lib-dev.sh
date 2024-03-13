#!/bin/sh

mkdir -p node_modules/single-file-core
cp -R ../single-file-core/* node_modules/single-file-core

echo "
import { build } from 'npm:esbuild';

await build({
  entryPoints: [
    'node_modules/single-file-core/single-file.js'
  ],
  bundle: true,
  globalName: 'singlefile',
  outdir: 'lib/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    'node_modules/single-file-core/single-file-bootstrap.js'
  ],
  bundle: true,
  globalName: 'singlefileBootstrap',
  outdir: 'lib/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    'node_modules/single-file-core/single-file-hooks-frames.js'
  ],
  bundle: true,
  outdir: 'lib/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    'node_modules/single-file-core/vendor/zip/zip.min.js'
  ],
  bundle: true,
  globalName: 'zip',
  outdir: 'lib/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

const SCRIPTS = [
	'lib/single-file.js',
	'lib/single-file-bootstrap.js',
	'lib/single-file-hooks-frames.js',
	'lib/zip.min.js'
];

let script = '';
const scripts = SCRIPTS.map(script => Deno.readTextFile(new URL(script, import.meta.url)));
const sources = await Promise.all(scripts);
script += 'const script = ' + JSON.stringify(sources.join(';')) + ';';
const hookScript = await Deno.readTextFile(new URL('lib/single-file-hooks-frames.js', import.meta.url));
script += 'const hookScript = ' + JSON.stringify(hookScript) + ';';
const zipScript = await Deno.readTextFile(new URL('lib/zip.min.js', import.meta.url));
script += 'const zipScript = ' + JSON.stringify(zipScript) + ';';
script += 'export { script, zipScript, hookScript };';
await Deno.writeTextFile(new URL('lib/single-file-bundle.js', import.meta.url), script)
await Promise.all(SCRIPTS.map(script => Deno.remove(script)));
await Deno.remove('lib/single-file-hooks-frames.js');
" |  deno run --allow-read --allow-write --allow-net --allow-run --allow-env --lock=node_modules/deno.lock.tmp -

rm -rf node_modules