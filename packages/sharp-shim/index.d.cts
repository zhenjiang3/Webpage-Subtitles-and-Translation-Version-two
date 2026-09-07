// Sharp 占位类型声明（仅覆盖 V1 翻译路径会访问的属性）。
// 如果未来需要真实 sharp，替换为 `pnpm add -D @types/sharp` 的输出即可。

type ChainableStub = Record<string, (...args: unknown[]) => ChainableStub> & {
  toBuffer:    () => Promise<never>;
  toFile:      (file?: string) => Promise<never>;
  metadata:    () => Promise<never>;
  stats:       () => Promise<never>;
  arrayBuffer: () => Promise<never>;
  clone:       () => ChainableStub;
  pipe:        () => ChainableStub;
};

interface SharpShim {
  (input?: unknown, options?: unknown): ChainableStub;
  readonly Sharp:       (input?: unknown, options?: unknown) => ChainableStub;
  readonly default:     SharpShim;
  readonly concurrency: (threads?: number) => SharpShim | number;
  readonly counters:    () => { process: number; queue: number };
  readonly simd:        () => SharpShim;
  readonly cache:       (options?: unknown) => SharpShim | Record<string, number>;
  readonly queue:       () => number;
  readonly versions:    { libvips: string; sharp: string; vips: string };
  readonly format:      Readonly<Record<string, { id: string }>>;
}

declare const sharp: SharpShim;
export = sharp;
