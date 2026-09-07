/**
 * 本地离线 NLLB-200 翻译提供者（方案 A：零 API Key + 零 Python）
 * —— 基于 @xenova/transformers（ONNX Runtime Web / Node），单模型覆盖 200+ 语言
 * 模型：Xenova/nllb-200-distilled-600M（Meta NLLB-200 600M 参数蒸馏版，int8 量化 ONNX，~900MB）
 *   - 首次运行自动从 HuggingFace CDN 下载并缓存到系统（~/.cache/huggingface 或 node_modules/.cache）
 *   - 后续调用永久离线复用，无需网络
 * 语言对（V1 全覆盖）：中 ↔ 英、中 ↔ 日、英 ↔ 日，以及中间语言自动处理
 * 文档：https://huggingface.co/Xenova/nllb-200-distilled-600M
 */
import type { LanguageCode } from '@/lib/types';
import type { TranslateBatchInput, TranslatorProvider } from './types';

// NLLB-200 / FLORES-200 语言标记（3 字脚本标签）
// 完整列表：https://github.com/facebookresearch/flores/blob/main/flores200/README.md#languages-in-flores-200
const NLLB_LANG_TAG: Record<LanguageCode, string> = {
  zh: 'zho_Hans', // 中文简体
  en: 'eng_Latn', // 英语（拉丁）
  ja: 'jpn_Jpan', // 日语（日文汉字+假名）
};

const MODEL_ID = 'Xenova/nllb-200-distilled-600M';
/** 模型推荐一次批量 ≤15 条，避免 Node 堆内存爆掉或 ONNX OOM */
export const XENOVA_MAX_BATCH = 15;
/**
 * @xenova/transformers pipeline() 返回类型 —— 动态加载，避免 TS 类型绑定版本冲突
 *   （any 在此文件范围内已足够安全，实际调用参数仅 translate(src_lang/tgt_lang)，结构简单）
 */
type XenovaPipelineFn = any;
type XenovaTransformersMod = any;

let cachedModPromise: Promise<XenovaTransformersMod> | null = null;
let cachedPipelinePromise: Promise<XenovaPipelineFn> | null = null;

/**
 * 记录最终生效的 remoteHost（catch 分支里做可执行提示时拼接更准确）
 */
let resolvedRemoteHost: string = '';

// ============================================================================
// 🛡️ 单例安装：undici 全局 dispatcher 修复 2 类高频网络失败
//    （Xenova hub.js 内部 fetch 用 undici，不受 axios / request 代理配置影响）
//    ① 企业 MITM / 自签证书：HF_MIRROR_INSECURE=1 时跳过 TLS 校验（仅本机开发）
//    ② 公司 HTTP/HTTPS_PROXY 环境变量：自动走 undici ProxyAgent
//    注：--use-system-ca Node flag 仍优先推荐（它走 Windows 证书商店，比禁用校验安全）
// ============================================================================
(globalThis as unknown as { __XENO_UNDICI_PATCHED__?: boolean }).__XENO_UNDICI_PATCHED__ ??= (() => {
  try {
    const undici: typeof import('undici') = require('undici');
    const insecure = process.env.HF_MIRROR_INSECURE === '1';
    const connectOpts = insecure ? { rejectUnauthorized: false as const } : undefined;
    const proxyUri =
      process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.HTTP_PROXY  || process.env.http_proxy;
    // runtime dispatcher factory：不用严格 TS（undici v5/v6 Options 差异大），any 足够安全
    const factoryAny: any = (_origin: any, opts: any) =>
      new undici.Agent({ ...(opts ?? {}), connect: connectOpts });
    if (proxyUri) {
      undici.setGlobalDispatcher(new undici.ProxyAgent({ uri: proxyUri, factory: factoryAny } as any));
      // eslint-disable-next-line no-console
      console.log(`[xenova-nllb] undici ProxyAgent → ${proxyUri}${insecure ? ' (insecure)' : ''}`);
    } else {
      undici.setGlobalDispatcher(new undici.Agent({ connect: connectOpts }));
      if (insecure) {
        // eslint-disable-next-line no-console
        console.log('[xenova-nllb] HF_MIRROR_INSECURE=1：已禁用 TLS 证书校验（仅限本机开发）');
      }
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[xenova-nllb] 无法配置 undici dispatcher（不致命，走默认 fetch）：',
      (e as Error).message);
    return false;
  }
})();

