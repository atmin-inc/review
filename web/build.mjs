// Builds web/dist for the review worker. Everything under /assets/ is served with an immutable
// cache header, so every file there carries a content hash. index.html has no inline script or
// style: the worker's CSP allows scripts and fonts from 'self' only.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toWoff2 } from './scripts/woff2.mjs';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const dist = 'dist', assets = join(dist, 'assets');
rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
function emit(name, bytes) {
  const extension = extname(name);
  const file = `${basename(name, extension)}-${hash(bytes)}${extension}`;
  writeFileSync(join(assets, file), bytes);
  return `/assets/${file}`;
}

// Scripts. Logos imported from JSX become hashed files through the file loader.
const result = await build({
  entryPoints: { app: 'src/main.jsx', 'color-scheme': 'src/color-scheme.js' },
  bundle: true, minify: true, format: 'iife', jsx: 'automatic', target: 'es2022',
  outdir: assets, entryNames: '[name]-[hash]', assetNames: '[name]-[hash]', publicPath: '/assets/',
  loader: { '.svg': 'file' }, define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true, logLevel: 'warning',
});
const script = entry => {
  const [path] = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint === entry);
  return `/${relative(dist, path)}`;
};

// Fonts: the kit's pinned TTFs, converted because the worker serves fonts only as WOFF2.
const fonts = {};
for (const file of readdirSync('fonts').filter(name => name.endsWith('.ttf'))) {
  fonts[file] = emit(file.replace(/\.ttf$/, '.woff2'), toWoff2(readFileSync(join('fonts', file))));
}

// Styles: theme.css keeps the kit's relative font URLs; point them at the hashed WOFF2 files.
const temporary = join(dist, 'tailwind.css');
execFileSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/app.css', '-o', temporary, '--minify'], { stdio: ['ignore', 'ignore', 'inherit'] });
let css = readFileSync(temporary, 'utf8');
rmSync(temporary);
css = css.replace(/url\((['"]?)\.\.\/fonts\/([\w-]+\.ttf)\1\)/g, (_, quote, file) => {
  if (!fonts[file]) throw new Error(`Missing font ${file}`);
  return `url(${fonts[file]}) format("woff2")`;
});
if (/\.ttf/.test(css)) throw new Error('A font URL was not rewritten');
css = `/*! Geist and Geist Mono: Copyright 2024 The Geist Project Authors, SIL Open Font License 1.1 */\n${css}`;
const stylesheet = emit('app.css', css);

// Icons: hashed copies for the page, plus an unhashed /favicon.ico for browsers that ask for it.
const favicon = emit('favicon.svg', readFileSync('brand/favicon.svg'));
const touchIcon = emit('apple-touch-icon.png', readFileSync('brand/apple-touch-icon.png'));
copyFileSync('brand/favicon.ico', join(dist, 'favicon.ico'));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>atmin review</title>
<meta name="description" content="atmin reviews pull requests on GitHub and comments with findings.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="${favicon}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${touchIcon}">
<link rel="preload" href="${fonts['Geist-Regular.ttf']}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${fonts['Geist-Medium.ttf']}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${stylesheet}">
<script src="${script('src/color-scheme.js')}"></script>
<script src="${script('src/main.jsx')}" defer></script>
</head>
<body>
<div id="root"></div>
<noscript>atmin review needs JavaScript. Enable it and reload this page.</noscript>
</body>
</html>
`;
if (/<script(?![^>]*\bsrc=)|<style|\sstyle=/i.test(html)) throw new Error('index.html must not contain inline scripts or styles');
writeFileSync(join(dist, 'index.html'), html);

const files = readdirSync(assets);
const served = /\.(html|js|css|svg|png|ico|woff2|webmanifest)$/;
for (const file of files) if (!served.test(file)) throw new Error(`The worker does not serve ${file}`);
console.log(`Built ${dist}/index.html and ${files.length} hashed assets.`);
