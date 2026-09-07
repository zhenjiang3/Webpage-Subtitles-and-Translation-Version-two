import type { LanguageCode } from '@/lib/types';

export interface LanguageOption {
  code: LanguageCode;
  label: string;
  flag: string;
  deeplCode?: string; // DeepL 目标语代码（ZH → ZH，JA → JA，EN → EN-US）
}

/** V1 支持的 3 种语言 */
export const LANGUAGES: LanguageOption[] = [
  { code: 'zh', label: '简体中文', flag: '🇨🇳', deeplCode: 'ZH' },
  { code: 'en', label: 'English', flag: '🇺🇸', deeplCode: 'EN-US' },
  { code: 'ja', label: '日本語', flag: '🇯🇵', deeplCode: 'JA' },
];

export function getLanguageLabel(code: LanguageCode | string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export function getLanguageFlag(code: LanguageCode | string): string {
  return LANGUAGES.find((l) => l.code === code)?.flag ?? '🌐';
}

export function getDeeplCode(code: LanguageCode): string {
  return LANGUAGES.find((l) => l.code === code)?.deeplCode ?? code.toUpperCase();
}

/** ISO 639-1 → Whisper 语言提示（提升识别准确率） */
export function getWhisperLangHint(code: LanguageCode): string {
  switch (code) {
    case 'zh':
      return 'Chinese';
    case 'en':
      return 'English';
    case 'ja':
      return 'Japanese';
    default:
      return '';
  }
}
