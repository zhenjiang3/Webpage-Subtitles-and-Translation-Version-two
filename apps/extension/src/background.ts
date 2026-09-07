/**
 * 后台 service worker
 * ─────────────────────────────────────────────────────────────────
 * 职责：
 *   1. 维护与本地后端（默认 ws://127.0.0.1:17712/ws）的单例 WebSocket 连接。
 *   2. 用 chrome.alarms 周期性 ping，连接断开时自动重连（指数退避，最大 30s）。
 *   3. 桥接 content ↔ server：
 *        - content 通过 chrome.runtime.connect Port 发 start/chunk-meta/chunk-blob
 *          （Port 支持 Transferable ArrayBuffer，比 sendMessage 可靠）。
 *        - chunk-blob 的 ArrayBuffer 直接从 Port 传输到 WebSocket 二进制帧。
 *        - 收到 server 的 asr_result/translation/error/status：forward 给 content Port。
 *   4. 响应 popup 的 ws-status 查询（sendMessage）。
 */
import type {
  ContentToBgMsg,
  StartMsg,
  ChunkMetaMsg,
  ChunkBlobMsg,
  EndMsg,
  BgToContentMsg,
  WsStatusMsg,
  WsStart,
  WsChunk,
  WsEnd,
  WsClientMsg,
} from './messages';

const WS_URL = 'ws://127.0.0.1:17712/ws';
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];

let ws: WebSocket | null = null;
let wsConnected = false;
let wsExplicitlyClosed = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Port 管理：所有 content script 的 Port 集合
const contentPorts = new Set<chrome.runtime.Port>();

// chunk-blob 的 buffer 暂存（收到 meta 后等待 blob，配对后发 WebSocket）
let pendingBlob: { meta: ChunkMetaMsg; buffer: ArrayBuffer } | null = null;
// start 消息暂存（WS 未连接时先存着）
let startBuffer: StartMsg | null = null;

// ============ WebSocket ============

function setConnected(connected: boolean, detail?: string): void {
  wsConnected = connected;
  broadcastStatus(detail);
}

function broadcastStatus(detail?: string): void {
  const msg: WsStatusMsg = { kind: 'ws-status', connected: wsConnected, detail };
  // 广播给所有 content Port
  for (const port of contentPorts) {
    try { port.postMessage(msg); } catch { /* noop */ }
  }
  // 也给 popup 发（popup 用 sendMessage 监听）
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
    if (startBuffer) {
      sendWs({ ...toWsStart(startBuffer) } as WsStart);
      startBuffer = null;
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
    forwardToContent(msg as BgToContentMsg);
  };

  ws.onerror = () => { /* onclose 统一处理 */ };

  ws.onclose = () => {
    setConnected(false, '后端连接已断开');
    ws = null;
    if (!wsExplicitlyClosed) scheduleReconnect();
  };
}

function sendWs(msg: WsClientMsg): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* noop */ }
}

function sendWsBinary(buffer: ArrayBuffer): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(buffer); } catch { /* noop */ }
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

function ensureConnected(): void {
  if (wsConnected || reconnectTimer) return;
  connectWs();
}

// ============ Port：content → bg（支持 Transferable ArrayBuffer） ============

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
  if (port.name !== 'content-bg') return;
  contentPorts.add(port);
  console.log('[bg] ✅ content Port connected');

  port.onDisconnect.addListener(() => {
    contentPorts.delete(port);
    console.log('[bg] ⛔ content Port disconnected');
  });

  port.onMessage.addListener((msg: ContentToBgMsg) => {
    handleContentMsg(msg);
  });
});

function handleContentMsg(msg: ContentToBgMsg): void {
  if (!msg || typeof msg !== 'object') return;
  switch ((msg as any).kind) {
    case 'start': {
      const s = msg as StartMsg;
      console.log(`[bg] 📨 start session=${s.sessionId}`);
      if (!wsConnected) {
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
      // 从 Port 收到的 ArrayBuffer 直接挂在 msg.buffer 上
      const buf = b.buffer;
      if (!pendingBlob || pendingBlob.meta.chunkId !== b.chunkId) {
        console.warn(`[bg] chunk-blob 无匹配 meta（chunkId=${b.chunkId}），跳过`);
        break;
      }
      const meta = pendingBlob.meta;
      pendingBlob = null;
      if (wsConnected) {
        sendWsChunk(meta, buf);
      } else {
        console.warn('[bg] chunk-blob 收到但 WS 未连接，丢弃（需要等 WS 就绪后再发 start）');
        ensureConnected();
      }
      break;
    }
    case 'end': {
      const e = msg as EndMsg;
      sendWs({ type: 'end', sessionId: e.sessionId } as WsEnd);
      break;
    }
  }
}

// ============ popup 消息（sendMessage，不走 Port） ============

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.kind === 'ws-status') {
    const resp: WsStatusMsg = { kind: 'ws-status', connected: wsConnected, detail: undefined };
    sendResponse(resp);
    return false;
  }
  return false;
});

function forwardToContent(msg: BgToContentMsg): void {
  // 广播给所有 content Port
  for (const port of contentPorts) {
    try { port.postMessage(msg); } catch { /* noop */ }
  }
  // 同时通过 tabs.sendMessage 发给当前活动 tab（兼容 sendMessage 消息）
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  });
}

// ============ alarms：周期保活 ============

const ALARM_PING = 'rt-subtitle-ping';
chrome.alarms.create(ALARM_PING, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PING) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs({ type: 'ping' });
    } else if (!wsExplicitlyClosed && !reconnectTimer) {
      scheduleReconnect();
    }
  }
});

// ============ 启动 ============

chrome.runtime.onStartup.addListener(() => { connectWs(); });
chrome.runtime.onInstalled.addListener(() => { connectWs(); });
connectWs();
