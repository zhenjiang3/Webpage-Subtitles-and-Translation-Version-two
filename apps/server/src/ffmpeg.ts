import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 轻量 ffmpeg 封装 — V1 仅需两个命令：
 *  1. 提取 16kHz 单声道 WAV（供 Whisper 输入）
 *  2. ffprobe 读取视频时长
 * 定位顺序（从最高优先级到最低）：
 *   1. 环境变量显式指定绝对路径（完全绕过 PATH 解析歧义，推荐）
 *        FFMPEG_BIN_PATH = C:\...\ffmpeg.exe
 *        FFPROBE_BIN_PATH = C:\...\ffprobe.exe
 *   2. Windows：where.exe <name>（系统自带，受 PATHEXT 影响小）
 *      若失败，再回退：cmd.exe /c where /r 扫描常见安装盘符 + Program Files 目录
 *   3. Unix/Linux：command -v <name>
 * 解析出来后，extractAudioTrack / probeVideo / isFFmpegAvailable 全部调用「绝对路径」，
 * 避免 Node child_process.spawn 在 PowerShell / 杀软注入 / PATH 被篡改等场景下再次出现
 * 「用户手动敲命令成功，但自检/调用 spawn 报 ENOENT」的诡异问题。
 */

// ======================================================
// ffmpeg / ffprobe 可执行文件定位（带多级兜底）
// ======================================================

const IS_WIN = process.platform === 'win32';
const WIN_COMMON_ROOTS = [
  'C:\\',
  'D:\\',
  'E:\\',
  process.env['ProgramFiles'] ?? 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  process.env['LOCALAPPDATA'] ?? path.join(process.env['USERPROFILE'] ?? 'C:\\Users\\Public', 'AppData\\Local'),
].filter(Boolean);

/** 带环境变量覆盖的 bin 名 → 环境变量名 映射 */
const ENV_BIN_OVERRIDE: Record<'ffmpeg' | 'ffprobe', string> = {
  ffmpeg: 'FFMPEG_BIN_PATH',
  ffprobe: 'FFPROBE_BIN_PATH',
};

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { shell?: boolean; windowsHide?: boolean; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; errMsg?: string }> {
  const { shell = false, windowsHide = true, timeoutMs = 8000 } = opts;
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { shell, windowsHide });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const done = (result: { code: number | null; stdout: string; stderr: string; errMsg?: string }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout?.on('data', (d) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      child.stderr?.on('data', (d) => err.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      child.on('error', (e) => done({ code: -1, stdout: '', stderr: '', errMsg: e?.message ?? String(e) }));
      child.on('exit', (code) =>
        done({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
      const t = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        done({ code: -2, stdout: '', stderr: '', errMsg: 'spawn timeout' });
      }, timeoutMs);
      t.unref?.();
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', errMsg: e instanceof Error ? e.message : String(e) });
    }
  });
}

async function whichViaWhere(name: string): Promise<string | null> {
  // 方法 1：where.exe <name> —— 受当前进程继承下来的 PATH 限制
  const r1 = await spawnCapture('where.exe', [name]);
  if (r1.code === 0) {
    const first = r1.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }
  // 方法 2：cmd /c where /r <root> <name> —— 不依赖 PATH，逐个根目录递归扫（2-3 层即可，别扫太深）
  //    where /r 对 Windows 是原生命令，只扫传入根目录，深度 2-3 层几毫秒就完事
  const exeExts = IS_WIN ? [name + '.exe', name] : [name];
  for (const root of WIN_COMMON_ROOTS) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const ext of exeExts) {
        const r2 = await spawnCapture('cmd.exe', ['/c', 'where', '/r', root, ext], { timeoutMs: 6000 });
        if (r2.code === 0) {
          const first = r2.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
          if (first && fs.existsSync(first)) return first;
        }
      }
    } catch {
      /* skip root */
    }
  }
  return null;
}

async function whichViaCommandV(name: string): Promise<string | null> {
  const r = await spawnCapture('/bin/sh', ['-c', `command -v -- "${name}"`]);
  if (r.code !== 0) return null;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first ?? null;
}

