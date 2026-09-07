/**
 * 内容脚本（注入到任意视频网页）
 * ─────────────────────────────────────────────────────────────────
 * 职责：
 *   1. 在 document_idle 时扫描页面上的 <video>，并监听后续动态插入的 video。
 *   2. 用户在 popup 中打开「启用字幕」后，对每个 video 启动音频捕获 + 字幕渲染。
 *   3. 通过 chrome.runtime.sendMessage 把 chunk-meta / chunk-blob 转给 background。
 *   4. 收到 background 回送的 asr_result / translation，更新 timeline 并驱动 overlay 渲染。
 *   5. 在 requestAnimationFrame 循环中根据 video.currentTime 查找当前 cue 并渲染。
 *
 * 一个页面可同时存在多个 video（例如 PIP、预告片），每个 video 独立 session。
 */
import { attachToVideo, type Detacher } from './audio-capture';
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

interface VideoSession {
  video: HTMLVideoElement;
  detacher: Detacher;
  timeline: Timeline;
  overlay: Overlay;
  rafId: number;
}

const sessions = new Map<HTMLVideoElement, VideoSession>();
let currentSettings: Settings | null = null;
let observer: MutationObserver | null = null;

// ============ 启停 ============

async function startOnVideo(video: HTMLVideoElement, settings: Settings): Promise<void> {
  if (sessions.has(video)) return; // 已附着
  if (!video.src && !video.currentSrc && !video.querySelector('source')) {
    // 没有可用源的 video 元素不处理
    return;
  }

  const timeline = new Timeline();
  const overlay = new Overlay();
  overlay.attach(video);

  // 捕获回调：把 meta+blob 一前一后转发给 background
  const onChunk = (meta: ChunkMetaMsg, buffer: ArrayBuffer): void => {
    // 先发 chunk-meta，再发 chunk-blob（顺序契约）
    sendToBg(meta);
    const blobMsg: ChunkBlobMsg = { kind: 'chunk-blob', chunkId: meta.chunkId, buffer };
    sendToBg(blobMsg);
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
  };

  const onEnd = (sessionId: string): void => {
    const endMsg: EndMsg = { kind: 'end', sessionId };
    sendToBg(endMsg);
  };

  const detacher = attachToVideo(video, {
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    audioFormat: 'webm-opus',
    sampleRate: 48000,
    channels: 1,
  }, onChunk, onStart, onEnd);

  // 渲染循环
  const rafId = window.setInterval(() => {
    if (video.readyState === 0) return;
    const cue = timeline.activeCueAt(video.currentTime);
    overlay.render(cue);
  }, 200);

  sessions.set(video, { video, detacher, timeline, overlay, rafId });

  // 监听 video 被移除（SPA 路由切换）
  const onRemoved = () => stopOnVideo(video);
  video.addEventListener('emptied', onRemoved, { once: true });
}

function stopOnVideo(video: HTMLVideoElement): void {
  const s = sessions.get(video);
  if (!s) return;
  try { clearInterval(s.rafId); } catch { /* noop */ }
  try { s.overlay.detach(); } catch { /* noop */ }
  try { s.detacher(); } catch { /* noop */ }
  sessions.delete(video);
}

async function applySettings(next: Settings): Promise<void> {
  currentSettings = next;
  if (next.enabled) {
    // 对当前页面所有 video 启动（已有 session 的会被 skip）
    const videos = collectVideos();
    for (const v of videos) {
      await startOnVideo(v, next).catch(() => { /* 单 video 失败不影响其它 */ });
    }
  } else {
    // 停止所有 session
    for (const v of Array.from(sessions.keys())) stopOnVideo(v);
  }
}

function collectVideos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
}

// ============ 与 background 的 chrome.runtime 通信 ============

function sendToBg(msg: ContentToBgMsg): void {
  try {
    chrome.runtime.sendMessage(msg, () => {
      // 吞掉 lastError：service worker 可能未就绪，丢失本块仅影响本次字幕
      void chrome.runtime.lastError;
    });
  } catch {
    /* noop */
  }
}

chrome.runtime.onMessage.addListener((msg: BgToContentMsg, _sender, _sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'asr_result': {
      const m = msg as AsrResultMsg;
      // 找到该 session 对应的 timeline（按 sessionId）
      for (const s of sessions.values()) {
        // 我们没有在 session 中存 sessionId，因为一个 video 对应一个 attach session；
        // 简单策略：把所有 timeline 都尝试插入（按 chunkId 区分），但只有匹配的 sessionId 才生效。
        // 这里我们用一个 video → sessionId 映射存到 dataset 上。
        const sid = s.video.dataset.rtSessionId;
        if (sid === m.sessionId) {
          s.timeline.insertChunkCues(m.chunkId, m.videoTimeAtStartSec, m.cues);
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
      // eslint-disable-next-line no-console
      console.warn('[rt-subtitle] backend error:', msg);
      break;
    }
    case 'status': {
      // 可选：把状态信息打到 console 便于调试
      // eslint-disable-next-line no-console
      console.log('[rt-subtitle] status:', msg.message);
      break;
    }
  }
  return false; // 不需要异步响应
});

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
    for (const v of newVideos) {
      startOnVideo(v, currentSettings).catch(() => { /* noop */ });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ============ 启动 ============

(async function init() {
  const settings = await getSettings();
  await applySettings(settings);
  onSettingsChanged((next) => { void applySettings(next); });
  observeDynamicVideos();
})();
