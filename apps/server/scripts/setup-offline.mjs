#!/usr/bin/env node
/**
 * 一键下载「方案 A：免费零 API」所需要的 whisper.cpp Windows 预编译包 + ggml-small 模型
 *
 * 用途：V1 用户不想申请任何 API Key 时，运行：
 *         cd apps/server
 *         pnpm setup:offline
 *       本脚本会：
 *         1. 从 ggml-org/whisper.cpp GitHub Releases 下载 whisper-bin-x64.zip（CPU 版）
 *         2. 解压到 apps/server/tools/whisper/（得到 whisper-cli.exe + 若干 dll）
 *         3. 从 HuggingFace 下载 ggml-small.bin（487MB，中文识别精度最佳体积权衡）
 *            保存到 apps/server/tools/whisper/models/
 *         4. 打印出 .env.local 建议配置（可选：直接写入 .env.local）
 *
 * 注：本脚本不依赖任何第三方 npm 包，全部使用 Node 22+ 内置模块。
 *     Windows 下默认用 PowerShell Expand-Archive 解压 zip；
 *     若 PowerShell 不可用，将尝试 node:zlib（不支持 deflate64 → 失败兜底提示）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..'); // apps/server/
const TOOLS_DIR = path.join(SERVER_ROOT, 'tools');
const WHISPER_DIR = path.join(TOOLS_DIR, 'whisper');
const MODELS_DIR = path.join(WHISPER_DIR, 'models');
const ZIP_PATH = path.join(os.tmpdir(), `whisper-bin-x64-${Date.now()}.zip`);
const MODEL_PATH = path.join(MODELS_DIR, 'ggml-small.bin');

// —— 可下载源（官方 + 国内镜像/代理，做容错；顺序即优先级）——
const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const WHISPER_ZIP_FALLBACK = 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip';

// GitHub 国内加速代理（注意代理 URL 规则：直接把原始 https://github.com/... 接在代理域名后面即可）
// 挑选历史上在中国大陆可用率较高且证书/DNS 正常的镜像；如果某个镜像在运行时挂掉（超时/证书过期），
// 它会在本 URL 尝试后失败，并继续下一个，不会卡住整条链路。
const GITHUB_PROXY_GHFAST = 'https://ghfast.top/';
const GITHUB_PROXY_99988866 = 'https://gh.api.99988866.xyz/';
const GITHUB_PROXY_MIRROR = 'https://mirror.ghproxy.com/';

// HuggingFace 模型：官方 + 国内镜像
const HUGGINGFACE_MODEL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';
const HUGGINGFACE_MIRROR = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin';
// ModelScope（阿里国内镜像）同模型；如果 HF 直连+镜像都失败时用它兜底
const MODELSCOPE_MODEL =
  'https://www.modelscope.cn/models/AI-ModelScope/whisper.cpp/resolve/master/ggml-small.bin';

/**
 * 统一错误展开：Node 的 fetch() 失败往往只是 TypeError("fetch failed")，
 * 真正的原因（DNS/超时/证书/代理/ECONNRESET 等）藏在 err.cause / err.cause.cause 里。
 * 这里做递归展开，便于用户定位是证书还是代理还是DNS。
 */
