/**
 * WebSocket 连接状态机 + 协议解析
 * ─────────────────────────────────────────────────────────────────
 * 每连接状态：sessionId、语言设置、待处理块队列（按 sessionId 串行，单 ASR 并发）
 *
 * 帧顺序契约：每个 chunk 必须是「TEXT 块头帧 + BINARY 音频帧」连续两条。
 * ws-handler 在内存里缓存「上一个 chunk 帧的元数据」，等 binary 帧到达后配对执行。
 */
import path from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { processChunk, type ChunkMeta, type OutboundMsg } from './pipeline.js';
import type { LanguageCode } from './lib/types.js';

export interface ServerContext {
  dataDir: string;
}

interface PendingChunk {
  meta: ChunkMeta;
}

interface SessionState {
  sessionId: string;
  sourceLang: 'auto' | LanguageCode;
  targetLang: LanguageCode;
  audioFormat: 'webm-opus' | 'pcm-s16le';
  sampleRate: number;
  channels: number;
  /** 串行队列：同一 session 一次只跑一个 ASR，避免 CPU 抖动 + whisper.cpp 多进程竞争 */
  chain: Promise<void>;
}

function send(ws: WebSocket, msg: OutboundMsg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendStatus(ws: WebSocket, message: string) {
  send(ws, { type: 'status', message });
}

export async function handleConnection(ws: WebSocket, ctx: ServerContext): Promise<void> {
  sendStatus(ws, '后端就绪，等待音频块...');

  let session: SessionState | null = null;
  /** 待配对的 chunk 元数据（TEXT 帧先到，等 BINARY 帧配对） */
  let pendingChunk: PendingChunk | null = null;

  // —— TEXT 帧 ——
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      // 二进制帧：必须有一条待配对的 chunk meta
      if (!pendingChunk) {
        // 没有等待中的 chunk 头，忽略（避免崩溃）
        return;
      }
      const meta = pendingChunk.meta;
      pendingChunk = null;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayLike<number>);

      // 入队串行执行
      const run = (session ?? defaultSession(meta)).chain
        .then(async () => {
          // 实际处理
          const messages = await processChunk(ctx.dataDir, meta, buf);
          for (const m of messages) {
            send(ws, m);
          }
        })
        .catch((e) => {
          send(ws, {
            type: 'error',
            chunkId: meta.chunkId,
            stage: 'asr',
            message: e instanceof Error ? e.message : String(e),
          });
        });
      // 更新 chain
      if (session) session.chain = run;
      return;
    }

    // —— TEXT 帧：JSON 解析 ——
    let text: string;
    try {
      text = data.toString('utf8');
    } catch {
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    switch (msg?.type) {
      case 'start': {
        session = {
          sessionId: String(msg.sessionId ?? crypto.randomUUID()),
          sourceLang: (msg.sourceLang === 'auto' ? 'auto' : msg.sourceLang) ?? 'auto',
          targetLang: msg.targetLang ?? 'zh',
          audioFormat: msg.audioFormat ?? 'webm-opus',
          sampleRate: Number(msg.sampleRate ?? 48000),
          channels: Number(msg.channels ?? 1),
          chain: Promise.resolve(),
        };
        sendStatus(ws, `会话 ${session.sessionId} 已启动：${session.sourceLang} → ${session.targetLang}`);
        break;
      }
      case 'chunk': {
        // 块头：存入 pendingChunk，等下一个 binary 帧配对
        const meta: ChunkMeta = {
          chunkId: Number(msg.chunkId),
          sessionId: session?.sessionId ?? String(msg.sessionId ?? 'unknown'),
          videoTimeAtStartSec: Number(msg.videoTimeAtStartSec ?? 0),
          videoTimeAtEndSec: Number(msg.videoTimeAtEndSec ?? 0),
          chunkDurationSec: Number(msg.chunkDurationSec ?? 0),
          sourceLang: session?.sourceLang ?? (msg.sourceLang === 'auto' ? 'auto' : msg.sourceLang) ?? 'auto',
          targetLang: session?.targetLang ?? msg.targetLang ?? 'zh',
          audioFormat: session?.audioFormat ?? msg.audioFormat ?? 'webm-opus',
          sampleRate: session?.sampleRate ?? Number(msg.sampleRate ?? 48000),
          channels: session?.channels ?? Number(msg.channels ?? 1),
        };
        pendingChunk = { meta };
        break;
      }
      case 'end': {
        sendStatus(ws, `会话 ${(session ?? {}).sessionId ?? ''} 已结束`);
        session = null;
        pendingChunk = null;
        break;
      }
      case 'ping': {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
      default: {
        // 未知消息类型，忽略
      }
    }
  });

  ws.on('close', () => {
    session = null;
    pendingChunk = null;
  });

  ws.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[ws] connection error:', e.message);
  });
}

function defaultSession(meta: ChunkMeta): SessionState {
  return {
    sessionId: meta.sessionId,
    sourceLang: meta.sourceLang,
    targetLang: meta.targetLang,
    audioFormat: meta.audioFormat,
    sampleRate: meta.sampleRate ?? 48000,
    channels: meta.channels ?? 1,
    chain: Promise.resolve(),
  };
}

// 提供给 index.ts 的健康检查用的路径计算
export function resolveDataDir(serverRoot: string): string {
  return path.join(serverRoot, 'data');
}
