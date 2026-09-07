/**
 * 音频捕获器
 * ─────────────────────────────────────────────────────────────────
 * 用 AudioContext.createMediaElementSource(video) 抽取视频音频，
 * 同时连到 MediaStreamAudioDestinationNode（用于 MediaRecorder 抓取）
 * 和 ctx.destination（保持视频声音可听见）。
 *
 * 每 12 秒调用 recorder.requestData() 切出一个 webm/opus 块，
 * 在切那一刻记录 video.currentTime 作为块起点，确保时间戳映射精确。
 *
 * 关键约束：createMediaElementSource 对一个 video 元素不可逆——一旦调用，
 * 视频音频被永久路由到该 AudioContext。Detach 后建议刷新页面恢复原生声音。
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

interface VideoSession {
  sessionId: string;
  recorder: MediaRecorder;
  ctx: AudioContext;
  srcNode: MediaElementAudioSourceNode;
  chunkIdCounter: number;
  chunkStartVideoSec: number;
  timer: number;
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

/**
 * 把一个 <video> 元素接入音频捕获管线。
 * 返回 detach 函数：停止 recorder、清理定时器、断开节点。
 */
export function attachToVideo(
  video: HTMLVideoElement,
  opts: CaptureOpts,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
  onStart: (sessionId: string) => void,
  onEnd: (sessionId: string) => void,
): Detacher {
  const sessionId = (crypto as any).randomUUID?.() ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ctx = new AudioContext({ sampleRate: opts.sampleRate });
  const srcNode = ctx.createMediaElementSource(video);
  const dest = ctx.createMediaStreamDestination();
  srcNode.connect(dest);
  srcNode.connect(ctx.destination); // 保持视频声音可听见

  const mime = pickMime();
  const recorder = new MediaRecorder(dest.stream, {
    ...(mime ? { mimeType: mime } : {}),
    audioBitsPerSecond: 64000,
  });

  const session: VideoSession = {
    sessionId,
    recorder,
    ctx,
    srcNode,
    chunkIdCounter: 0,
    chunkStartVideoSec: video.currentTime,
    timer: 0,
  };

  recorder.ondataavailable = async (e: BlobEvent) => {
    if (e.data.size === 0) return;
    const chunkEndVideoSec = video.currentTime;
    const chunkId = ++session.chunkIdCounter;
    const meta: ChunkMetaMsg = {
      kind: 'chunk-meta',
      chunkId,
      sessionId,
      videoTimeAtStartSec: session.chunkStartVideoSec,
      videoTimeAtEndSec: chunkEndVideoSec,
      chunkDurationSec: chunkEndVideoSec - session.chunkStartVideoSec,
    };
    const buf = await e.data.arrayBuffer();
    onChunk(meta, buf);
    session.chunkStartVideoSec = chunkEndVideoSec;
  };

  // 手动驱动分块（不依赖 MediaRecorder 的 timeslice，因为我们精确控制 video 时间映射）
  session.timer = window.setInterval(() => {
    if (recorder.state === 'recording' && !video.paused && !video.ended) {
      try {
        recorder.requestData();
      } catch {
        /* noop */
      }
    }
  }, CHUNK_INTERVAL_MS);

  recorder.start(0);

  // 暂停/恢复跟随视频
  const onPause = () => {
    if (recorder.state === 'recording') {
      try { recorder.pause(); } catch { /* noop */ }
    }
  };
  const onPlay = () => {
    // ctx 可能因 autoplay 策略被挂起，播放是用户手势的强信号，尝试 resume
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (recorder.state === 'paused') {
      try { recorder.resume(); } catch { /* noop */ }
    }
  };
  video.addEventListener('pause', onPause);
  video.addEventListener('play', onPlay);

  // 把 sessionId 写到 video dataset，供 content.ts 在收到 asr_result 时按 sessionId 路由到对应 timeline
  try { video.dataset.rtSessionId = sessionId; } catch { /* noop */ }

  // 通知 background 会话开始
  onStart(sessionId);

  return () => {
    try { if (video.dataset.rtSessionId === sessionId) delete video.dataset.rtSessionId; } catch { /* noop */ }
    try { clearInterval(session.timer); } catch { /* noop */ }
    video.removeEventListener('pause', onPause);
    video.removeEventListener('play', onPlay);
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch { /* noop */ }
    onEnd(sessionId);
    // 注意：createMediaElementSource 不可逆。srcNode.disconnect 不能让视频声音恢复原生。
    // 用户需刷新页面才能恢复。这里仅断开 dest（停止抓取），保留 ctx.destination 让声音继续可听见。
    try { srcNode.disconnect(dest); } catch { /* noop */ }
    // 不关 ctx：关了 ctx 视频会完全没声。让 ctx 保留，仅停止抓取。
    // ctx.close() 会让视频静音，留给页面 unload 时自然清理。
  };
}

/** 监听 document 首次用户手势 → 用于 AudioContext.resume()（autoplay 策略） */
export function installAutoplayResume(getSessions: () => VideoSession[]): void {
  const resumeAll = () => {
    for (const s of getSessions()) {
      if (s.ctx.state === 'suspended') s.ctx.resume().catch(() => {});
    }
  };
  document.addEventListener('pointerdown', resumeAll, { once: true });
  document.addEventListener('keydown', resumeAll, { once: true });
}