function formatError(err) {
  if (err == null) return String(err);
  const top = err && err.message ? err.message : String(err);
  const parts = [top];
  let cur = err;
  let depth = 0;
  let hasCertIssue = false;
  let hasTimeout = false;
  let hasExpiredCert = false;
  while (cur && cur.cause && depth < 5) {
    cur = cur.cause;
    const seg = [];
    if (cur.code) {
      seg.push(`code=${cur.code}`);
      if (
        cur.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        cur.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        cur.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        cur.code === 'CERT_AUTHORITY_INVALID'
      ) {
        hasCertIssue = true;
      }
      if (cur.code === 'CERT_HAS_EXPIRED') hasExpiredCert = true;
      if (
        cur.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        cur.code === 'ETIMEDOUT' ||
        cur.code === 'ECONNRESET' ||
        cur.code === 'ENOTFOUND'
      ) {
        hasTimeout = true;
      }
    }
    if (cur.message) seg.push(cur.message);
    if (cur.syscall) seg.push(`syscall=${cur.syscall}`);
    if (cur.hostname) seg.push(`host=${cur.hostname}`);
    if (cur.address) seg.push(`addr=${cur.address}`);
    if (seg.length) parts.push('  原因: ' + seg.join(' | '));
    depth += 1;
  }
  if (hasCertIssue) {
    parts.push(
      '\n  📌 这是【系统 TLS 证书不被 Node 默认信任】的典型错误，常见原因：\n' +
        '     - 电脑开启了 360/QQ电脑管家/卡巴斯基 等杀毒软件的「网页防护/HTTPS 扫描」（会替换证书）\n' +
        '     - 处于公司/学校网络，出口网关做了 HTTPS MITM 代理\n' +
        '  ✅ 正确做法：请通过 pnpm script 启动（它已自动加 --use-system-ca 读取 Windows 系统证书库）：\n' +
        '       cd apps/server\n' +
        '       pnpm setup:offline\n' +
        '  ❌ 不要用：node scripts/setup-offline.mjs（裸 node 不带 --use-system-ca，必炸）\n',
    );
  }
  if (hasExpiredCert) {
    parts.push(
      '\n  📌 该下载镜像站点的 HTTPS 证书已经过期（mirror.ghproxy.com / ghproxy.cc 等免费服务经常发生）。\n' +
        '     无需手动处理，脚本会自动尝试下一条镜像链路；\n' +
        '     若所有镜像链路都失败，请直接走文末「手动下载方案」。\n',
    );
  }
  if (hasTimeout) {
    parts.push(
      '\n  📌 连接超时/被重置：这个镜像站从当前网络不可达。\n' +
        '     - 如果你在公司/校园网：通常是 GitHub 海外 IP 被 QoS，脚本会自动切下一个镜像。\n' +
        '     - 如果开启了 VPN/代理软件：尝试临时切换「直连」/「全局」模式再跑一次。\n' +
        '     - 所有链路都超时：直接用文末「手动下载方案」。\n',
    );
  }
  return parts.join('\n');
}

/**
 * 把一个 GitHub 原始下载 URL 变成“代理版”（用于国内网络加速）
 * 例：https://github.com/xxx/yyy/releases/download/v1/whisper-bin-x64.zip
 *  →  https://ghfast.top/https://github.com/xxx/yyy/releases/download/v1/whisper-bin-x64.zip
 */
function throughProxy(proxyBase, rawUrl) {
  if (!proxyBase) return rawUrl;
  return proxyBase.replace(/\/$/, '') + '/' + rawUrl;
}

/**
 * 给一个候选 URL 列表做代理扩展：
 *   [官方直连, 兜底直连]  →  [官方直连, ghfast代理(官方), 99988866代理(官方), mirror代理(官方), 兜底直连, ...]
 * 这样 1 个 30MB 的 zip 最多有 8 条下载路径，极大提升国内网络成功率。
 */
function withGithubProxies(urls) {
  const proxies = [undefined, GITHUB_PROXY_GHFAST, GITHUB_PROXY_99988866, GITHUB_PROXY_MIRROR];
  const result = [];
  for (const u of urls) {
    for (const p of proxies) {
      result.push(throughProxy(p, u));
    }
  }
  // 去重（相同 URL 不重复试）
  return [...new Set(result)];
}

