/**
 * 内容脚本（注入到任意视频网页）
 * ─────────────────────────────────────────────────────────────────
 * 职责：
 *   1. 在 document_idle 时扫描页面上的 <video>，并监听后续动态插入的 video。
 *   2. 用户在 popup 中打开「启用字幕」后，对每个 video 启动音频捕获 + 字幕渲染。
 *   3. 通过 chrome.runtime.connect Port 把 chunk-meta / chunk-blob 转给 background
 *      （Port.postMessage 支持 Transferable ArrayBuffer，而 sendMessage 不能可靠传递）。
 *   4. 收到 background 回送的 asr_result / translation，更新 timeline 并驱动 overlay 渲染。
 *   5. 在 setInterval 循环中根据 video.currentTime 查找当前 cue 并渲染。
 *
 * 一个页面可同时存在多个 video（例如 PIP、预告片），每个 video 独立 session。
 */
import { attachToVideo, triggerDisplayMediaFallback, type Detacher } from './audio-capture';
import { Overlay } from './overlay';
import { Timeline } from './timeline';
import { getSettings, onSettingsChanged } from './settings';
import type { Settings } from './messages';
import type {
  ContentToBgMsg,
  StartMsg,
  ChunkMetaMsg,
  ChunkBlobMsg,
  EndMsg,
  BgToContentMsg,
  AsrResultMsg,
  TranslationMsg,
} from './messages';

const TAG = '[rt-sub]';

interface VideoSession {
  video: HTMLVideoElement;
  detacher: Detacher;
  timeline: Timeline;
  overlay: Overlay;
  rafId: number;
  // 存回调引用，fallback 时需要重新传给 triggerDisplayMediaFallback
  onChunk: (meta: ChunkMetaMsg, buffer: ArrayBuffer) => void;
  onStart: (sessionId: string) => void;
  onEnd: (sessionId: string) => void;
}

const sessions = new Map<HTMLVideoElement, VideoSession>();
let currentSettings: Settings | null = null;
let observer: MutationObserver | null = null;
// 持久 Port：content → background（支持 Transferable ArrayBuffer）
let bgPort: chrome.runtime.Port | null = null;
let portRetryTimer: number | null = null;

// ============ Port 连接（替代 sendMessage 传递二进制） ============

function connectBgPort(): chrome.runtime.Port | null {
  if (bgPort) return bgPort;
  try {
    bgPort = chrome.runtime.connect({ name: 'content-bg' });
    bgPort.onDisconnect.addListener(() => {
      console.warn(TAG, 'Port 断开，将在 1s 后重连');
      bgPort = null;
      if (portRetryTimer) window.clearTimeout(portRetryTimer);
      portRetryTimer = window.setTimeout(() => {
        connectBgPort();
        // 重连成功后，把所有 session 的 start 重新发给 background
        // （bfcache 或 service worker 重启后，background 丢了所有 session 状态）
        resendAllStarts();
      }, 1000);
    });
    bgPort.onMessage.addListener((msg: BgToContentMsg) => {
      handleBgMessage(msg);
    });
    console.log(TAG, '✅ 已连接到 background Port');
    return bgPort;
  } catch (e) {
    console.error(TAG, '❌ 连接 background Port 失败:', e);
    return null;
  }
}

/** Port 重连后，重发所有 session 的 start 消息 */
function resendAllStarts(): void {
  if (!currentSettings?.enabled) return;
  console.log(TAG, '🔁 重发所有 session 的 start 消息');
  for (const s of sessions.values()) {
    // 调 attachToVideo 里存的 onStart 回调
    s.onStart(s.video.dataset.rtSessionId || '');
  }
}

/** 检测 getDisplayMedia 流是否还活着（bfcache 后可能被浏览器吊销） */
function isDisplayMediaAlive(): boolean {
  const acSession = (window as any).__rtSubSession;
  if (!acSession?.displayMediaStream) return true; // 没有 displayMedia 就不算
  const tracks = acSession.displayMediaStream.getAudioTracks();
  if (tracks.length === 0) return false;
  return tracks.some((t: MediaStreamTrack) => t.readyState === 'live');
}

function sendToBg(msg: ContentToBgMsg, buffer?: ArrayBuffer): void {
  const port = connectBgPort();
  if (!port) return;
  try {
    if (buffer) {
      // @ts-expect-error Port.postMessage 类型定义不接受 Transfer 参数，但运行时支持
      port.postMessage(msg, [buffer]);
    } else {
      port.postMessage(msg);
    }
  } catch (e) {
    console.warn(TAG, 'sendToBg 失败:', e);
  }
}

