/**
 * whisper.cpp 本地 ASR 提供者（方案 A：零 API Key + 零 Python）
 * —— 调用 Windows 预编译的 whisper-cli.exe（C++），CPU 跑 ggml 量化模型
 * 官网：https://github.com/ggml-org/whisper.cpp
 * Windows 部署：
 *   1. 从 GitHub Releases 下载 whisper-bin-x64.zip → 解压（含 whisper-cli.exe + *.dll）
 *   2. 从 HuggingFace 下载 ggml-small.bin（中文日常推荐，487MB）或 ggml-base.bin（148MB，更快但稍差）
 *   3. 设置环境变量：
 *        WHISPER_CLI_PATH   = C:\path\to\whisper-cli.exe
 *        WHISPER_MODEL_PATH = C:\path\to\ggml-small.bin
 *   （或运行 pnpm --filter @app/web setup:offline 自动下载到 apps/web/tools/whisper/）
 *
 * whisper.cpp 输入要求：PCM 16-bit, 16kHz, mono WAV
 * —— ffmpeg.ts 的 extractAudioTrack() 已经满足该格式，所以这里直接用
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { LanguageCode } from '@/lib/types';
import type { AsrProvider, AsrResult, AsrSegment } from './types';
import { parseSrt } from '@/lib/subtitles';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDefaultWhisperPaths(): { cli: string; model: string } {
  // 反推：
  //   __dirname = apps/server/src/asr
  //   向上 3 层 = apps/server → tools/whisper 就在它下面
  const serverRoot = path.resolve(__dirname, '..', '..', '..');
  const toolsDir = path.join(serverRoot, 'tools', 'whisper');
  const isWin = process.platform === 'win32';
  return {
    cli: path.join(toolsDir, isWin ? 'whisper-cli.exe' : 'whisper-cli'),
    model: path.join(toolsDir, 'models', 'ggml-small.bin'),
  };
}

const LANG_TO_WHISPER: Record<LanguageCode, string> = {
  zh: 'zh',
  en: 'en',
  ja: 'ja',
};

function normalizeLang(lang: string | undefined): LanguageCode {
  if (!lang) return 'zh';
  const l = lang.toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('ja') || l.startsWith('jp')) return 'ja';
  if (l.startsWith('en')) return 'en';
  return 'zh';
}

/**
 * 列出 dir 目录下所有文件（文件名+size 简写），作为错误诊断信息
 * 不超过 200 个字符，避免错误信息爆炸
 */