// —— 下载器 2：PowerShell Invoke-WebRequest（Windows 原生 HTTP）——
//    Node fetch（undici）在 Windows 下对「HTTPS + MITM + 大文件」组合非常脆：
//      - 10s 连接超时卡死（UND_ERR_CONNECT_TIMEOUT）
//      - 大文件只下载 8MB 就莫名完成（undici body stream 被 MITM 截断但不报错）
//      - 证书链不兼容（即使 --use-system-ca 也偶发 CERT_HAS_EXPIRED）
//    PowerShell 用系统 WinHTTP/Schannel，读系统证书 + 系统代理，对上面 3 个问题天然免疫。
//    作为每个 URL 的 fallback。
function downloadWithPowerShell(url, dest, sizeHintMB, label) {
  return new Promise((resolve, reject) => {
    // 注意：ProgressPreference='SilentlyContinue' 能让 487MB 文件快 5-10 倍（否则 IWR 每帧重绘进度巨慢）
    const psCmd = [
      `$ErrorActionPreference = 'Stop'`,
      `$ProgressPreference = 'SilentlyContinue'`,
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
      `Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${dest.replace(/'/g, "''")}' -UseBasicParsing`,
    ].join('; ');
    const startTs = Date.now();
    // stdio: pipe 不继承，避免 PowerShell 自己写的一堆输出把我们的格式化进度冲掉
    const child = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 大文件给 15 分钟；比默认长，避免慢网被误杀
      timeout: 15 * 60 * 1000,
    });
    if (child.error) return reject(child.error);
    if (child.status === 0 && fs.existsSync(dest)) {
      const sec = ((Date.now() - startTs) / 1000).toFixed(1);
      const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r  [PowerShell] ${label} 完成 ${mb}MB (${sec}s)   \n`);
      return resolve();
    }
    const stderr = (child.stderr ?? '').toString().trim();
    const stdout = (child.stdout ?? '').toString().trim();
    const msg = [
      `PowerShell IWR 失败（exit=${child.status ?? 'null'}）`,
      stderr ? `  STDERR: ${stderr.split('\n').slice(0, 8).join('\n          ')}` : '',
      stdout ? `  STDOUT: ${stdout.split('\n').slice(0, 8).join('\n          ')}` : '',
    ].filter(Boolean).join('\n');
    reject(new Error(msg));
  });
}

// —— 简易进度条（ETL 风格）——
function makeProgress(label, sizeHintMB) {
  let lastPct = -1;
  let received = 0;
  const startTs = Date.now();
  return (chunkLen) => {
    received += chunkLen;
    const pct = sizeHintMB ? Math.min(99, Math.round((received / (sizeHintMB * 1024 * 1024)) * 100)) : -1;
    if (pct !== -1 && pct !== lastPct) {
      const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
      const mb = (received / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r  ${label}  ${pct}%  (${mb}MB / ${sizeHintMB}MB, ${elapsed}s)   `);
      lastPct = pct;
    }
  };
}

async function fetchWithRedirect(url, options = undefined) {
  // 支持 302 / 301 跟随（GitHub/HF 都有）
  let currentUrl = url;
  let redirects = 0;
  while (redirects < 8) {
    const res = await fetch(currentUrl, { redirect: 'manual', ...(options ?? {}) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirect ${res.status} without Location: ${currentUrl}`);
      currentUrl = new URL(loc, currentUrl).toString();
      redirects += 1;
      continue;
    }
    return { res, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects (>8) for ${url}`);
}

/**
 * 通用下载：对每个 URL 先尝试 Node fetch，失败后在 Windows 下自动 fallback 到 PowerShell Invoke-WebRequest。
 * 原因：Node 的 undici fetch 在 Windows + HTTPS MITM/大文件场景下有几个已知问题（超时/证书/8MB 截断），
 *       而 PowerShell 走系统 WinHTTP/Schannel，天然兼容系统证书与系统代理，下载成功率显著更高。
 */
async function download({ urls, dest, sizeHintMB, label, minSizeMB }) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`✔ ${label} 已存在 (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)}MB)，跳过：${dest}`);
    return;
  }
  const tmp = dest + '.downloading';
  let lastErr = null;
  const canUsePs = process.platform === 'win32';

  function validateSize(file) {
    if (minSizeMB == null) return true;
    if (!fs.existsSync(file)) return false;
    const size = fs.statSync(file).size;
    if (size < minSizeMB * 1024 * 1024) {
      const actualMB = (size / 1024 / 1024).toFixed(1);
      throw new Error(
        `下载文件疑似不完整（仅 ${actualMB}MB，期望至少 ${minSizeMB}MB）。` +
          `常见原因：代理返回了错误页 / 重定向到 HTML 登录页 / 中途断连。自动切换下一条链路……`,
      );
    }
    return true;
  }

  for (const url of urls) {
    // —— 下载器 A：Node fetch（undici）——
    let nodeFailed = false;
    try {
      console.log(`  ▶ 下载 ${label}  →  ${url}`);
      const { res } = await fetchWithRedirect(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const totalLen = res.headers.get('content-length');
      const hintMB = sizeHintMB ?? (totalLen ? Math.round(parseInt(totalLen, 10) / 1024 / 1024) : undefined);
      const onChunk = makeProgress(label, hintMB);
      const writer = fs.createWriteStream(tmp);
      const reader = Readable.fromWeb(res.body);
      reader.on('data', (chunk) => onChunk(chunk.length));
      await pipeline(reader, writer);
      validateSize(tmp); // 抛 → catch → 切 fallback/下一 URL
      fs.renameSync(tmp, dest);
      process.stdout.write('\n');
      const size = fs.statSync(dest).size;
      console.log(`✔ ${label} 完成 (${(size / 1024 / 1024).toFixed(1)}MB)  →  ${dest}`);
      return;
    } catch (e) {
      nodeFailed = true;
      lastErr = e;
      console.warn(`\n⚠ ${label} 从 ${url} 下载失败（Node fetch）：\n${formatError(e)}`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* noop */ }
    }

    // —— 下载器 B（仅 Windows）：同一 URL 立刻换 PowerShell 再试一次 ——
    if (nodeFailed && canUsePs) {
      try {
        console.log(`  ▶ 换 PowerShell 重下 ${label}  →  ${url}`);
        await downloadWithPowerShell(url, tmp, sizeHintMB, label);
        validateSize(tmp);
        fs.renameSync(tmp, dest);
        const size = fs.statSync(dest).size;
        console.log(`✔ ${label} 完成 (${(size / 1024 / 1024).toFixed(1)}MB)  →  ${dest}`);
        return;
      } catch (ePs) {
        lastErr = ePs;
        console.warn(`\n⚠ ${label} 从 ${url} 下载失败（PowerShell 重试）：\n${formatError(ePs)}`);
        try { fs.rmSync(tmp, { force: true }); } catch { /* noop */ }
      }
    }
  }
  throw new Error(`所有 ${label} 下载源全部失败。最后一个错误：\n${formatError(lastErr)}`);
}

