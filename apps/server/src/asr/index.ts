import type { AsrProvider } from './types';
import { WhisperCppProvider } from './whispercpp.provider';

/**
 * ASR 提供者工厂
 *  新项目仅保留本地 whisper.cpp（免费零 API）：
 *    whisper-cpp → 本地 whisper-cli.exe + ggml-*.bin（CPU 即可跑，无 API / 无 Python）
 *  如未来需要 OpenAI Whisper API，可参照参考项目原 provider 重新接入（仅改环境变量）。
 */
export function createAsrProvider(): AsrProvider {
  const provider = process.env.ASR_PROVIDER ?? 'whisper-cpp';
  switch (provider) {
    case 'whisper-cpp':
      return new WhisperCppProvider();
    case 'openai-whisper':
      throw new Error(
        'OpenAI Whisper API provider is not included in this project. ' +
          'Please use whisper-cpp (local free) for now.',
      );
    default:
      throw new Error(`Unknown ASR_PROVIDER: ${provider}`);
  }
}
