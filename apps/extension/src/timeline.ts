/**
 * 每视频一条时间线：把后端回送的相对 cue 映射为绝对视频时间，并按 video.currentTime 查找当前 cue。
 *
 * 关键不变量：
 *   - cues 始终按 startVideoSec 升序（即使 chunk 乱序到达）
 *   - cue 时间戳 = 该 chunk 的 videoTimeAtStartSec + 相对 startSec（秒）
 *   - 翻译结果按 chunkId 回填到对应 cue 的 translated 字段
 */
import type { AsrResultRelCue } from './messages';

const MAX_CUES = 2000; // 超长视频上限，FIFO 淘汰

export interface AbsoluteCue {
  chunkId: number;
  startVideoSec: number;
  endVideoSec: number;
  text: string;
  translated?: string;
}

export class Timeline {
  private cues: AbsoluteCue[] = [];

  /** 插入一个 chunk 产生的若干相对 cue（自动映射为绝对视频时间） */
  insertChunkCues(chunkId: number, videoTimeAtStartSec: number, relCues: AsrResultRelCue[]): void {
    for (const r of relCues) {
      const abs: AbsoluteCue = {
        chunkId,
        startVideoSec: videoTimeAtStartSec + r.startSec,
        endVideoSec: videoTimeAtStartSec + r.endSec,
        text: r.text,
      };
      this.insertSorted(abs);
    }
    // 超长视频：超出上限则丢弃最老的
    if (this.cues.length > MAX_CUES) {
      this.cues.splice(0, this.cues.length - MAX_CUES);
    }
  }

  /** 按 chunkId 回填翻译 */
  setTranslation(chunkId: number, texts: string[]): void {
    // 收集该 chunkId 下所有 cue（按 startVideoSec 顺序）
    const idxList: number[] = [];
    for (let i = 0; i < this.cues.length; i++) {
      if (this.cues[i].chunkId === chunkId) idxList.push(i);
    }
    // texts[i] 与 asr_result.cues[i] 一一对应；asr_result.cues 的顺序与 insertChunkCues 插入顺序一致
    idxList.forEach((cueIdx, j) => {
      const translated = texts[j];
      if (translated) this.cues[cueIdx].translated = translated;
    });
  }

  /** 二分查找：返回 t 时刻应显示的 cue（startVideoSec <= t <= endVideoSec） */
  activeCueAt(t: number): AbsoluteCue | null {
    if (this.cues.length === 0) return null;
    // 二分找最后一个 startVideoSec <= t
    let lo = 0;
    let hi = this.cues.length - 1;
    let candidate = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].startVideoSec <= t) {
        candidate = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (candidate === -1) return null;
    const c = this.cues[candidate];
    if (t >= c.startVideoSec && t <= c.endVideoSec) return c;
    return null;
  }

  clear(): void {
    this.cues = [];
  }

  get size(): number {
    return this.cues.length;
  }

  private insertSorted(abs: AbsoluteCue): void {
    // 找到第一个 startVideoSec > abs.startVideoSec 的位置，插入到它前面
    let lo = 0;
    let hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].startVideoSec < abs.startVideoSec) lo = mid + 1;
      else hi = mid;
    }
    this.cues.splice(lo, 0, abs);
  }
}
