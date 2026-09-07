/**
 * 音频捕获器
 * ─────────────────────────────────────────────────────────────────
 * 优先用 AudioContext.createMediaElementSource(video) 抽取视频音频。
 * 若检测到连续小 chunk（<100B 连续 3 次），判定为跨域 CORS 污染，
 * 自动 fallback 到 navigator.mediaDevices.getDisplayMedia 抓标签页音频
 * （绕过 CORS，抓的是浏览器最终渲染后的音频输出）。
 *
 * 每 12 秒调用 recorder.requestData() 切出一个 webm/opus 块，
 * 在切那一刻记录 video.currentTime 作为块起点，确保时间戳映射精确。
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
  ctx: AudioContext | null;
  srcNode: MediaElementAudioSourceNode | null;
  stream: MediaStream;           // 当前录制用的流（createMediaElementSource 或 displayMedia）
  chunkIdCounter: number;
  chunkStartVideoSec: number;
  timer: number | null;
  // 静音检测
  silentCount: number;
  fallbackApplied: boolean;
  fallbackRequested: boolean;
  opts: CaptureOpts;
  // getDisplayMedia 的 stream（detach 时要 stop tracks）
  displayMediaStream: MediaStream | null;
  // 定时器引用，方便 fallback 时重绑
  requestDataTimer: number | null;
}

const CHUNK_INTERVAL_MS = 12000;
const SILENT_THRESHOLD_BYTES = 100;  // opus 编码的真实音频块至少 500B+
const SILENT_DETECTION_WINDOW = 3;   // 连续 3 个小 chunk 判为污染

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
 * 创建一个 recorder，按 12s 间隔驱动 requestData
 */
function startRecorder(
  session: VideoSession,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
): void {
  const mime = pickMime();
  const recorder = new MediaRecorder(session.stream, {
    ...(mime ? { mimeType: mime } : {}),
    audioBitsPerSecond: 64000,
  });

  recorder.ondataavailable = async (e: BlobEvent) => {
    if (e.data.size === 0) return;
    // 静音检测：连续小 chunk 判定为 CORS 污染
    if (e.data.size < SILENT_THRESHOLD_BYTES) {
      session.silentCount++;
      if (!session.fallbackApplied && !session.fallbackRequested && session.silentCount >= SILENT_DETECTION_WINDOW) {
        console.warn('[audio-capture] 🔇 连续检测到', session.silentCount, '个静音 chunk（<100B），判定为跨域 CORS 污染');
        // 只标记！getDisplayMedia 必须从用户手势中调用，不能在这里自动触发
        // content.ts 会监听 __rtSubSilentDetected 事件，然后在 overlay 上显示 fallback 按钮
        session.fallbackRequested = true;
        try {
          document.dispatchEvent(new CustomEvent('rt-sub-silent-detected', { detail: { sessionId: session.sessionId } }));
        } catch { /* noop */ }
      }
    } else {
      session.silentCount = 0;
    }

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
}

/** 从 session 中获取 video.currentTime（如果有 video 引用） */
function getVideoTime(session: VideoSession): number {
  // createMediaElementSource 路径：session 里存 video；getDisplayMedia 路径：我们需要另外存
  // 简化处理：session 上加 video 引用
  const v = (session as any)._video as HTMLVideoElement | undefined;
  if (v && v.readyState > 0 && !isNaN(v.currentTime)) return v.currentTime;
  // 没有 video 或 video 不可用：用 performance.now() 近似（fallback 路径下只能这样）
  return (performance.now() / 1000) % 36000;
}

/**
 * 触发 getDisplayMedia fallback：抓标签页音频，替换 recorder 的底层 stream
 *
 * 注意：getDisplayMedia 需要用户手势！这个函数必须从用户点击的回调中调用。
 * 如果从自动定时器中调用会被浏览器拒绝。
 *
 * 因此：当静音检测触发时，我们只是设置标记 + 在 overlay 上显示按钮，
 * 用户点击按钮后才真正调用本函数。本函数暴露为 public，供 content.ts 使用。
 */
export async function triggerDisplayMediaFallback(
  session: VideoSession,
  onChunk: (meta: ChunkMetaMsg, blob: ArrayBuffer) => void,
): Promise<void> {
  try {
    console.log('[audio-capture] 🎙️ 调用 getDisplayMedia（可能需要用户点击授权）...');
    // preferCurrentTab: true 让 Chrome 默选中当前标签页，用户只需确认一次
    const stream = await (navigator.mediaDevices as any).getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true,
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // 先停掉所有 track，否则 GPU 还在抓视频帧
      stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      throw new Error('getDisplayMedia 返回的流没有音频轨道');
    }

    // 只留音频轨道，立刻释放视频轨道 → 解决 GPU 过载导致的视频卡顿
    stream.getVideoTracks().forEach((t: MediaStreamTrack) => t.stop());
    const audioOnlyStream = new MediaStream(audioTracks);

    // 停掉旧 recorder
    try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* noop */ }
    if (session.requestDataTimer) {
      window.clearInterval(session.requestDataTimer);
      session.requestDataTimer = null;
    }
    // 停掉旧 AudioContext（如果有）
    try { session.srcNode?.disconnect(); } catch { /* noop */ }
    try { session.ctx?.close(); } catch { /* noop */ }

    // 停掉旧 displayMedia tracks（如果之前有）
    session.displayMediaStream?.getTracks().forEach((t) => t.stop());

    // 切换到新流
    session.ctx = null;
    session.srcNode = null;
    session.stream = audioOnlyStream;
    session.displayMediaStream = stream; // 保留整个 stream 以便 detach 时 stop 所有 tracks
    session.chunkStartVideoSec = getVideoTime(session);

    // 重新启动 recorder
    startRecorder(session, onChunk);
    console.log('[audio-capture] ✅ fallback 完成，已切换到 getDisplayMedia 音频源');
  } catch (e) {
    console.error('[audio-capture] ❌ getDisplayMedia 失败（可能需要用户授权）:', e);
    session.fallbackApplied = false; // 允许用户重试
    throw e;
  }
}

