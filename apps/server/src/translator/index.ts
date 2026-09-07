import type { TranslatorProvider } from './types';
import { XenovaNllbTranslatorProvider, XENOVA_BATCH_SIZE } from './xenova-nllb.provider';

export type { TranslateBatchInput } from './types';
export { XENOVA_BATCH_SIZE };

/** 当前启用的 translator provider 名称（供自检日志使用，不触发依赖加载） */
export const TRANSLATOR_PROVIDER_NAME: string = process.env.TRANSLATOR_PROVIDER ?? 'xenova-nllb';

/**
 * 翻译提供者工厂
 *  新项目仅保留本地 Xenova NLLB-200（免费零 API）：
 *    xenova-nllb → @xenova/transformers + NLLB-200-600M-distilled int8（~900MB，首次自动下载，之后离线）
 *  如未来需要 DeepL / DeepSeek，可参照参考项目原 provider 重新接入（仅改环境变量）。
 */
export function createTranslatorProvider(): TranslatorProvider {
  const provider = TRANSLATOR_PROVIDER_NAME;
  switch (provider) {
    case 'xenova-nllb':
      return new XenovaNllbTranslatorProvider();
    case 'deepl':
    case 'deepseek':
    case 'google':
      throw new Error(
        `${provider} translator provider is not included in this project. ` +
          'Please use xenova-nllb (local free) for now.',
      );
    default:
      throw new Error(`Unknown TRANSLATOR_PROVIDER: ${provider}`);
  }
}
