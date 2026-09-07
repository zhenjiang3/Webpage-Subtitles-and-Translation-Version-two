/**
 * 音频捕获器
 * ─────────────────────────────────────────────────────────────────
 * 策略：彻底跳过 createMediaElementSource（天生有 CORS + AudioContext
 * 挂起 + 破坏视频原生音频路由三大问题），直接用 getDisplayMedia
 * 抓标签页音频（绕过 CORS，抓浏览器最终渲染后的音频输出）。
 *
 * getDisplayMedia 的 video 约束设为 1x1 1fps，最小化 GPU 开销，
 * 避免视频卡顿。
 *
 * 每 12 秒调用 recorder.requestData() 切出一个 webm/opus 块，
 * 在切那一刻记录 video.currentTime 作为块起点，确保时间戳映射精确。
 *
 * 流程：attachToVideo → 等用户点授权按钮 → startWithDisplayMedia → 开始捕获
 */
import type { ChunkMetaMsg, SourceLang, LangCode, AudioFormat } from './messages';

export interface CaptureOpts {
  sourceLang: SourceLang;
  targetLang: LangCode;
  audioFormat: AudioFormat;
  sampleRate: number;
  channels: number;
}

export interface Detacher {
  (): void;
}

export interface AudioSession {
  sessionId: string;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;        // 当前录制用的流（getDisplayMedia 的纯音频流）
  displayMediaStream: MediaStream | null; // getDisplayMedia 返回的完整流（detach 时 stop 所有 tracks）
  chunkIdCounter: number;
  chunkStartVideoSec: number;
  requestDataTimer: number | null;
  started: boolean;                  // 是否已启动 getDisplayMedia 捕获
  opts: CaptureOpts;
}

const CHUNK_INTERVAL_MS = 12000;

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

/** 从 session 中获取 video.currentTime */
function getVideoTime(session: AudioSession): number {
  const v = (session as any)._video as HTMLVideoElement | undefined;
  if (v && v.readyState > 0 && !isNaN(v.currentTime)) return v.currentTime;
  // video 不可用：用 performance.now() 近似
  return (performance.now() / 1000) % 36000;
}

/**
 * 启动 MediaRecorder，按 12s 间隔驱动 requestData
 */
function startRecorder(
  session: AudioSession,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
): void {
  if (!session.stream) throw new Error('session.stream 为空，无法启动 recorder');

  const mime = pickMime();
  const recorder = new MediaRecorder(session.stream, {
    ...(mime ? { mimeType: mime } : {}),
    audioBitsPerSecond: 64000,
  });

  recorder.ondataavailable = async (e: BlobEvent) => {
    if (e.data.size === 0) return;

    const chunkEndVideoSec = getVideoTime(session);
    const chunkId = ++session.chunkIdCounter;
    const meta: ChunkMetaMsg = {
      kind: 'chunk-meta',
      chunkId,
      sessionId: session.sessionId,
      videoTimeAtStartSec: session.chunkStartVideoSec,
      videoTimeAtEndSec: chunkEndVideoSec,
      chunkDurationSec: chunkEndVideoSec - session.chunkStartVideoSec,
    };
    const buf = await e.data.arrayBuffer();
    onChunk(meta, buf);
    session.chunkStartVideoSec = chunkEndVideoSec;
  };

  recorder.start(0);
  session.recorder = recorder;

  // 手动驱动分块
  if (session.requestDataTimer) window.clearInterval(session.requestDataTimer);
  session.requestDataTimer = window.setInterval(() => {
    if (recorder.state === 'recording') {
      try { recorder.requestData(); } catch { /* noop */ }
    }
  }, CHUNK_INTERVAL_MS);

  console.log('[audio-capture] ✅ MediaRecorder 已启动');
}

/**
 * 核心：调用 getDisplayMedia 抓标签页音频，启动捕获。
 *
 * video 约束设为 1x1 1fps —— 浏览器仍会让用户选标签页，
 * 但 GPU 只需抓一个 1 像素的"视频"，开销接近 0，彻底解决卡顿。
 *
 * 必须从用户手势（点击事件）中调用，否则浏览器会拒绝。
 */
