// 前后端共享的核心类型（新项目精简版：仅 ASR/翻译流水线所需）
// 保持最小化，避免与已删除的 Session/Job/Upload 类型耦合

export type LanguageCode = 'zh' | 'en' | 'ja';

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerTag?: string;
  confidence?: number;
}
