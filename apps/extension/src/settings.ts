/**
 * chrome.storage.local 包装：读写用户设置
 * 默认值：启用=false，源语言=auto，目标语言=zh
 */
import type { Settings } from './messages';

const KEY = 'subtitleSettings';

const DEFAULTS: Settings = {
  enabled: false,
  sourceLang: 'auto',
  targetLang: 'zh',
};

export async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY], (result) => {
      const stored = result[KEY] as Partial<Settings> | undefined;
      resolve({ ...DEFAULTS, ...stored });
    });
  });
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = { ...current, ...patch };
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [KEY]: next }, () => resolve());
  });
  return next;
}

/** 监听设置变更（content script 用它启停捕获） */
export function onSettingsChanged(cb: (next: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      const next = { ...DEFAULTS, ...(changes[KEY].newValue as Partial<Settings>) };
      cb(next);
    }
  });
}
