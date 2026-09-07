#!/usr/bin/env node
/**
 * esbuild 打包脚本：把 src/*.ts 编译成 MV3 扩展可加载的 dist/*.js
 *   content.ts    → dist/content.js
 *   background.ts → dist/background.js
 *   popup.ts      → dist/popup.js
 * 同时复制 manifest.json 和 popup.html 到 dist/。
 * 用法：
 *   pnpm --filter @app/extension build          # 一次性构建
 *   pnpm --filter @app/extension watch          # 监听改动
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const watch = process.argv.includes('--watch');

const entries = ['content.ts', 'background.ts', 'popup.ts'];

// 复制静态资源（manifest + popup.html + icons）
function copyStatic() {
  fs.mkdirSync(DIST, { recursive: true });
  const iconsDst = path.join(DIST, 'icons');
  fs.mkdirSync(iconsDst, { recursive: true });
  for (const f of ['manifest.json', 'popup.html']) {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, f));
  }
  const iconsSrc = path.join(__dirname, 'icons');
  if (fs.existsSync(iconsSrc)) {
    for (const f of fs.readdirSync(iconsSrc)) {
      fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsDst, f));
    }
  }
}

/** 简单生成纯色 PNG 占位图标（如用户没有提供真实图标） */
function ensureIcons() {
  const iconsDir = path.join(__dirname, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });
  // 极简 1x1 蓝色 PNG（base64），不同尺寸复用同一张
  const png =
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    );
  for (const size of [16, 48, 128]) {
    const p = path.join(iconsDir, `icon${size}.png`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, png);
  }
}

ensureIcons();
copyStatic();

const buildOptions = {
  entryPoints: entries.map((e) => path.join(SRC, e)),
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  outdir: DIST,
  platform: 'browser',
  logLevel: 'info',
  // service worker 用 module 类型，但 esbuild bundle 后无外部 import，IIFE 安全
  sourcemap: false,
  write: true,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  // eslint-disable-next-line no-console
  console.log('[esbuild] watching for changes...');
} else {
  await esbuild.build(buildOptions);
  // eslint-disable-next-line no-console
  console.log('[esbuild] build complete →', DIST);
}
