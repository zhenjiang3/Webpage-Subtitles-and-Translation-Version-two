/**
 * 弹窗 UI 脚本
 * ─────────────────────────────────────────────────────────────────
 * - 加载/保存设置到 chrome.storage.local
 * - 周期查询 background 的 WebSocket 连接状态，更新 dot + 文案
 */
import { getSettings, saveSettings } from './settings';
import type { Settings, WsStatusMsg } from './messages';

function elById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function load(): Promise<Settings> {
  const s = await getSettings();
  const enabledEl = elById<HTMLInputElement>('enabled');
  const srcEl = elById<HTMLSelectElement>('sourceLang');
  const tgtEl = elById<HTMLSelectElement>('targetLang');
  if (enabledEl) enabledEl.checked = s.enabled;
  if (srcEl) srcEl.value = s.sourceLang;
  if (tgtEl) tgtEl.value = s.targetLang;
  return s;
}

function bindChanges(): void {
  const enabledEl = elById<HTMLInputElement>('enabled');
  const srcEl = elById<HTMLSelectElement>('sourceLang');
  const tgtEl = elById<HTMLSelectElement>('targetLang');
  enabledEl?.addEventListener('change', () => {
    if (enabledEl) void saveSettings({ enabled: enabledEl.checked });
  });
  srcEl?.addEventListener('change', () => {
    if (srcEl) void saveSettings({ sourceLang: srcEl.value as Settings['sourceLang'] });
  });
  tgtEl?.addEventListener('change', () => {
    if (tgtEl) void saveSettings({ targetLang: tgtEl.value as Settings['targetLang'] });
  });
}

// ============ 后端连接状态显示 ============

function setStatus(connected: boolean, detail?: string): void {
  const dot = document.getElementById('dot');
  const txt = document.getElementById('statusText');
  if (dot) dot.classList.toggle('ok', connected);
  if (txt) {
    txt.textContent = detail ?? (connected ? '后端已连接' : '后端未连接');
  }
}

function queryStatus(): void {
  const msg: WsStatusMsg = { kind: 'ws-status', connected: false };
  try {
    chrome.runtime.sendMessage(msg, (resp: WsStatusMsg | undefined) => {
      if (chrome.runtime.lastError) {
        setStatus(false, '扩展未启动');
        return;
      }
      if (!resp) {
        // background 已回复但无返回值，按当前缓存状态显示
        return;
      }
      setStatus(resp.connected, resp.detail);
    });
  } catch {
    setStatus(false, '扩展未启动');
  }
}

chrome.runtime.onMessage.addListener((msg: WsStatusMsg) => {
  if (!msg || (msg as any).kind !== 'ws-status') return false;
  setStatus(msg.connected, msg.detail);
  return false;
});

void load();
bindChanges();
queryStatus();
// 周期刷新状态（每 2 秒），便于 background 重连后看到新状态
setInterval(queryStatus, 2000);
