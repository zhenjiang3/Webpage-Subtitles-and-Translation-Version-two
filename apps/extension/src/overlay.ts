/**
 * 字幕叠加 DOM 渲染器
 * ─────────────────────────────────────────────────────────────────
 * 在视频上方覆盖一个绝对定位的 div，显示当前 cue 的原文（+译文，如果已到）。
 * 通过 video.getBoundingClientRect() 定位，监听 resize/scroll/fullscreenchange 重定位。
 * 全屏时把 overlay 挂到 document.fullscreenElement 子树，保证可见。
 */
import type { AbsoluteCue } from './timeline';

const OVERLAY_ID = 'rt-subtitle-overlay';

export class Overlay {
  private el: HTMLDivElement;
  private textEl: HTMLDivElement;
  private transEl: HTMLDivElement;
  private currentHost: ParentNode = document.body;
  private rafScheduled = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = OVERLAY_ID;
    Object.assign(this.el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: 'max-content',
      maxWidth: '90%',
      padding: '8px 16px',
      background: 'rgba(0,0,0,0.72)',
      borderRadius: '6px',
      color: '#fff',
      font: 'bold 18px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      textAlign: 'center',
      pointerEvents: 'none',
      zIndex: '2147483647',
      display: 'none',
      transform: 'translate(-50%, 0)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    });
    this.textEl = document.createElement('div');
    this.textEl.style.cssText = 'white-space: pre-wrap;';
    this.transEl = document.createElement('div');
    this.transEl.style.cssText =
      'white-space: pre-wrap; color: #fde68a; font-size: 16px; margin-top: 4px;';
    this.el.appendChild(this.textEl);
    this.el.appendChild(this.transEl);
  }

  /** 绑定到某个 video 元素：把 overlay 挂到合适的父节点，并启动定位循环 */
  attach(video: HTMLVideoElement): void {
    this.currentHost = document.body;
    // 进入全屏时把 overlay 挪进全屏元素子树，否则挪回 body
    const onFs = () => {
      const fsEl = document.fullscreenElement;
      if (fsEl && fsEl.contains(video)) {
        if (this.el.parentElement !== fsEl) fsEl.appendChild(this.el);
        this.currentHost = fsEl;
      } else if (this.el.parentElement !== document.body) {
        document.body.appendChild(this.el);
        this.currentHost = document.body;
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    this.el.dataset.fsListener = '1';
    if (!this.el.parentElement) document.body.appendChild(this.el);
    this.scheduleRelayout(video);
  }

  /** 渲染当前 cue（无 cue 时隐藏） */
  render(cue: AbsoluteCue | null): void {
    if (!cue || !cue.text) {
      this.el.style.display = 'none';
      return;
    }
    this.textEl.textContent = cue.text;
    this.transEl.textContent = cue.translated ?? '';
    this.transEl.style.display = cue.translated ? 'block' : 'none';
    this.el.style.display = 'block';
  }

  /** 定期把 overlay 移到 video 底部居中位置 */
  private scheduleRelayout(video: HTMLVideoElement): void {
    const tick = () => {
      this.relayout(video);
      this.rafScheduled = false;
      // 仍挂着才继续（detach 时移除 data-video 即停）
      if (this.el.dataset.video === 'attached' && !this.rafScheduled) {
        this.rafScheduled = true;
        requestAnimationFrame(tick);
      }
    };
    this.el.dataset.video = 'attached';
    this.rafScheduled = true;
    requestAnimationFrame(tick);
  }

  private relayout(video: HTMLVideoElement): void {
    if (!this.el.parentElement) return;
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.el.style.display = 'none';
      return;
    }
    // 计算 overlay 相对于 currentHost 的位置
    const hostRect = (this.currentHost as HTMLElement).getBoundingClientRect();
    const left = rect.left - hostRect.left + rect.width / 2;
    const top = rect.top - hostRect.top + rect.height * 0.82; // 距底 18%
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  detach(): void {
    this.el.dataset.video = 'detached';
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
  }
}
