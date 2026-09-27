import { describe, expect, it } from 'vitest';
import { FrameMeter } from './FrameMeter';

describe('real display-frame measurement', () => {
  it('reports measured 60 Hz, not a configured target', () => {
    const meter = new FrameMeter();
    for (let i = 0; i < 240; i++) meter.record(1000 / 60, .8);
    expect(meter.report().fps).toBeCloseTo(60);
    expect(meter.report().p95).toBeCloseTo(1000 / 60);
    expect(meter.report().frames).toBe(240);
  });
  it('reports missed frames rather than concealing them', () => {
    const meter = new FrameMeter();
    for (let i = 0; i < 120; i++) meter.record(1000 / 30, 3);
    expect(meter.report().fps).toBeCloseTo(30);
  });
  it('resets between scenes without concealing long visible stalls', () => {
    const meter = new FrameMeter();
    meter.record(0, 1); meter.record(NaN, 1);
    expect(meter.report().frames).toBe(0);
    meter.record(600, 1);
    expect(meter.report().fps).toBeCloseTo(1000 / 600);
    meter.record(16.67, 1); meter.reset();
    expect(meter.report()).toEqual({ fps: 0, p95: 0, work: 0, frames: 0 });
  });
});