async function which(name: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  // 优先级 1：环境变量绝对路径覆盖
  const override = process.env[ENV_BIN_OVERRIDE[name]]?.trim();
  if (override) {
    if (fs.existsSync(override)) return override;
    // eslint-disable-next-line no-console
    console.warn(`[ffmpeg.ts] ${ENV_BIN_OVERRIDE[name]} 指定了不存在的文件：${override}，已忽略，将按 PATH 继续查找。`);
  }
  // 优先级 2：系统查找
  const found = IS_WIN ? await whichViaWhere(name) : await whichViaCommandV(name);
  if (found) return found;
  // Gyan/BTBN 常见安装位置兜底
  if (IS_WIN) {
    const candidates: string[] = [];
    const drives = ['C:', 'D:', 'E:'].filter(Boolean);
    for (const drv of drives) {
      candidates.push(
        `${drv}\\FFmpeg\\bin\\${name}.exe`,
        `${drv}\\Program Files\\FFmpeg\\bin\\${name}.exe`,
        `${drv}\\ProgramData\\chocolatey\\bin\\${name}.exe`,
        `${drv}\\Users\\${process.env['USERNAME'] ?? ''}\\scoop\\shims\\${name}.exe`,
      );
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/** 缓存：启动后只解析一次，路径不会变来变去 */
const RESOLVED_BIN_CACHE = new Map<'ffmpeg' | 'ffprobe', Promise<string | null>>();
function resolveBin(name: 'ffmpeg' | 'ffprobe'): Promise<string | null> {
  if (!RESOLVED_BIN_CACHE.has(name)) {
    RESOLVED_BIN_CACHE.set(name, which(name));
  }
  return RESOLVED_BIN_CACHE.get(name)!;
}

/**
 * 真正调用 ffmpeg / ffprobe：永远用绝对路径，彻底规避 PATH 解析歧义
 */
async function spawnBin(
  name: 'ffmpeg' | 'ffprobe',
  args: string[],
  handlers: {
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
    onSpawnError: (err: Error) => void;
    onExit: (code: number | null, stderrTail: string) => void;
  },
): Promise<void> {
  const binPath = await resolveBin(name);
  if (!binPath) {
    handlers.onSpawnError(
      new Error(
        `找不到 ${name}${IS_WIN ? '.exe' : ''} 可执行文件。\n` +
          `排查方法（在 PowerShell 里执行）：Get-Command ${name} | Format-List *\n` +
          `如果上面能找到路径，直接把它写入 apps/server/.env.local：\n` +
          `  ${ENV_BIN_OVERRIDE[name]}=查到的绝对路径\n` +
          `然后重启 dev server。`,
      ),
    );
    return;
  }
  const errBuf: Buffer[] = [];
  const child = spawn(binPath, args, { windowsHide: true });
  child.stdout?.on('data', (d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d);
    handlers.onStdout?.(b);
  });
  child.stderr?.on('data', (d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(d);
    errBuf.push(b);
    handlers.onStderr?.(b);
  });
  child.on('error', handlers.onSpawnError);
  child.on('exit', (code) => {
    const tail = Buffer.concat(errBuf).toString('utf8').trim().slice(-1200);
    handlers.onExit(code, tail);
  });
}

export interface FFProbeInfo {
  durationSec: number;
  resolution?: string; // 1920x1080
  fps?: number;
}

export function extractAudioTrack(inputVideo: string, outputWav: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Whisper 最优输入：PCM 16-bit signed little-endian, 16kHz, mono
    const args = [
      '-y',
      '-i',
      inputVideo,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      outputWav,
    ];
    void spawnBin('ffmpeg', args, {
      onSpawnError: (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}`)),
      onExit: (code, stderrTail) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffmpeg extract audio 退出码: ${code}. 输入: ${inputVideo} 输出: ${outputWav}\n` +
                `ffmpeg 最后日志:\n${stderrTail}`,
            ),
          );
      },
    });
  });
}

export async function probeVideo(videoPath: string): Promise<FFProbeInfo> {
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate:format=duration',
    '-of',
    'json',
    videoPath,
  ];

  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    void spawnBin('ffprobe', args, {
      onStdout: (b) => out.push(b),
      onSpawnError: (e) =>
        reject(
          new Error(
            `ffprobe 启动失败: ${e.message} 请确认 ffmpeg/ffprobe 已安装，必要时在 apps/server/.env.local 配置 ${ENV_BIN_OVERRIDE.ffprobe} 绝对路径。`,
          ),
        ),
      onExit: (code, stderrTail) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffprobe 退出码 ${code}. 文件: ${videoPath}\n` + (stderrTail ? `ffprobe 日志:\n${stderrTail}` : ''),
            ),
          );
      },
    });
  });

  const json = JSON.parse(Buffer.concat(out).toString('utf8')) as {
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
    format?: { duration?: string };
  };

  const stream = json.streams?.[0];
  const durationSec = parseFloat(json.format?.duration ?? '0') || 0;
  const resolution =
    stream?.width && stream?.height ? `${stream.width}x${stream.height}` : undefined;
  const fps = parseFps(stream?.r_frame_rate);

  return { durationSec, resolution, fps };
}

function parseFps(fraction?: string): number | undefined {
  if (!fraction) return undefined;
  const [num, den] = fraction.split('/');
  const n = parseInt(num ?? '0', 10);
  const d = parseInt(den ?? '0', 10);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 100) / 100;
}

/**
 * 检查系统 ffmpeg / ffprobe 是否可用
 * - 环境变量绝对路径（优先级最高）
 * - PATH 查找 / 全盘扫描 → 得到绝对路径后，真实跑一次 -version 校验退出码 0
 */
export async function isFFmpegAvailable(): Promise<{ ok: boolean; ffmpegPath: string | null; ffprobePath: string | null }> {
  const [ff, fp] = await Promise.all([resolveBin('ffmpeg'), resolveBin('ffprobe')]);
  if (!ff || !fp) return { ok: false, ffmpegPath: ff ?? null, ffprobePath: fp ?? null };
  const run = async (p: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      try {
        const c = spawn(p, ['-version'], { windowsHide: true });
        c.on('error', () => resolve(false));
        c.on('exit', (code) => resolve(code === 0));
        setTimeout(() => resolve(false), 6000).unref?.();
      } catch {
        resolve(false);
      }
    });
  };
  const [okFf, okFp] = await Promise.all([run(ff), run(fp)]);
  return { ok: okFf && okFp, ffmpegPath: okFf ? ff : null, ffprobePath: okFp ? fp : null };
}
