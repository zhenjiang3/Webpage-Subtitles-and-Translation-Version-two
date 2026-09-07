// 时间格式化工具
// 字幕常用格式：SRT (HH:MM:SS,mmm) / VTT (HH:MM:SS.mmm) / 播放器 (M:SS)

const ONE_HOUR_MS = 3600_000;
const ONE_MIN_MS = 60_000;
const ONE_SEC_MS = 1000;

export interface ParsedTime {
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
}

export function msToParts(ms: number): ParsedTime {
  const safe = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safe / ONE_HOUR_MS);
  const minutes = Math.floor((safe % ONE_HOUR_MS) / ONE_MIN_MS);
  const seconds = Math.floor((safe % ONE_MIN_MS) / ONE_SEC_MS);
  const millis = safe % ONE_SEC_MS;
  return { hours, minutes, seconds, millis };
}

function pad(n: number, len = 2) {
  return n.toString().padStart(len, '0');
}

/** SRT 时间戳：HH:MM:SS,mmm */
export function formatSrtTime(ms: number): string {
  const { hours, minutes, seconds, millis } = msToParts(ms);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** VTT 时间戳：HH:MM:SS.mmm */
export function formatVttTime(ms: number): string {
  const { hours, minutes, seconds, millis } = msToParts(ms);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** 播放器短格式：M:SS / H:MM:SS */
export function formatPlaybackTime(ms: number): string {
  const { hours, minutes, seconds } = msToParts(ms);
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

/** 秒 → ms 的安全转换 */
export function secToMs(sec: number | string): number {
  const n = typeof sec === 'string' ? parseFloat(sec) : sec;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}
