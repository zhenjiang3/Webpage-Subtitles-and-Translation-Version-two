/**
 * 音频捕获器
 * ─────────────────────────────────────────────────────────────────
 * 策略：用 getDisplayMedia 抓标签页音频，直接在原始 stream 上录制。
 * 视频轨道设为 enabled=false（不 stop，stop 会杀死整个会话），
 * MediaRecorder 录原始 stream（含禁用的视频轨道 + 活跃的音频轨道）。
 *
 * 关键修复：
 * 1. 不用 new MediaStream(audioTracks) — Edge 可能断开连接
 * 2. 用 start(60000) 而不是 start(0) — 避免 Edge 默认 100ms timeslice
 * 3. 不 stop() 视频轨道 — 会杀死 getDisplayMedia 会话
 *    用 enabled=false — 保持会话活跃，GPU 开销极小
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
  stream: MediaStream | null;
  displayMediaStream: MediaStream | null;
  chunkIdCounter: number;
  chunkStartVideoSec: number;
  requestDataTimer: number | null;
  started: boolean;
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
  return (performance.now() / 1000) % 36000;
}

/**
 * 启动 MediaRecorder
 *
 * 关键：用 start(60000) 让 MediaRecorder 缓冲 60 秒的数据，
 * 然后我们每 12 秒手动 requestData() 切一块出来。
 * 这样避免 Edge 把 start(0) 解释成默认 100ms timeslice。
 */
function startRecorder(
  session: AudioSession,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
): void {
  if (!session.stream) throw new Error('session.stream 为空');

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
    // 打印原始 Blob 大小，便于诊断
    console.log('[audio-capture] 📦 ondataavailable blob size:', e.data.size, 'bytes');
    onChunk(meta, buf);
    session.chunkStartVideoSec = chunkEndVideoSec;
  };

  // 用 60000ms timeslice：MediaRecorder 会每 60 秒自动 emit 一次，
  // 但我们每 12 秒 requestData() 提前切走数据
  recorder.start(60000);
  session.recorder = recorder;

  console.log('[audio-capture] ✅ MediaRecorder 已启动（timeslice=60s, 每12s requestData）');

  if (session.requestDataTimer) window.clearInterval(session.requestDataTimer);
  session.requestDataTimer = window.setInterval(() => {
    if (recorder.state === 'recording') {
      try { recorder.requestData(); } catch { /* noop */ }
    }
  }, CHUNK_INTERVAL_MS);
}

/**
 * 调用 getDisplayMedia，直接在原始 stream 上启动录制。
 *
 * 不创建 new MediaStream — 直接用 getDisplayMedia 返回的 stream，
 * 视频轨道设 enabled=false（禁用但不停止，保持会话活跃）。
 */
export async function startWithDisplayMedia(
  session: AudioSession,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
  onStarted: (sessionId: string) => void,
): Promise<void> {
  try {
    console.log('[audio-capture] 🎙️ 调用 getDisplayMedia...');

    const stream = await (navigator.mediaDevices as any).getDisplayMedia({
      video: { width: { ideal: 16 }, height: { ideal: 16 }, frameRate: { ideal: 1 } },
      audio: true,
      preferCurrentTab: true,
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      throw new Error('getDisplayMedia 返回的流没有音频轨道，请确认选了"标签页"并勾选"分享音频"');
    }

    // 诊断：打印原始音频轨道状态
    const at = audioTracks[0];
    console.log('[audio-capture] 🎵 原始音频轨道:', JSON.stringify({
      readyState: at.readyState,
      muted: at.muted,
      label: at.label,
      deviceId: at.getSettings()?.deviceId,
      sampleRate: at.getSettings()?.sampleRate,
    }));

    // 关键：只禁用视频轨道（enabled=false），不 stop！
    // stop() 会杀死整个 getDisplayMedia 会话
    stream.getVideoTracks().forEach((t: MediaStreamTrack) => { t.enabled = false; });

    // 创建只含音频的 MediaStream 给 MediaRecorder
    // Edge 的 MediaRecorder 不能接受"含禁用视频轨道 + audio-only mime"的 stream
    // 但新 MediaStream 会保持对原始轨道的引用，不会断开音频源
    const audioOnlyStream = new MediaStream(audioTracks);

    console.log('[audio-capture] 📹 视频轨道已禁用（enabled=false）');
    console.log('[audio-capture] 📊 audioOnlyStream 轨道数:', audioOnlyStream.getTracks().length,
      '活跃:', audioOnlyStream.getTracks().filter(t => t.enabled && t.readyState === 'live').length);

    // 停掉旧 recorder
    try { if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* noop */ }
    if (session.requestDataTimer) {
      window.clearInterval(session.requestDataTimer);
      session.requestDataTimer = null;
    }
    // 停掉旧 displayMedia tracks
    session.displayMediaStream?.getTracks().forEach((t) => t.stop());

    // MediaRecorder 用纯音频 stream，原始 stream 保持会话活跃
    session.stream = audioOnlyStream;
    session.displayMediaStream = stream; // 保留原始 stream 引用，detach 时 stop 所有 tracks
    session.chunkStartVideoSec = getVideoTime(session);
    session.started = true;

    // 启动 recorder
    startRecorder(session, onChunk);

    // 重发 start 消息
    onStarted(session.sessionId);

    console.log('[audio-capture] ✅ getDisplayMedia 捕获已启动，sessionId=', session.sessionId);
  } catch (e) {
    console.error('[audio-capture] ❌ getDisplayMedia 失败:', e);
    session.started = false;
    throw e;
  }
}

/** 创建 session（不启动 recorder，等用户授权） */
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
  (session as any)._video = video;

  try { video.dataset.rtSessionId = sessionId; } catch { /* noop */ }
  (window as any).__rtSubSession = session;

  console.log('[audio-capture] 📍 session 已创建:', sessionId);

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

/** 占位（无需恢复 AudioContext） */
export function installAutoplayResume(): void { }
