export type FrameReport = { fps: number; p95: number; work: number; frames: number; };
export class FrameMeter {
  private intervals: number[] = [];
  private work: number[] = [];
  private total = 0;
  record(interval: number, work: number) {
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.intervals.push(interval); this.work.push(work); this.total++;
    if (this.intervals.length > 180) { this.intervals.shift(); this.work.shift(); }
  }
  reset() { this.intervals = []; this.work = []; this.total = 0; }
  report(): FrameReport {
    if (!this.intervals.length) return { fps: 0, p95: 0, work: 0, frames: 0 };
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const mean = this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
    return {
      fps: 1000 / mean,
      p95: sorted[Math.floor((sorted.length - 1) * .95)],
      work: this.work.reduce((a, b) => a + b, 0) / this.work.length,
      frames: this.total,
    };
  }
}
