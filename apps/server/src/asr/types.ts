import type { LanguageCode } from '@/lib/types';

export interface AsrWord {
  word: string;
  start: number; // 秒（浮点）
  end: number;
  confidence?: number;
}

export interface AsrSegment {
  start: number; // 秒
  end: number;
  text: string;
  words?: AsrWord[];
}

export interface AsrResult {
  language: LanguageCode; // 识别后判定
  durationSec: number;
  segments: AsrSegment[];
}

export interface AsrProvider {
  readonly name: string;
  transcribe(
    audioPath: string,
    opts: {
      langHint?: LanguageCode;
      onProgress?: (pct: number, stage: string) => void;
    },
  ): Promise<AsrResult>;
}
