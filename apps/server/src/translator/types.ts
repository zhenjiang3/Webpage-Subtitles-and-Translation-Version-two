import type { LanguageCode } from '@/lib/types';

export interface TranslateBatchInput {
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  texts: string[];
}

export interface TranslatorProvider {
  readonly name: string;
  translate(input: TranslateBatchInput): Promise<string[]>;
}