/**
 * 加载 @xenova/transformers（单例懒加载）。
 *
 * 📌 Sharp 原生二进制：pnpm overrides 在 workspace 层面把 sharp 替换为 stub。
 * 📌 HuggingFace 网络/证书：见上方 undici dispatcher + 下方 env.remoteHost 配置。
 */
function loadTransformers(): Promise<XenovaTransformersMod> {
  if (cachedModPromise) return cachedModPromise;

  // eslint-disable-next-line no-console
  console.log('[xenova-nllb] 开始加载 @xenova/transformers（第一次需 1-10 秒）...');

  cachedModPromise = import('@xenova/transformers')
    .then((mod) => {
      // —— 加载成功后立刻配置下载源 + 缓存目录（pipeline 创建前必须生效） ——
      //   默认用 hf-mirror.com（国内可访问，速度 >> huggingface.co 主站）
      //   可用环境变量覆盖（优先级从高到低）：
      //     XENO_REMOTE_HOST > HF_ENDPOINT > HF_MIRROR > 默认 hf-mirror.com
      const MIRROR_CN = 'https://hf-mirror.com/';
      const userRemote =
        process.env.XENO_REMOTE_HOST || process.env.HF_ENDPOINT || process.env.HF_MIRROR;
      const chosen = userRemote
        ? (userRemote.endsWith('/') ? userRemote : `${userRemote}/`)
        : MIRROR_CN;
      if (mod.env && typeof mod.env.remoteHost === 'string') mod.env.remoteHost = chosen;
      if (mod.env && process.env.XENOVA_CACHE_DIR) mod.env.cacheDir = process.env.XENOVA_CACHE_DIR;
      resolvedRemoteHost = chosen;
      // eslint-disable-next-line no-console
      console.log(`[xenova-nllb] 模型下载源：${chosen}  缓存：${mod.env?.cacheDir ?? '(xenova 默认)'}`);
      // eslint-disable-next-line no-console
      console.log('[xenova-nllb] @xenova/transformers 加载成功。');
      return mod;
    })
    .catch((e) => {
      cachedModPromise = null;
      const msg =
        '[xenova-nllb] 无法加载 @xenova/transformers，请确认已安装依赖：\n' +
        '  pnpm --filter @app/server add @xenova/transformers\n' +
        '  （若报错仍指向 sharp-win32-x64.node：在 PowerShell 新窗口执行 rebuild sharp 命令）\n' +
        '原始错误：' + ((e as Error).message ?? String(e)) + '\n' +
        (e instanceof Error && e.stack ? '调用栈：\n' + e.stack + '\n' : '');
      throw new Error(msg);
    });
  return cachedModPromise;
}