/**
 * 解压 zip（Windows 调用 PowerShell Expand-Archive，兼容 whisper-bin-x64 的 deflate64）
 */
function extractZipWindows(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Expand-Archive 失败（退出码 ${r.status ?? 'null'}）`);
  }
}

/**
 * 递归列出 root 下所有文件（含子目录），返回绝对路径数组
 * 用于：不依赖 zip 内部固定目录结构（Release/、whisper-bin-x64/、bin/ 等都能查），
 *      直接按文件名找到 whisper-cli.exe / dll / 模型。
 */
function listAllFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * 把 root 目录下「任意深度的子目录中的文件」全部上移到 root 第一层，
 * 并清空多余的空子目录。这让不同发布结构的 zip 最终得到统一目录：
 *   root/Release/*.exe  →  root/*.exe
 *   root/whisper-bin-x64/*.dll  →  root/*.dll
 *   root/Release/bin/*.pdb  →  root/*.pdb
 */
function flattenAllNestedFiles(root) {
  const files = listAllFiles(root);
  for (const src of files) {
    const rel = path.relative(root, src);
    if (!rel || path.dirname(rel) === '.') continue; // 已经在根层
    const dst = path.join(root, path.basename(src));
    if (fs.existsSync(dst)) {
      // 如果目标已存在且体积更大/相等，保留原文件并删新的；否则覆盖
      const sStat = fs.statSync(src);
      const dStat = fs.statSync(dst);
      if (sStat.size > dStat.size) {
        fs.rmSync(dst, { force: true });
        fs.renameSync(src, dst);
      } else {
        fs.rmSync(src, { force: true });
      }
    } else {
      fs.renameSync(src, dst);
    }
  }
  // 清理空的子目录（从深层开始）
  function removeEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) removeEmptyDirs(full);
    }
    const contents = fs.readdirSync(dir);
    if (contents.length === 0 && dir !== root) {
      try { fs.rmdirSync(dir); } catch { /* noop */ }
    }
  }
  removeEmptyDirs(root);
}

async function resolveLatestWhisperZipUrl() {
  try {
    const { res } = await fetchWithRedirect(WHISPER_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const json = (await res.json()) ?? {};
      const assets = json.assets ?? [];
      const hit = assets.find((a) => typeof a?.name === 'string' && a.name.toLowerCase() === 'whisper-bin-x64.zip');
      if (hit?.browser_download_url) return [hit.browser_download_url, WHISPER_ZIP_FALLBACK];
    }
  } catch (e) {
    console.warn(`⚠ 获取 GitHub Releases 元数据失败，直接用固定 URL。原因：\n${formatError(e)}`);
  }
  return [WHISPER_ZIP_FALLBACK];
}

async function writeEnvLocalIfMissing() {
  const envLocal = path.join(SERVER_ROOT, '.env.local');
  const whisperCliName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const block =
    '\n# =============== 方案 A：免费零 API（whisper.cpp + Xenova NLLB） ===============\n' +
    'ASR_PROVIDER=whisper-cpp\n' +
    `WHISPER_CLI_PATH=${path.join(WHISPER_DIR, whisperCliName)}\n` +
    `WHISPER_MODEL_PATH=${path.join(MODELS_DIR, 'ggml-small.bin')}\n` +
    '# WHISPER_THREADS=8  # 可选：默认自动=CPU 核数/2（上限8，下限4）\n' +
    'TRANSLATOR_PROVIDER=xenova-nllb\n' +
    '# XENOVA_CACHE_DIR=./.cache/xenova  # 可选：NLLB 模型缓存目录（默认 HuggingFace 系统目录）\n' +
    '# ===========================================================================\n';
  if (!fs.existsSync(envLocal)) {
    // 初始空文件：注释 + 配
    fs.writeFileSync(envLocal, block.trimStart(), 'utf8');
    console.log(`✔ 已写入初始 ${path.relative(SERVER_ROOT, envLocal)}（免费方案 A 所需变量）`);
    return;
  }
  const existing = fs.readFileSync(envLocal, 'utf8');
  // 已经有 ASR_PROVIDER=whisper-cpp 就不再追加
  if (existing.includes('ASR_PROVIDER=whisper-cpp') || existing.includes('ASR_PROVIDER=whispercpp')) {
    console.log(`ℹ 检测到 .env.local 已配置 whisper-cpp/xenova-nllb，跳过写文件。`);
    return;
  }
  fs.writeFileSync(envLocal, existing.trimEnd() + '\n' + block, 'utf8');
  console.log(`✔ 已在 .env.local 末尾追加方案 A 环境变量。`);
}

async function main() {
  const platformOk = process.platform === 'win32';
  if (!platformOk) {
    console.warn(
      `⚠  本 setup:offline 脚本默认是 Windows (x64) 一键安装；当前平台 = ${process.platform}。\n` +
        `   你可以手动：1) 下载 whisper.cpp Releases 对应平台二进制；2) 下载 ggml-small.bin；3) 在 .env.local 里设置 WHISPER_CLI_PATH / WHISPER_MODEL_PATH。`,
    );
  }
  console.log('\n===== 🛠  Offline Setup：下载 whisper.cpp Windows 预编译 + ggml-small.bin 模型 =====\n');
  console.log(`  目标目录：${WHISPER_DIR}`);
  console.log(`  预计总下载：~30MB (zip) + 487MB (model)，解压后约 550MB。\n`);

  // 1. 解析最新下载 URL（官方直连 + 两个 GitHub 代理共 6 条候选链路）
  const zipBaseUrls = platformOk ? await resolveLatestWhisperZipUrl() : [WHISPER_ZIP_FALLBACK];
  const zipUrls = withGithubProxies(zipBaseUrls);

  // 2. 下载 zip（新版本 b4938 起把 CPU 架构拆成独立 DLL，zip 只有 ≈8MB；
  //     更早版本是 20~35MB 一体包。所以阈值设为 5MB：
  //     - 小于 5MB → 基本是代理返回的错误页/登录页 HTML，判残
  //     - 5~30MB → 新版拆分包或旧版一体包，都合法）
  if (platformOk) {
    // 如果用户手动把 whisper-bin-x64.zip 放进了 WHISPER_DIR，优先用用户的那份（最可靠）
    const userZip = path.join(WHISPER_DIR, 'whisper-bin-x64.zip');
    if (fs.existsSync(userZip) && fs.statSync(userZip).size > 0) {
      const userMB = (fs.statSync(userZip).size / 1024 / 1024).toFixed(1);
      console.log(`✔ 检测到你手动放置了 whisper-bin-x64.zip（${userMB}MB）：${userZip}`);
      // 5MB 阈值同样适用于用户手动放的文件：太小（≤3-4MB）大概率是下载了 HTML/错误页而不自知
      if (fs.statSync(userZip).size < 5 * 1024 * 1024) {
        console.warn(
          `⚠ 该 zip 只有 ${userMB}MB（< 5MB），很可能不是真正的 whisper 预编译包，` +
            `通常是浏览器/代理返回了错误页或登录页。\n` +
            `  脚本将自动忽略它，继续使用下载链路；如果确定这个 zip 是正确的，请重新下载 ≥ 5MB 的版本再运行。`,
        );
      } else {
        console.log(`  将作为解压源使用（不再下载）。`);
        // 复制一份到 ZIP_PATH（临时路径）给后续解压步骤使用
        if (path.resolve(userZip) !== path.resolve(ZIP_PATH)) {
          fs.copyFileSync(userZip, ZIP_PATH);
        }
      }
    }
    // 如果用户没放，或者放的 zip < 5MB 被判定为残包，都会走下载链路
    if (!fs.existsSync(ZIP_PATH) || fs.statSync(ZIP_PATH).size < 5 * 1024 * 1024) {
      await download({
        urls: zipUrls,
        dest: ZIP_PATH,
        sizeHintMB: 30,
        minSizeMB: 5,
        label: 'whisper-bin-x64.zip',
      });
    }

    // 3. 解压
    console.log(`  ▶ 解压 ${path.basename(ZIP_PATH)}  →  ${WHISPER_DIR}`);
    try {
      extractZipWindows(ZIP_PATH, WHISPER_DIR);
      // 不管 zip 内部是 Release/、whisper-bin-x64/、bin/ 还是更复杂嵌套，
      // 统一：把所有文件都挪到 WHISPER_DIR 根层，删除多余空子目录
      flattenAllNestedFiles(WHISPER_DIR);

      const exeName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
      // 再做一次递归搜索，确保就算没摊平成功也能定位 exe
      const candidates = listAllFiles(WHISPER_DIR).filter(
        (p) => path.basename(p).toLowerCase() === exeName.toLowerCase(),
      );
      const exe =
        candidates.find((p) => path.dirname(p) === WHISPER_DIR) ?? candidates[0] ?? null;
      if (!exe) {
        const allFiles = listAllFiles(WHISPER_DIR).map((p) => path.relative(WHISPER_DIR, p));
        throw new Error(
          `解压完成但找不到 ${exeName}。解压后所有文件（相对路径）：\n    - ` +
            (allFiles.length ? allFiles.join('\n    - ') : '(空目录)'),
        );
      }
      // 如果找到的 exe 不在根层（极端情况），再搬一次到根层，保证后续配置路径一致
      let finalExe = exe;
      if (path.dirname(exe) !== WHISPER_DIR) {
        const toRoot = path.join(WHISPER_DIR, exeName);
        if (fs.existsSync(toRoot)) fs.rmSync(toRoot, { force: true });
        fs.renameSync(exe, toRoot);
        finalExe = toRoot;
        // 同时把同目录下的 dll 也挪到根（否则 exe 启动找不到 DLL）
        for (const sib of listAllFiles(path.dirname(exe))) {
          if (sib === toRoot) continue;
          const ext = path.extname(sib).toLowerCase();
          if (ext === '.dll' || ext === '.pdb') {
            const target = path.join(WHISPER_DIR, path.basename(sib));
            if (!fs.existsSync(target)) fs.renameSync(sib, target);
          }
        }
      }
      console.log(`✔ whisper-cli.exe 就绪：${finalExe}`);
    } finally {
      try {
        fs.rmSync(ZIP_PATH, { force: true });
      } catch {
        /* noop */
      }
    }
  }

  // 4. 下载模型 ggml-small.bin（优先级：HF 官方 → hf-mirror 国内镜像 → ModelScope 国内镜像）
  //    ggml-small.bin 官方 487MB；若下到 < 400MB 基本是残包，直接换下一个源
  await download({
    urls: [HUGGINGFACE_MODEL, HUGGINGFACE_MIRROR, MODELSCOPE_MODEL],
    dest: MODEL_PATH,
    sizeHintMB: 487,
    minSizeMB: 400,
    label: 'ggml-small.bin（ASR 模型）',
  });

  // 5. 写 .env.local（如果需要）
  await writeEnvLocalIfMissing();

  console.log('\n================================== ✅ 全部完成 ==================================');
  console.log('下一步：');
  console.log('  1. 确认 ffmpeg 已安装：winget install Gyan.FFmpeg （如已装可跳过）');
  console.log('  2. 启动后端服务：pnpm --filter @app/server dev');
  console.log('  3. 加载浏览器扩展（chrome://extensions → 已解压的扩展 → 选择 apps/extension/dist）');
  console.log('  4. 打开任意视频网页 → 点扩展图标开启 → 播放视频 → 实时双语字幕');
  console.log('');
  console.log('  Xenova NLLB 首次翻译时会自动下载 ~900MB 模型，耐心等待（后续永久离线）');
  console.log('=================================================================================\n');
}

main().catch((e) => {
  console.error('\n❌ setup:offline 失败：');
  console.error(e?.stack ?? e?.message ?? String(e));
  process.exit(1);
});
