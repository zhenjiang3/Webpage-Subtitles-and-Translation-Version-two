'use strict';
/**
 * Sharp 兼容占位实现（Zero-API 方案 A 专用）
 * ============================================
 * V1 仅做文本翻译（NLLB-200 纯文本），不使用 @xenova/transformers 的图像流水线。
 * 但 Xenova 在 src/utils/image.js 顶层做了：
 *   import sharp from 'sharp';
 *   if (sharp) { /* Node 环境，使用 sharp 读图 *\/ }
 *
 * 只要 sharp 「能被 import 成功、且返回 truthy 值、且 .format / .versions 等静态属性能读」，
 * 翻译 pipeline 就能正常初始化。真正的 img.metadata() / .toBuffer() 在翻译路径中绝不会被调用。
 * 如果未来真的走到了图像处理路径，这里会抛清晰错误。
 *
 * 导出同时兼容：
 *   - ESM default:  import sharp from 'sharp'
 *   - ESM named:    import { Sharp } from 'sharp'  (Node CJS interop: 取 module.exports 的属性)
 *   - CJS require:  const sharp = require('sharp')
 */

// ---- 链式 stub：返回自身的 Proxy，防止 sharp(foo).resize().rotate() 形式崩 ----
function createChainable(customMethods) {
  const base = Object.assign(Object.create(null), customMethods || {});
  const proxy = new Proxy(base, {
    get(t, prop, rcv) {
      const k = String(prop);
      if (k === 'then' || k === 'catch' || k === 'finally') return undefined; // 防止误识别为 Promise
      if (Object.prototype.hasOwnProperty.call(t, k)) return Reflect.get(t, k, rcv);
      return function stubChain() { return proxy; };
    },
  });
  return proxy;
}

const REJECT_MSG_HINT =
  '[sharp-shim] 当前运行路径调用了 sharp 图像 API，但 V1 方案 A 未安装真实 sharp 原生二进制。\n' +
  '  若需要图像处理能力，请在 PowerShell 执行：\n' +
  '    pnpm --filter @app/web rebuild sharp\n' +
  '  或移除根 package.json 中 pnpm.overrides 对 sharp 的 link 覆盖后重新 pnpm install。';

function sharpConstructor() {
  return createChainable({
    toBuffer()   { return Promise.reject(new Error(REJECT_MSG_HINT + '\n  方法：toBuffer')); },
    toFile()     { return Promise.reject(new Error(REJECT_MSG_HINT + '\n  方法：toFile')); },
    metadata()   { return Promise.reject(new Error(REJECT_MSG_HINT + '\n  方法：metadata')); },
    stats()      { return Promise.reject(new Error(REJECT_MSG_HINT + '\n  方法：stats')); },
    arrayBuffer(){ return Promise.reject(new Error(REJECT_MSG_HINT + '\n  方法：arrayBuffer')); },
    clone() { return this; },
    pipe()  { return this; },
  });
}

// 顶层静态 API
sharpConstructor.Sharp         = function SharpCtor() { return sharpConstructor.apply(void 0, arguments); };
sharpConstructor.default       = sharpConstructor; // 部分 CJS 消费者再取 .default
sharpConstructor.concurrency   = function concurrency(n) { if (n !== undefined) return sharpConstructor; return 1; };
sharpConstructor.counters      = function counters()    { return { process: 0, queue: 0 }; };
sharpConstructor.simd          = function simd()        { return sharpConstructor; };
sharpConstructor.cache         = function cacheFn(v)    { if (v === undefined) return { memory: 0, files: 0, items: 0 }; return sharpConstructor; };
sharpConstructor.queue         = function queue()       { return 0; };
sharpConstructor.versions      = { libvips: '0.0.0-shim', sharp: '0.32.6-shim', vips: '0.0.0-shim' };
// Xenova RawImage 会枚举 sharp.format 判断 MIME
sharpConstructor.format        = Object.freeze({
  jpeg: { id: 'jpeg' }, png:  { id: 'png'  }, webp: { id: 'webp' },
  avif: { id: 'avif' }, gif:  { id: 'gif'  }, tiff: { id: 'tiff' },
});
// bool / truthy check：sharpConstructor ≠ undefined
// (我们直接导出构造函数本身，import sharp from 'sharp' 拿到的就是 sharpConstructor，天然 truthy)

module.exports         = sharpConstructor;
module.exports.default = sharpConstructor; // ESM → CJS interop 兜底：有些 bundler 会读 .default
module.exports.Sharp   = sharpConstructor.Sharp; // named import interop