/** 单例懒加载 pipeline（同一个 pipeline 内 ONNX session 会复用，避免重复创建 ~30s 开销） */
async function getPipeline(): Promise<XenovaPipelineFn> {
  if (cachedPipelinePromise) return cachedPipelinePromise;
  cachedPipelinePromise = (async () => {
    const mod = await loadTransformers();
    // pipeline(task, modelId, opts?)
    // @xenova/transformers v2 API：返回 Promise<Pipeline>
    // 对于 translation 任务，返回 TranslationPipeline
    // 不要开 quantized=false，quantized=int8 正是我们要的（省显存/内存 4×，精度几乎不损失）
    const pipe = await mod.pipeline('translation', MODEL_ID, {
      // 建议缓存到项目根目录的 .cache，避免 Node 全局权限问题和多用户污染
      cache_dir: process.env.XENOVA_CACHE_DIR ?? undefined,
      // XENO_FORCE_LOCAL=1：离线环境 / 已手动下好模型时跳过远程下载（防止"偶发网络波动"反复触发重试）
      local_files_only: process.env.XENO_FORCE_LOCAL === '1',
      dtype: 'q8', // int8 量化（默认可能是 fp16，q8 更适合 CPU + 内存受限）
    } as object);
    return pipe;
  })().catch((e) => {
    cachedPipelinePromise = null;
    // —— 把 "fetch failed / 证书错误" 等无信息网络报错转换为带可执行修复步骤的中文提示 ——
    const rawMsg = (e instanceof Error ? e.message : String(e)) ?? '';
    const stackStr = e instanceof Error ? e.stack ?? '' : '';
    const full = (rawMsg + '\n' + stackStr).toLowerCase();
    const netKeywords = [
      'fetch failed', 'certificate', 'cert_verify', 'tls', 'ssl',
      'unable to get local issuer', 'self-signed', 'unable to verify the first',
      'enotfound', 'econnrefused', 'econnreset', 'etimedout', 'esockettimeout',
      'network request failed', 'bad gateway', '502', '504', '403 forbidden',
    ];
    if (netKeywords.some((k) => full.includes(k))) {
      const remote = resolvedRemoteHost || '(未设置，请先确保 loadTransformers() 运行过)';
      const hintLines: string[] = [
        '═══ [xenova-nllb] 模型下载失败（网络 / 证书类错误）═══',
        `  当前下载源：${remote}`,
        '  按以下优先级修复（从 ① 开始试，不行再试 ②/③）：',
        '',
        '  ① 【推荐·最安全】用 Windows 系统证书（解决企业 MITM 自签证书）',
        '     在 PowerShell 里关闭当前 dev server 后，重新启动：',
        '       cd "c:\\Users\\mengz\\Desktop\\版本二\\apps\\server"',
        '       $env:NODE_OPTIONS="--use-system-ca"; & D:\\pnpm.CMD dev',
        '',
        '  ② 仍然报证书错？临时禁用 TLS 校验（仅本机开发）',
        '     在 apps/server/.env.local 末尾加一行并重启 dev server：',
        '       HF_MIRROR_INSECURE=1',
        '',
        '  ③ HuggingFace/hf-mirror 都不通？换可用镜像',
        '     在 apps/server/.env.local 任选一行（国内镜像），重启 dev server：',
        '       XENO_REMOTE_HOST=https://hf-mirror.com/',
        '       XENO_REMOTE_HOST=https://hf-mirror.chuying.org/',
        '     或用公司/自有的 HuggingFace Endpoint：',
        '       XENO_REMOTE_HOST=https://your-hf-endpoint.example.com/',
        '',
        '  ④ 公司/学校有统一 HTTP/HTTPS 代理？',
        '     在 apps/server/.env.local 末尾加：',
        '       HTTPS_PROXY=http://127.0.0.1:7890',
        '',
        '  ⑤ 模型已经手动下载过？强制本地模式跳过网络',
        '     在 apps/server/.env.local 末尾加：',
        '       XENO_FORCE_LOCAL=1',
        '═══════════════════════════════════════════════════════════',
      ];
      throw new Error(hintLines.join('\n') + '\n—— 原始错误 ——\n' + rawMsg);
    }
    throw e;
  });
  return cachedPipelinePromise;
}

/**
 * 小批量推理（防止内存/显存爆）
 * 内部会将 texts 按 XENOVA_MAX_BATCH 分 slice 并行数 1 推理
 */