export async function startWithDisplayMedia(
  session: AudioSession,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
  onStarted: (sessionId: string) => void,
): Promise<void> {
  try {
    console.log('[audio-capture] 🎙️ 调用 getDisplayMedia（video=1x1 极小化 GPU 开销）...');

    // video 约束设为 1x1 1fps：GPU 几乎零开销，但浏览器仍会弹出标签页选择框
    const stream = await (navigator.mediaDevices as any).getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 },
      audio: true,
      preferCurrentTab: true,
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // 没音频轨道 → 停掉所有 track 释放 GPU
      stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      throw new Error('getDisplayMedia 返回的流没有音频轨道，请确认选了"标签页"并勾选"分享音频"');
    }

    // 停掉视频轨道（虽然已经是 1x1，但保险起见）
    stream.getVideoTracks().forEach((t: MediaStreamTrack) => t.stop());
    const audioOnlyStream = new MediaStream(audioTracks);

    // 停掉旧 recorder（如果之前有）
    try { if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* noop */ }
    if (session.requestDataTimer) {
      window.clearInterval(session.requestDataTimer);
      session.requestDataTimer = null;
    }
    // 停掉旧 displayMedia tracks（如果之前有）
    session.displayMediaStream?.getTracks().forEach((t) => t.stop());

    // 切换到新流
    session.stream = audioOnlyStream;
    session.displayMediaStream = stream;
    session.chunkStartVideoSec = getVideoTime(session);
    session.started = true;

    // 启动 recorder
    startRecorder(session, onChunk);

    // 关键！启动后立即重发 start 消息，确保后端 WebSocket 侧有 session 上下文
    // （如果 WebSocket 之前重连过，后端可能丢了 session 状态）
    onStarted(session.sessionId);

    console.log('[audio-capture] ✅ getDisplayMedia 捕获已启动，sessionId=', session.sessionId);
  } catch (e) {
    console.error('[audio-capture] ❌ getDisplayMedia 失败:', e);
    session.started = false;
    throw e;
  }
}

/**
 * 创建一个 session（不启动 recorder，等用户点授权按钮后再启动）
 */
export function attachToVideo(
  video: HTMLVideoElement,
  opts: CaptureOpts,
  _onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
  _onStart: (sessionId: string) => void,
  onEnd: (sessionId: string) => void,
): Detacher {
  const sessionId = (crypto as any).randomUUID?.() ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const session: AudioSession = {
    sessionId,
    recorder: null,
    stream: null,
    displayMediaStream: null,
    chunkIdCounter: 0,
    chunkStartVideoSec: video.currentTime,
    requestDataTimer: null,
    started: false,
    opts,
  };
  (session as any)._video = video; // 存 video 引用给 getVideoTime 用

  try { video.dataset.rtSessionId = sessionId; } catch { /* noop */ }

  // 把 session 暴露到 window 上，供 overlay 按钮点击后调用 startWithDisplayMedia
  (window as any).__rtSubSession = session;

  console.log('[audio-capture] 📍 session 已创建，等用户授权 getDisplayMedia:', sessionId);

  return () => {
    try { if (video.dataset.rtSessionId === sessionId) delete video.dataset.rtSessionId; } catch { /* noop */ }
    try { if (session.requestDataTimer) window.clearInterval(session.requestDataTimer); } catch { /* noop */ }
    try { if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* noop */ }
    onEnd(sessionId);
    session.displayMediaStream?.getTracks().forEach((t) => t.stop());
    if ((window as any).__rtSubSession === session) {
      (window as any).__rtSubSession = null;
    }
    console.log('[audio-capture] 🗑️ session 已清理:', sessionId);
  };
}

/** 监听 document 首次用户手势 → 占位（已不需要恢复 AudioContext，因为我们不用 createMediaElementSource） */
export function installAutoplayResume(): void {
  // 保留导出以兼容 content.ts 的 import，但实际已不需要
}