function handleBgMessage(msg: BgToContentMsg): void {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'asr_result': {
      const m = msg as AsrResultMsg;
      for (const s of sessions.values()) {
        const sid = s.video.dataset.rtSessionId;
        if (sid === m.sessionId) {
          s.timeline.insertChunkCues(m.chunkId, m.videoTimeAtStartSec, m.cues);
          console.log(TAG, `📝 asr_result chunk=${m.chunkId} cues=${m.cues.length}`);
          break;
        }
      }
      break;
    }
    case 'translation': {
      const m = msg as TranslationMsg;
      for (const s of sessions.values()) {
        s.timeline.setTranslation(m.chunkId, m.texts);
      }
      break;
    }
    case 'error': {
      console.warn(TAG, '🔴 backend error:', msg);
      break;
    }
    case 'status': {
      console.log(TAG, 'ℹ️ status:', (msg as any).message);
      break;
    }
  }
}

// ============ 启停 ============

async function startOnVideo(video: HTMLVideoElement, settings: Settings): Promise<void> {
  if (sessions.has(video)) {
    console.log(TAG, 'video 已附着，跳过');
    return;
  }
  if (!video.src && !video.currentSrc && !video.querySelector('source')) {
    console.log(TAG, 'video 无 src，跳过');
    return;
  }

  // 跨域视频：尝试加 crossOrigin，让 AudioContext 能拿到真实音频
  // 注意：如果视频服务器没发 CORS 头，会触发 error event，后续 createMediaElementSource 会失败
  try {
    if (!video.crossOrigin) {
      video.crossOrigin = 'anonymous';
      console.log(TAG, '已设置 video.crossOrigin = "anonymous"');
    }
  } catch (e) {
    console.warn(TAG, '设置 crossOrigin 失败（可能只读）:', e);
  }

  console.log(TAG, '🎯 启动 audio capture on video', video.currentSrc?.slice(0, 80));

  const timeline = new Timeline();
  const overlay = new Overlay();
  overlay.attach(video);

  const onChunk = (meta: ChunkMetaMsg, buffer: ArrayBuffer): void => {
    // 先发 chunk-meta，再发 chunk-blob（顺序契约）
    sendToBg(meta);
    const blobMsg: ChunkBlobMsg = { kind: 'chunk-blob', chunkId: meta.chunkId, buffer };
    sendToBg(blobMsg, buffer);
    console.log(TAG, `📦 chunk ${meta.chunkId}: ${buffer.byteLength}B, ${meta.chunkDurationSec.toFixed(1)}s`);
  };

  const onStart = (sessionId: string): void => {
    const startMsg: StartMsg = {
      kind: 'start',
      sessionId,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      audioFormat: 'webm-opus',
      sampleRate: 48000,
      channels: 1,
    };
    sendToBg(startMsg);
    console.log(TAG, `✅ session ${sessionId} 已创建，start 已发送`);
  };

  const onEnd = (sessionId: string): void => {
    const endMsg: EndMsg = { kind: 'end', sessionId };
    sendToBg(endMsg);
    console.log(TAG, `⛔ session ${sessionId} 已结束`);
  };

  try {
    const detacher = attachToVideo(video, {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      audioFormat: 'webm-opus',
      sampleRate: 48000,
      channels: 1,
    }, onChunk, onStart, onEnd);

    // 渲染循环：每 200ms 查一次 active cue
    const rafId = window.setInterval(() => {
      if (video.readyState === 0) return;
      const cue = timeline.activeCueAt(video.currentTime);
      overlay.render(cue);
    }, 200);

    sessions.set(video, { video, detacher, timeline, overlay, rafId, onChunk, onStart, onEnd });
    console.log(TAG, '✅ session 已激活，开始捕获');

    // 监听 video 被移除（SPA 路由切换）
    video.addEventListener('emptied', () => stopOnVideo(video), { once: true });
  } catch (e) {
    console.error(TAG, '❌ attachToVideo 失败:', e);
    // overlay 已创建但没 session，清理一下
    try { overlay.detach(); } catch { /* noop */ }
  }
}

function stopOnVideo(video: HTMLVideoElement): void {
  const s = sessions.get(video);
  if (!s) return;
  try { clearInterval(s.rafId); } catch { /* noop */ }
  try { s.overlay.detach(); } catch { /* noop */ }
  try { s.detacher(); } catch { /* noop */ }
  sessions.delete(video);
  console.log(TAG, '⛔ session 已停止');
}