async function translateSlice(
  pipe: XenovaPipelineFn,
  texts: string[],
  srcTag: string,
  tgtTag: string,
): Promise<string[]> {
  if (texts.length === 0) return [];
  if (texts.every((t) => !t || t.trim().length === 0)) {
    return texts.map((t) => t); // 空 cue 直接返回，节省推理
  }

  const results: string[] = [];
  for (let i = 0; i < texts.length; i += XENOVA_MAX_BATCH) {
    const batch = texts.slice(i, i + XENOVA_MAX_BATCH);
    // 空 cue 占位 → 推理后按位置回填（避免空串给模型导致 <unk> 泛滥）
    const indices: number[] = [];
    const nonEmpty: string[] = [];
    batch.forEach((t, idx) => {
      if (t && t.trim().length > 0) {
        indices.push(idx);
        nonEmpty.push(t);
      }
    });

    let translated: string[] = new Array(batch.length).fill('');
    if (nonEmpty.length > 0) {
      // Xenova TranslationPipeline 输出格式：
      //   string in → { translation_text: string }
      //   string[] in → Array<{ translation_text: string }>
      const raw = await pipe(nonEmpty.length === 1 ? nonEmpty[0]! : nonEmpty, {
        src_lang: srcTag,
        tgt_lang: tgtTag,
        // max_new_tokens: 原句一般 1-2 行字幕，默认够，但放宽到 256 保险
        max_new_tokens: 256,
        do_sample: false, // 贪心解码，字幕翻译要求确定性
      } as object);
      const arr = Array.isArray(raw) ? raw : [raw];
      const outTexts = arr.map((r: { translation_text?: string }) => r?.translation_text ?? '');
      // 回填到对应位置
      indices.forEach((origIdx, j) => {
        translated[origIdx] = outTexts[j] ?? batch[origIdx] ?? '';
      });
    }
    results.push(...translated);
  }
  // 翻译后简单清洗：NLLB 偶尔会把全角半角空格乱加，去掉 trailing \u2581 等奇怪 token 字符
  return results.map((t) =>
    (t ?? '')
      .replace(/\u2581/g, ' ') // SentencePiece underscore token
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export class XenovaNllbTranslatorProvider implements TranslatorProvider {
  readonly name = 'xenova-nllb';
  /** 单例预热（可选）：构造函数阶段就启动 pipeline 加载，真正翻译时更快 */
  private readonly warmup: Promise<void>;

  constructor() {
    // 不提前抛错，等第一次翻译时再抛，避免 Next.js 启动时就因缺包卡死首页渲染
    this.warmup = getPipeline().then(() => undefined);
  }

  async translate(input: TranslateBatchInput): Promise<string[]> {
    const { sourceLang, targetLang, texts } = input;
    if (sourceLang === targetLang) return texts.map((t) => t ?? '');
    if (texts.length === 0) return [];

    const srcTag = NLLB_LANG_TAG[sourceLang];
    const tgtTag = NLLB_LANG_TAG[targetLang];
    if (!srcTag || !tgtTag) {
      throw new Error(
        `[xenova-nllb] 不支持的语言对：${sourceLang} → ${targetLang}（V1 仅支持 zh/en/ja）`,
      );
    }

    // 等待 pipeline 初始化（首次 ~30s-3min，取决于网络和磁盘）
    let pipe: XenovaPipelineFn;
    try {
      pipe = await Promise.race([
        getPipeline(),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(
              new Error(
                `[xenova-nllb] pipeline 初始化超时（首次启动需下载模型 ~900MB，请耐心等待或检查网络）。` +
                  `\n可提前运行如下命令做预热：node -e "import('@xenova/transformers').then(m=>m.pipeline('translation','${MODEL_ID}').then(()=>console.log('OK')))"`,
              ),
            );
          }, 10 * 60 * 1000),
        ),
      ]);
    } catch (e) {
      void this.warmup; // 让 warmup 继续走（不阻断）
      throw e;
    }

    // 全量按 slice 分批翻译
    const out = await translateSlice(pipe, texts, srcTag, tgtTag);

    // 长度兜底：NLLB 偶尔因为超长输入导致整条丢失，这里按原文回填
    if (out.length !== texts.length) {
      const padded = new Array(texts.length).fill('');
      for (let i = 0; i < Math.min(out.length, texts.length); i++) {
        padded[i] = out[i] ?? texts[i] ?? '';
      }
      for (let i = out.length; i < texts.length; i++) {
        padded[i] = texts[i] ?? '';
      }
      return padded;
    }

    // 对于空 cue 翻译后空白的，保留原文避免空字符串在编辑器里显得像"丢翻译"
    return out.map((t, i) => (t.length === 0 && (texts[i] ?? '').length > 0 ? (texts[i] as string) : t));
  }
}

/**
 * 对外批量工具 —— 直接复用 xenova slice 的 15 条分片（不要再套 50 条）
 * 但为了保持 scheduler 里 translateInBatches 的 100% 兼容（它按 50 条分片 + 进度），
 * 我们允许它继续分片；translateInBatches 传进来的每一批 ≤50，
 * XenovaNllbTranslatorProvider.translate 内部再按 15 条一小片跑就行，内存无压力。
 */
export const XENOVA_BATCH_SIZE = 50; // 给 translateInBatches 用；内部还会 15 条微批
