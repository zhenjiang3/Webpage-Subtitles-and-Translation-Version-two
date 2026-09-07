/**
 * 单块音频流水线
 * ─────────────────────────────────────────────────────────────────
 * 输入：一段音频 blob（webm/opus 或 pcm-s16le）+ 元数据
 * 处理：写到临时文件 → ffmpeg 转 WAV（如需）→ whisper.cpp ASR → Xenova 翻译
 * 输出：asr_result + translation 消息体（供 ws-handler 回送客户端）
 *
 * 关键：cue 时间戳是「相对块起点」的秒数，客户端按 videoTimeAtStartSec + startSec 映射到绝对视频时间。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractAudioTrack } from './ffmpeg.js';
import { createAsrProvider } from './asr/index.js';
import { createTranslatorProvider } from './translator/index.js';
import type { LanguageCode } from './lib/types.js';
import type { AsrSegment, AsrProvider } from './asr/types.js';
import type { TranslatorProvider } from './translator/types.js';

export interface RelativeCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface ChunkMeta {
  chunkId: number;
  sessionId: string;
  videoTimeAtStartSec: number;
  videoTimeAtEndSec: number;
  chunkDurationSec: number;
  sourceLang: 'auto' | LanguageCode;
  targetLang: LanguageCode;
  audioFormat: 'webm-opus' | 'pcm-s16le';
  sampleRate?: number;
  channels?: number;
}

export interface AsrResultMsg {
  type: 'asr_result';
  chunkId: number;
  sessionId: string;
  videoTimeAtStartSec: number;
  detectedLang: LanguageCode;
  cues: RelativeCue[];
}

export interface TranslationMsg {
  type: 'translation';
  chunkId: number;
  targetLang: LanguageCode;
  texts: string[];
}

export interface ErrorMsg {
  type: 'error';
  chunkId: number;
  stage: 'ffmpeg' | 'asr' | 'translate';
  message: string;
}

export interface StatusMsg {
  type: 'status';
  message: string;
}

export type OutboundMsg = AsrResultMsg | TranslationMsg | ErrorMsg | StatusMsg;

// —— Provider 单例：whisper.cpp 进程 spawn + Xenova pipeline 初始化都很重，全局只跑一次 ——
let asrProviderPromise: Promise<AsrProvider> | null = null;
let translatorProviderPromise: Promise<TranslatorProvider> | null = null;

function getAsr(): Promise<AsrProvider> {
  if (!asrProviderPromise) {
    asrProviderPromise = Promise.resolve(createAsrProvider());
  }
  return asrProviderPromise;
}

function getTranslator(): Promise<TranslatorProvider> {
  if (!translatorProviderPromise) {
    translatorProviderPromise = Promise.resolve(createTranslatorProvider());
  }
  return translatorProviderPromise;
}

// —— 短 WAV 头写入（pcm-s16le 直传模式，免 ffmpeg）——
function writeWavHeader(sampleRate: number, channels: number, totalPcmBytes: number) {
  const buf = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * 16) / 8;
  const blockAlign = (channels * 16) / 8;
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + totalPcmBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(totalPcmBytes, 40);
  // 注意：本函数把 header 追加到「已经写好的 PCM 数据文件」之前需要重写。
  // 简化处理：直接把 PCM 数据读入内存 + 头拼好一次性写入。
  // 这里仅返回 header buffer，调用方负责拼接。
  return buf;
}

// —— 清理某次 ASR 产生的临时文件（webm/wav/srt）——
function cleanupChunkFiles(basePathNoExt: string, sessionId: string, chunkId: number) {
  const dir = path.dirname(basePathNoExt);
  const sid = `${sessionId}-${chunkId}`;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${sid}-`) || f === `${sid}.webm` || f === `${sid}.wav` || f.endsWith('.srt')) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * 处理单块音频
 * @param dataDir       临时文件目录（apps/server/data）
 * @param meta          块元数据
 * @param audioBytes     原始音频字节（webm 容器 或 pcm-s16le）
 * @param onStatus       状态推送回调（模型加载等）
 */
export async function processChunk(
  dataDir: string,
  meta: ChunkMeta,
  audioBytes: Buffer,
): Promise<OutboundMsg[]> {
  const out: OutboundMsg[] = [];
  const sid = `${meta.sessionId}-${meta.chunkId}`;
  const ext = meta.audioFormat === 'pcm-s16le' ? '.pcm' : '.webm';
  const rawPath = path.join(dataDir, `${sid}${ext}`);
  const wavPath = path.join(dataDir, `${sid}.wav`);

  try {
    // 1. 写原始音频到临时文件
    fs.writeFileSync(rawPath, audioBytes);

    // 2. 转 WAV
    if (meta.audioFormat === 'webm-opus') {
      await extractAudioTrack(rawPath, wavPath);
    } else {
      // pcm-s16le：拼一个最小 WAV 头
      const sr = meta.sampleRate ?? 16000;
      const ch = meta.channels ?? 1;
      const header = writeWavHeader(sr, ch, audioBytes.length);
      fs.writeFileSync(wavPath, Buffer.concat([header, audioBytes]));
    }

    // 3. ASR
    const asr = await getAsr();
    const langHint = meta.sourceLang === 'auto' ? undefined : meta.sourceLang;
    const result = await asr.transcribe(wavPath, { langHint });

    // 4. segments → RelativeCue（秒，相对块起点）
    const cues: RelativeCue[] = result.segments
      .filter((s: AsrSegment) => s.end > s.start && s.text.trim().length > 0)
      .map((s: AsrSegment) => ({
        startSec: s.start,
        endSec: s.end,
        text: s.text.trim(),
      }));

    out.push({
      type: 'asr_result',
      chunkId: meta.chunkId,
      sessionId: meta.sessionId,
      videoTimeAtStartSec: meta.videoTimeAtStartSec,
      detectedLang: result.language,
      cues,
    });

    // 5. 翻译（如目标语言 ≠ 检测语言）
    if (cues.length > 0 && result.language !== meta.targetLang) {
      try {
        const tr = await getTranslator();
        const texts = cues.map((c) => c.text);
        const translated = await tr.translate({
          sourceLang: result.language,
          targetLang: meta.targetLang,
          texts,
        });
        out.push({
          type: 'translation',
          chunkId: meta.chunkId,
          targetLang: meta.targetLang,
          texts: translated,
        });
      } catch (e) {
        out.push({
          type: 'error',
          chunkId: meta.chunkId,
          stage: 'translate',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return out;
  } catch (e) {
    // 判定失败阶段：ffmpeg vs asr
    const msg = e instanceof Error ? e.message : String(e);
    const stage: 'ffmpeg' | 'asr' = /ffmpeg|extract audio|ffprobe/i.test(msg) ? 'ffmpeg' : 'asr';
    out.push({ type: 'error', chunkId: meta.chunkId, stage, message: msg });
    return out;
  } finally {
    // 清理本次产生的所有临时文件（webm/wav/srt）
    cleanupChunkFiles(path.join(dataDir, sid), meta.sessionId, meta.chunkId);
    try { fs.rmSync(rawPath, { force: true }); } catch { /* noop */ }
    try { fs.rmSync(wavPath, { force: true }); } catch { /* noop */ }
  }
}

export type { LanguageCode };
