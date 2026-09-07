/**
 * 消息类型定义（chrome.runtime 消息 + WS 消息的单一真源）
 * ─────────────────────────────────────────────────────────────────
 * content.ts ↔ background.ts 用 chrome.runtime.sendMessage 通信
 * background.ts ↔ 后端用 WebSocket（文本帧 JSON + 二进制帧 blob）
 */

export type LangCode = 'zh' | 'en' | 'ja';
export type SourceLang = 'auto' | LangCode;
export type AudioFormat = 'webm-opus' | 'pcm-s16le';

export interface Settings {
  enabled: boolean;
  sourceLang: SourceLang;
  targetLang: LangCode;
}

// ============ content → background（chrome.runtime） ============

/** 会话开始（一个 video 对应一个 session） */
export interface StartMsg {
  kind: 'start';
  sessionId: string;
  sourceLang: SourceLang;
  targetLang: LangCode;
  audioFormat: AudioFormat;
  sampleRate: number;
  channels: number;
}

/** 块元数据（紧跟着一条 chunk-blob 消息） */
export interface ChunkMetaMsg {
  kind: 'chunk-meta';
  chunkId: number;
  sessionId: string;
  videoTimeAtStartSec: number;
  videoTimeAtEndSec: number;
  chunkDurationSec: number;
}

/** 块音频二进制（紧跟在 chunk-meta 之后） */
export interface ChunkBlobMsg {
  kind: 'chunk-blob';
  chunkId: number;
  buffer: ArrayBuffer;
}

/** 会话结束 */
export interface EndMsg {
  kind: 'end';
  sessionId: string;
}

export type ContentToBgMsg = StartMsg | ChunkMetaMsg | ChunkBlobMsg | EndMsg;

// ============ background → content（chrome.runtime，回送后端响应） ============

export interface AsrResultRelCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AsrResultMsg {
  type: 'asr_result';
  chunkId: number;
  sessionId: string;
  videoTimeAtStartSec: number;
  detectedLang: LangCode;
  cues: AsrResultRelCue[];
}

export interface TranslationMsg {
  type: 'translation';
  chunkId: number;
  targetLang: LangCode;
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

export type BgToContentMsg = AsrResultMsg | TranslationMsg | ErrorMsg | StatusMsg;

// ============ popup → background（chrome.runtime） ============

export interface WsStatusMsg {
  kind: 'ws-status';
  connected: boolean;
  detail?: string;
}

export type PopupToBgMsg = WsStatusMsg;

// ============ background ↔ server（WebSocket 文本帧） ============

export interface WsStart {
  type: 'start';
  sessionId: string;
  sourceLang: SourceLang;
  targetLang: LangCode;
  audioFormat: AudioFormat;
  sampleRate: number;
  channels: number;
}

export interface WsChunk {
  type: 'chunk';
  chunkId: number;
  videoTimeAtStartSec: number;
  videoTimeAtEndSec: number;
  chunkDurationSec: number;
}

export interface WsEnd {
  type: 'end';
  sessionId: string;
}

export type WsClientMsg = WsStart | WsChunk | WsEnd | { type: 'ping' };