/** 把 video 接入 createMediaElementSource，返回 session 供 fallback 使用 */
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

  const session: VideoSession = {
    sessionId,
    recorder: null as any,
    ctx,
    srcNode,
    stream: dest.stream,
    chunkIdCounter: 0,
    chunkStartVideoSec: video.currentTime,
    timer: 0,
    silentCount: 0,
    fallbackApplied: false,
    fallbackRequested: false,
    opts,
    displayMediaStream: null,
    requestDataTimer: null,
  };
  (session as any)._video = video; // 存 video 引用给 getVideoTime 用

  // 跨域设置
  try {
    if (!video.crossOrigin) video.crossOrigin = 'anonymous';
  } catch { /* noop */ }

  startRecorder(session, onChunk);

  // 暂停/恢复跟随视频（但只影响 createMediaElementSource 路径）
  const onPause = () => {
    if (session.recorder.state === 'recording') {
      try { session.recorder.pause(); } catch { /* noop */ }
    }
  };
  const onPlay = () => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (session.recorder.state === 'paused') {
      try { session.recorder.resume(); } catch { /* noop */ }
    }
  };
  video.addEventListener('pause', onPause);
  video.addEventListener('play', onPlay);

  try { video.dataset.rtSessionId = sessionId; } catch { /* noop */ }

  onStart(sessionId);

  // 把 session 暴露到 window 上，供 overlay 按钮点击后调用 fallback
  (window as any).__rtSubSession = session;

  return () => {
    try { if (video.dataset.rtSessionId === sessionId) delete video.dataset.rtSessionId; } catch { /* noop */ }
    video.removeEventListener('pause', onPause);
    video.removeEventListener('play', onPlay);
    try { if (session.requestDataTimer) window.clearInterval(session.requestDataTimer); } catch { /* noop */ }
    try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* noop */ }
    onEnd(sessionId);
    try { srcNode.disconnect(dest); } catch { /* noop */ }
    try { ctx.close(); } catch { /* noop */ }
    session.displayMediaStream?.getTracks().forEach((t) => t.stop());
    if ((window as any).__rtSubSession === session) {
      (window as any).__rtSubSession = null;
    }
  };
}

/** 监听 document 首次用户手势 → 用于 AudioContext.resume()（autoplay 策略） */
export function installAutoplayResume(): void {
  const resumeAll = () => {
    const sess = (window as any).__rtSubSession as VideoSession | undefined;
    if (sess?.ctx?.state === 'suspended') sess.ctx.resume().catch(() => {});
  };
  document.addEventListener('pointerdown', resumeAll, { once: true });
  document.addEventListener('keydown', resumeAll, { once: true });
}