async function applySettings(next: Settings): Promise<void> {
  currentSettings = next;
  console.log(TAG, `⚙️ applySettings: enabled=${next.enabled} src=${next.sourceLang} tgt=${next.targetLang}`);
  if (next.enabled) {
    const videos = collectVideos();
    console.log(TAG, `📺 找到 ${videos.length} 个 video 元素`);
    for (const v of videos) {
      await startOnVideo(v, next).catch((err) => {
        console.warn(TAG, 'startOnVideo 失败:', err);
      });
    }
  } else {
    for (const v of Array.from(sessions.keys())) stopOnVideo(v);
  }
}

function collectVideos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
}

// ============ 动态 video 监听 ============

function observeDynamicVideos(): void {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    if (!currentSettings?.enabled) return;
    let newVideos: HTMLVideoElement[] = [];
    for (const mu of mutations) {
      for (const node of mu.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName === 'VIDEO') {
          newVideos.push(node as HTMLVideoElement);
        } else {
          newVideos.push(...Array.from(node.querySelectorAll<HTMLVideoElement>('video')));
        }
      }
    }
    if (newVideos.length === 0) return;
    newVideos = Array.from(new Set(newVideos));
    console.log(TAG, `🔎 MutationObserver 发现 ${newVideos.length} 个新 video`);
    for (const v of newVideos) {
      startOnVideo(v, currentSettings).catch(() => { /* noop */ });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  console.log(TAG, '✅ MutationObserver 已启动');
}

// ============ 启动 ============

/** 从 sessions 中按 sessionId 查找 */
function findSessionBySessionId(sid: string): VideoSession | undefined {
  for (const s of sessions.values()) {
    if (s.video.dataset.rtSessionId === sid) return s;
  }
  return undefined;
}

/** 静音事件：显示 fallback 按钮 */
function onSilentDetected(e: Event): void {
  const ce = e as CustomEvent<{ sessionId: string }>;
  const sid = ce.detail?.sessionId;
  if (!sid) return;
  const sess = findSessionBySessionId(sid);
  if (!sess) {
    console.warn(TAG, 'silent-detected 但找不到 session:', sid);
    return;
  }
  console.log(TAG, '🔇 检测到静音音频流（跨域 CORS 污染），显示 fallback 按钮');
  sess.overlay.showFallbackButton(async () => {
    try {
      const acSession = (window as any).__rtSubSession;
      if (!acSession) { console.error(TAG, '无法找到 audio-capture session'); return; }
      await triggerDisplayMediaFallback(acSession, sess.onChunk);
      console.log(TAG, '✅ 已切换到 getDisplayMedia 音频源，继续工作');
      sess.overlay.hideFallbackButton();
    } catch (err) {
      console.error(TAG, '❌ fallback 失败:', err);
    }
  });
}

/** bfcache restore：页面从 back/forward cache 恢复时，Port 已死，需要重建 + 检查 displayMedia */
function onPageShowFromBfcache(e: PageTransitionEvent): void {
  if (!e.persisted) return; // 不是 bfcache restore，忽略
  console.log(TAG, '♻️ 页面从 bfcache 恢复，重建 Port + 检查 getDisplayMedia');
  // 强制断开旧 Port（可能还没触发 onDisconnect）
  try { bgPort?.disconnect(); } catch { /* noop */ }
  bgPort = null;
  // 重连 Port
  connectBgPort();
  // 重发所有 start
  resendAllStarts();

  // 检查 getDisplayMedia 是否还活着
  if (!isDisplayMediaAlive()) {
    console.warn(TAG, '⚠️ getDisplayMedia 流已失效，需要用户重新授权');
    // 提示用户：显示 fallback 按钮（用户点了之后重新触发 getDisplayMedia）
    for (const s of sessions.values()) {
      if (!s.overlay) continue;
      s.overlay.showFallbackButton(async () => {
        try {
          const acSession = (window as any).__rtSubSession;
          if (acSession) {
            await triggerDisplayMediaFallback(acSession, s.onChunk);
            console.log(TAG, '✅ 重新触发 getDisplayMedia 成功');
            s.overlay.hideFallbackButton();
          }
        } catch (err) {
          console.error(TAG, '❌ 重试 getDisplayMedia 失败:', err);
        }
      });
    }
  }
}

(async function init() {
  try {
    console.log(TAG, '🚀 content script init — 页面 URL:', location.href);
    connectBgPort();
    const settings = await getSettings();
    console.log(TAG, `📥 加载 settings: enabled=${settings.enabled}`);
    await applySettings(settings);
    onSettingsChanged((next) => { void applySettings(next); });
    observeDynamicVideos();
    document.addEventListener('rt-sub-silent-detected', onSilentDetected);
    window.addEventListener('pageshow', onPageShowFromBfcache);
    console.log(TAG, '🎉 content script 初始化完成');
  } catch (e) {
    console.error(TAG, '❌ 初始化失败:', e);
  }
})();
