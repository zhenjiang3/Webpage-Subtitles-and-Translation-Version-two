/**
 * 后台 service worker
 * ─────────────────────────────────────────────────────────────────
 * 职责：
 *   1. 维护与本地后端（默认 ws://127.0.0.1:17712/ws）的单例 WebSocket 连接。
 *   2. 用 chrome.alarms 周期性 ping，连接断开时自动重连（指数退避，最大 30s）。
 *   3. 桥接 content ↔ server：
 *        - 收到 content 的 start/chunk-meta/end：翻译为 WS 文本帧（type:start/chunk/end）
 *          发给 server；其中 chunk-meta 之后必跟一条 chunk-blob，将其作为 binary 帧发出。
 *        - 收到 server 的 asr_result/translation/error/status：原样 chrome.runtime.sendMessage
 *          回送给当前 tab 的 content script。
 *   4. 响应 popup 的 ws-status 查询，把连接状态广播给所有 popup 实例。
 *
 * MV3 限制：service worker 会被闲置挂起，但 chrome.alarms 会唤醒它，
 *   且 onMessage 监听器在唤醒后自动恢复。WebSocket 长连接在 worker 挂起时会被
 *   浏览器断开，重启后通过 alarms 重连。
 */
import type {
  ContentToBgMsg,
  StartMsg,
  ChunkMetaMsg,
  ChunkBlobMsg,
  EndMsg,
  BgToContentMsg,
  PopupToBgMsg,
  WsStatusMsg,
  WsStart,
  WsChunk,
  WsEnd,
  WsClientMsg,
} from './messages';

const WS_URL = 'ws://127.0.0.1:17712/ws';
const ALARM_PING = 'rt-subtitle-ping';
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];

let ws: WebSocket | null = null;
let wsConnected = false;
let wsExplicitlyClosed = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// 缓冲：连接断开期间收到的 chunk 先存队列，重连后重发
let startBuffer: StartMsg | null = null;
let pendingBlob: { meta: ChunkMetaMsg; buffer: ArrayBuffer } | null = null;
let chunkBuffer: { meta: ChunkMetaMsg; buffer: ArrayBuffer }[] = [];

// ============ WebSocket ============

function setConnected(connected: boolean, detail?: string): void {
  wsConnected = connected;
  broadcastStatus(detail);
}

function broadcastStatus(detail?: string): void {
  const msg: WsStatusMsg = { kind: 'ws-status', connected: wsConnected, detail };
  chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

function connectWs(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  wsExplicitlyClosed = false;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    reconnectAttempt = 0;
    setConnected(true, '已连接后端');
    // 如果在断连期间收到了 start，重发
    if (startBuffer) {
      sendWs({ ...toWsStart(startBuffer) } as WsStart);
      startBuffer = null;
    }
    // 重发缓冲的 chunk
    while (chunkBuffer.length > 0) {
      const { meta, buffer } = chunkBuffer.shift()!;
      sendWsChunk(meta, buffer);
    }
  };

  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') return;
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // forward to content script
    forwardToContent(msg as BgToContentMsg);
  };

  ws.onerror = () => {
    // 错误细节在 onclose 中统一处理
  };

  ws.onclose = () => {
    setConnected(false, '后端连接已断开');
    ws = null;
    if (!wsExplicitlyClosed) scheduleReconnect();
  };
}

function sendWs(msg: WsClientMsg): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* noop */
  }
}

function sendWsBinary(buffer: ArrayBuffer): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(buffer);
  } catch {
    /* noop */
  }
}

function sendWsChunk(meta: ChunkMetaMsg, buffer: ArrayBuffer): void {
  const wsChunk: WsChunk = {
    type: 'chunk',
    chunkId: meta.chunkId,
    videoTimeAtStartSec: meta.videoTimeAtStartSec,
    videoTimeAtEndSec: meta.videoTimeAtEndSec,
    chunkDurationSec: meta.chunkDurationSec,
  };
  sendWs(wsChunk);
  sendWsBinary(buffer);
}

function toWsStart(s: StartMsg): WsStart {
  return {
    type: 'start',
    sessionId: s.sessionId,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    audioFormat: s.audioFormat,
    sampleRate: s.sampleRate,
    channels: s.channels,
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  setConnected(false, `等待重连 (${delay / 1000}s)`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

// ============ chrome.runtime 消息路由（content ↔ bg / popup ↔ bg） ============

chrome.runtime.onMessage.addListener((msg: ContentToBgMsg | PopupToBgMsg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  switch ((msg as any).kind) {
    case 'start': {
      const s = msg as StartMsg;
      if (!wsConnected) {
        // 缓存 start，等连接后补发
        startBuffer = s;
        ensureConnected();
      } else {
        sendWs(toWsStart(s));
      }
      break;
    }
    case 'chunk-meta': {
      const meta = msg as ChunkMetaMsg;
      pendingBlob = { meta, buffer: new ArrayBuffer(0) };
      break;
    }
    case 'chunk-blob': {
      const b = msg as ChunkBlobMsg;
      if (!pendingBlob || pendingBlob.meta.chunkId !== b.chunkId) {
        // 元数据丢失，跳过本块
        break;
      }
      const meta = pendingBlob.meta;
      pendingBlob = null;
      if (wsConnected) {
        sendWsChunk(meta, b.buffer);
      } else {
        // 缓冲到队列
        chunkBuffer.push({ meta, buffer: b.buffer });
        if (chunkBuffer.length > 16) chunkBuffer.shift(); // 限制内存
        ensureConnected();
      }
      break;
    }
    case 'end': {
      const e = msg as EndMsg;
      const wsEnd: WsEnd = { type: 'end', sessionId: e.sessionId };
      sendWs(wsEnd);
      break;
    }
    case 'ws-status': {
      // popup 主动查询：同步返回当前连接状态
      const resp: WsStatusMsg = { kind: 'ws-status', connected: wsConnected, detail: undefined };
      sendResponse(resp);
      return false; // 同步响应
    }
  }
  return false;
});

function ensureConnected(): void {
  if (wsConnected || reconnectTimer) return;
  connectWs();
}

function forwardToContent(msg: BgToContentMsg): void {
  // 广播给所有 tab 的 content script（chrome.runtime 消息默认只送到当前监听者，
  // 这里改用 tabs.sendMessage 才能精确投递到当前 tab）
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  });
}

// ============ alarms：周期 ping + 重连保活 ============

chrome.alarms.create(ALARM_PING, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PING) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs({ type: 'ping' });
    } else if (!wsExplicitlyClosed && !reconnectTimer) {
      // 长时间断连，alarm 周期性触发重连
      scheduleReconnect();
    }
  }
});

// ============ 安装/启动 ============

chrome.runtime.onStartup.addListener(() => { connectWs(); });
chrome.runtime.onInstalled.addListener(() => { connectWs(); });

// 启动 service worker 时立即尝试连接
connectWs();