function listDirBrief(dir: string): string {
  try {
    const items = fs.readdirSync(dir).map((name) => {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        return `${name}(${formatBytes(st.size)})`;
      } catch {
        return `${name}`;
      }
    });
    const all = items.join(', ');
    return all.length > 500 ? all.slice(0, 500) + ` …(+${items.length}项)` : all || '(空目录)';
  } catch (e) {
    return `[列目录失败] ${e instanceof Error ? e.message : String(e)}`;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

/**
 * 把 Node spawn 的 args 数组拼成 PowerShell/CMD 可直接复制运行的形式
 * 遇到空格或 &/;/'/" 等字符就用双引号包住并转义内部双引号
 */
function formatArgsForShell(args: readonly string[]): string {
  return args
    .map((a) => {
      if (/[\s&;'"]/.test(a)) {
        return `"${a.replace(/"/g, '""')}"`;
      }
      return a;
    })
    .join(' ');
}

/**
 * 长字符串诊断展示：取开头 + 结尾各 N 字，中间用 "…(跳过 X chars)" 连接
 * 避免错误堆栈被 help 页撑爆但关键的 invalid option 在开头看不到
 */
function headPlusTail(s: string, n = 2000): string {
  if (!s) return '(空)';
  if (s.length <= n * 2) return s;
  return `${s.slice(0, n)}\n…(跳过 ${s.length - n * 2} 个字符)…\n${s.slice(-n)}`;
}

/**
 * 从 whisper.cpp stderr/stdout 中提取 "[DetectedLanguage]: xx"
 * 不同版本 whisper.cpp 输出格式有差异，这里兼容几种常见模式
 */
function parseDetectedLanguage(output: string): string | undefined {
  const patterns = [
    /detected\s+language[:\s]+['"]?([a-z]{2,3})['"]?/i,
    /DetectedLanguage\]\s*[:\s]+['"]?([a-z]{2,3})/i,
    /whisper_full_parallel\].*\(language\s*=\s*([a-z]{2,3})\)/i,
    /auto-detect.*language\s*=\s*([a-z]{2,3})/i,
  ];
  for (const p of patterns) {
    const m = output.match(p);
    if (m?.[1]) return m[1].toLowerCase();
  }
  return undefined;
}

export class WhisperCppProvider implements AsrProvider {
  readonly name = 'whisper-cpp';
  private readonly cliPath: string;
  private readonly modelPath: string;
  private readonly threads: number;

  constructor(opts?: { cliPath?: string; modelPath?: string; threads?: number }) {
    const defaults = getDefaultWhisperPaths();
    this.cliPath = opts?.cliPath ?? process.env.WHISPER_CLI_PATH ?? defaults.cli;
    this.modelPath = opts?.modelPath ?? process.env.WHISPER_MODEL_PATH ?? defaults.model;
    this.threads = Math.max(
      1,
      opts?.threads ??
        (parseInt(process.env.WHISPER_THREADS ?? '', 10) ||
          Math.min(8, Math.max(4, Math.floor(os.cpus().length / 2) || 4))),
    );

    if (!fs.existsSync(this.cliPath)) {
      throw new Error(
        `[whisper-cpp] 找不到 whisper-cli 可执行文件：${this.cliPath}\n` +
          `请先运行 "pnpm --filter @app/server setup:offline" 自动下载，或在 .env.local 中设置 WHISPER_CLI_PATH。`,
      );
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(
        `[whisper-cpp] 找不到模型文件：${this.modelPath}\n` +
          `请先运行 "pnpm --filter @app/server setup:offline" 自动下载，或在 .env.local 中设置 WHISPER_MODEL_PATH。`,
      );
    }
  }

  async transcribe(
    audioPath: string,
    opts: { langHint?: LanguageCode; onProgress?: (pct: number, stage: string) => void },
  ): Promise<AsrResult> {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`[whisper-cpp] 音频文件不存在：${audioPath}`);
    }
    opts.onProgress?.(3, '准备 whisper.cpp 参数...');

    const lang = opts.langHint ? LANG_TO_WHISPER[opts.langHint] : 'auto';

    const audioDir = path.dirname(audioPath);
    const audioExt = path.extname(audioPath); // .wav
    const base = path.basename(audioPath, audioExt); // audio

    // —— 关于 SRT 输出命名：whisper.cpp 不同版本对 `-of prefix` 行为差异很大：
    //   a) 老版：-of prefix 会输出 prefix.srt
    //   b) 新版 (b4938/1.9.x)：-of prefix 输出 prefix.wav.srt（把输入文件名 wav 也再追加一次后缀）
    //   c) 不开 -of 只开 -osrt：输出 <input>.srt
    //   d) 不写 -osrt/-of：默认输出多格式 .wav.srt/.wav.vtt 等
    // 所以这里：我们写一个「期望输出路径」，但在完成后不依赖单一路径，会枚举 audioDir 所有 .srt 兜底寻找。
    const srtOutPrefix = path.join(audioDir, `${base}.whisper-out`);
    const expectedByOfParam = `${srtOutPrefix}.srt`; // 老版行为
    const expectedByOfParamWavSfx = `${srtOutPrefix}${audioExt}.srt`; // b4938 新版行为

    // 清理可能的历史输出（避免把上次遗留当成这次产物）
    try {
      for (const f of fs.readdirSync(audioDir)) {
        if (f.endsWith('.srt')) fs.rmSync(path.join(audioDir, f), { force: true });
      }
    } catch {
      /* noop */
    }

    // —— 参数选择策略（为了兼容 b4938 新版 CLI 严格/可变的语法）：
    //    只传「不同版本都公认存在」的核心参数：
    //      -m model / -f input / -l language / -t threads / -osrt
    //    移除以下可能触发新版解析歧义并直接走 --help exit 0 的开关：
    //      -ng（--no-gpu，部分新版不接受短形式或语法不同）
    //      -v （可能被识别为 --version，或新版需跟随参数）
    //      -of prefix（部分新版行为不定 → 先不写，默认输出到 <input>.srt，更稳定）
    const args: string[] = [
      '-m',
      this.modelPath,
      '-f',
      audioPath,
      '-l',
      lang,
      '-t',
      String(this.threads),
      '-osrt',
    ];

    // eslint-disable-next-line no-console
    console.log(
      '[whisper-cpp] spawn:',
      '\n  cli   :', this.cliPath,
      '\n  model :', this.modelPath,
      '\n  audio :', audioPath,
      `(${fs.existsSync(audioPath) ? `size=${fs.statSync(audioPath).size} bytes` : 'MISSING'})`,
      '\n  args  :',
      JSON.stringify(args),
    );

    opts.onProgress?.(8, `启动 whisper.cpp（模型 ${path.basename(this.modelPath)}，线程 ${this.threads}）...`);

    let startTs = Date.now();
    const stderrBuf: Buffer[] = [];
    const stdoutBuf: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.cliPath, args, { windowsHide: true });

      let fakePct = 10;
      const stage = '本地语音识别中（whisper.cpp CPU）';
      const timer = setInterval(() => {
        if (fakePct < 92) {
          fakePct = Math.min(92, fakePct + 2);
          opts.onProgress?.(fakePct, stage);
        }
      }, 3000);

      child.stderr?.on('data', (d) => stderrBuf.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      child.stdout?.on('data', (d) => stdoutBuf.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));

      child.on('error', (err) => {
        clearInterval(timer);
        reject(new Error(`[whisper-cpp] 启动失败: ${err.message}`));
      });
      child.on('exit', (code, signal) => {
        clearInterval(timer);
        const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
        if (code === 0) {
          opts.onProgress?.(93, `whisper.cpp 完成（耗时 ${elapsed}s），查找 SRT...`);
          resolve();
        } else {
          const stderrText = Buffer.concat(stderrBuf).toString('utf8');
          const stdoutText = Buffer.concat(stdoutBuf).toString('utf8');
          reject(
            new Error(
              `[whisper-cpp] 退出码 ${code}（signal ${signal ?? 'none'}）。\n` +
                `cli : ${this.cliPath}\n` +
                `args: ${JSON.stringify(args)}\n` +
                `cwd 目录文件：${listDirBrief(audioDir)}\n` +
                `stderr（首+尾）：\n${headPlusTail(stderrText)}\n` +
                `stdout（首+尾）：\n${headPlusTail(stdoutText)}`,
            ),
          );
        }
      });
    });

    // —— 找 SRT 文件：
    //   第 1 优先级：${audioPath}.srt —— 不传 -of 时 whisper-cli(所有版本) 默认就输出到这个名字
    //   第 2/3 优先级：历史的 -of <prefix> 命名（老版/新版追加 .wav）
    //   都命中不到时 → 终极兜底：audioDir 下所有 .srt 按 mtime/size 挑最新最大的
    const srtSearchCandidates = [
      `${audioPath}.srt`,
      expectedByOfParam,
      expectedByOfParamWavSfx,
    ];
    let resolvedSrt: string | null = null;
    for (const candidate of srtSearchCandidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
          resolvedSrt = candidate;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!resolvedSrt) {
      // 终极兜底：audioDir 下所有 .srt，按 mtime 最新 → size 最大排序，挑第一个非空的
      try {
        const all = fs.readdirSync(audioDir)
          .filter((n) => n.toLowerCase().endsWith('.srt'))
          .map((n) => path.join(audioDir, n))
          .filter((p) => {
            try {
              return fs.statSync(p).size > 0;
            } catch {
              return false;
            }
          })
          .sort((a, b) => {
            const ma = fs.statSync(a).mtimeMs;
            const mb = fs.statSync(b).mtimeMs;
            if (mb !== ma) return mb - ma;
            return fs.statSync(b).size - fs.statSync(a).size;
          });
        resolvedSrt = all[0] ?? null;
      } catch {
        resolvedSrt = null;
      }
    }

    if (!resolvedSrt) {
      const stderrText = Buffer.concat(stderrBuf).toString('utf8');
      const stdoutText = Buffer.concat(stdoutBuf).toString('utf8');
      const maybeHelp =
        stderrText.length > 2000 ||
        /usage/i.test(stdoutText) ||
        /invalid option|unknown option|unrecognized arguments/i.test(stderrText);
      let msg = '';
      msg += '[whisper-cpp] 未找到生成的 SRT 文件（whisper exit=0 但目录里没有任何 .srt）\n';
      msg += '按优先级查过：\n  - ' + srtSearchCandidates.join('\n  - ') + '\n';
      msg += '实际目录文件：\n' + listDirBrief(audioDir) + '\n';
      if (maybeHelp) {
        msg += '⚠ 看起来 whisper-cli 可能把完整 --help 帮助页吐了一遍后 exit 0，而不是真正执行推理。\n';
        msg += '  常见原因：传了 b4938 新版不兼容的参数开关。本轮已删除可能触发歧义的 -ng / -v / -of 三个开关，仅保留 -m/-f/-l/-t/-osrt。\n';
        msg += '  如果继续出现帮助页，请贴以下命令在 PowerShell 执行后的前 40 行输出，用于确认真实短选项语法：\n';
        msg += '    & "' + this.cliPath + '" --help | Select-Object -First 40\n';
      }
      msg += 'cli  : ' + this.cliPath + '\n';
      msg += 'args : ' + JSON.stringify(args) + '\n';
      msg += 'PowerShell 手动验证命令（1:1 复现）：\n';
      msg += '  & "' + this.cliPath + '" ' + formatArgsForShell(args) + '\n';
      msg += 'whisper-cli stderr（首+尾）：\n' + headPlusTail(stderrText) + '\n';
      msg += 'whisper-cli stdout（首+尾）：\n' + headPlusTail(stdoutText);
      throw new Error(msg);
    }

    // eslint-disable-next-line no-console
    console.log(`[whisper-cpp] 命中 SRT 文件：${resolvedSrt} (size=${fs.statSync(resolvedSrt).size} bytes)`);

    const srtText = await fs.promises.readFile(resolvedSrt, 'utf8');
    const cues = parseSrt(srtText);

    // 清理所有本次产生的临时 SRT
    try {
      for (const f of fs.readdirSync(audioDir)) {
        if (f.toLowerCase().endsWith('.srt')) {
          try { fs.rmSync(path.join(audioDir, f), { force: true }); } catch { /* noop */ }
        }
      }
    } catch {
      /* noop */
    }

    opts.onProgress?.(97, `SRT 解析成功（${cues.length} 条），后处理...`);

    // SubtitleCue → AsrSegment（秒单位）
    const segments: AsrSegment[] = cues
      .filter((c) => c.startMs < c.endMs && c.text.trim().length > 0)
      .map((c) => ({
        start: c.startMs / 1000,
        end: c.endMs / 1000,
        text: c.text.trim(),
      }));

    const durationSec = segments.length > 0 ? segments[segments.length - 1]!.end : 0;

    // 识别语言：优先 langHint，其次从 whisper.cpp stderr 正则匹配，兜底 'zh'
    const stderrText = Buffer.concat(stderrBuf).toString('utf8');
    const detectedFromLog = parseDetectedLanguage(stderrText);
    const language: LanguageCode = opts.langHint ?? normalizeLang(detectedFromLog);

    return { language, durationSec, segments };
  }
}
