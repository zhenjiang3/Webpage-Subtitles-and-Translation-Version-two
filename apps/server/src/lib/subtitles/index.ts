import type { SubtitleCue } from '@/lib/types';
import { formatSrtTime, formatVttTime } from '@/lib/time';

// ========================= SRT =========================

const SRT_TIME_REGEX =
  /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function srtTimestampToMs(match: RegExpMatchArray): [number, number] {
  const start =
    parseInt(match[1], 10) * 3600_000 +
    parseInt(match[2], 10) * 60_000 +
    parseInt(match[3], 10) * 1000 +
    parseInt(match[4], 10);
  const end =
    parseInt(match[5], 10) * 3600_000 +
    parseInt(match[6], 10) * 60_000 +
    parseInt(match[7], 10) * 1000 +
    parseInt(match[8], 10);
  return [start, end];
}

/** 解析 SRT 字符串 → SubtitleCue[] */
export function parseSrt(srt: string): SubtitleCue[] {
  const normalized = srt.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let idx = 0;
    // 可选的序号行
    let index: number = cues.length + 1;
    if (/^\d+$/.test(lines[idx])) {
      index = parseInt(lines[idx], 10);
      idx += 1;
    }
    if (idx >= lines.length) continue;

    const timeMatch = lines[idx].match(SRT_TIME_REGEX);
    if (!timeMatch) continue;
    const [startMs, endMs] = srtTimestampToMs(timeMatch);
    idx += 1;

    const text = lines.slice(idx).join('\n').trim();
    if (text.length === 0) continue;

    cues.push({ index, startMs, endMs, text });
  }

  return cues;
}

/** SubtitleCue[] → SRT 字符串 */
export function toSrt(cues: SubtitleCue[]): string {
  if (!cues || cues.length === 0) return '';

  return cues
    .map((cue, i) => {
      const index = cue.index > 0 ? cue.index : i + 1;
      const start = formatSrtTime(cue.startMs);
      const end = formatSrtTime(cue.endMs);
      const text = cue.text.replace(/\r/g, '').trim();
      return `${index}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

// ========================= WebVTT =========================

/** SubtitleCue[] → WebVTT 字符串 */
export function toVtt(cues: SubtitleCue[]): string {
  const header = 'WEBVTT\n\n';
  if (!cues || cues.length === 0) return header;

  const body = cues
    .map((cue, i) => {
      const index = cue.index > 0 ? cue.index : i + 1;
      const start = formatVttTime(cue.startMs);
      const end = formatVttTime(cue.endMs);
      const text = cue.text.replace(/\r/g, '').trim();
      return `${index}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');

  return header + body;
}

/** 简单 VTT → SubtitleCue[] 解析（V1 不处理 cue settings） */
export function parseVtt(vtt: string): SubtitleCue[] {
  if (!vtt) return [];
  const withoutHeader = vtt.replace(/^WEBVTT[^\n]*\n*/, '').trim();
  // 时间格式与 SRT 相同，只是分隔符是 "." 而非 ","
  const asSrt = withoutHeader.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
  return parseSrt(asSrt);
}
