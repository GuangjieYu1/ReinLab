import { describe, expect, it } from 'vitest';
import { OPENING_APPROACH_DURATION, OPENING_DURATION, OPENING_UNFOLD_DURATION, openingCoverTransform, openingNearRect, openingTransform } from './archiveOpening';

describe('archive opening geometry', () => {
  const source = { x: 91, y: 114, width: 593, height: 482 };
  const target = { x: 26, y: 105, width: 933, height: 1143 };
  it('gives approach and unfold the same full durations as retreat and fold', () => {
    expect(OPENING_APPROACH_DURATION).toBe(820);
    expect(OPENING_UNFOLD_DURATION).toBe(680);
    expect(OPENING_DURATION).toBe(1500);
  });
  it('starts at the archive rather than exposing the destination rectangle', () => {
    expect(openingTransform(source, target)).toBe(`translate3d(65px,9px,0) scale(${593 / 933},${482 / 1143})`);
  });
  it('keeps the archive center fixed during approach', () => {
    const near = openingNearRect(source, 1.3);
    expect(near.x + near.width / 2).toBeCloseTo(source.x + source.width / 2);
    expect(near.y + near.height / 2).toBeCloseTo(source.y + source.height / 2);
    expect(near.width / near.height).toBeCloseTo(source.width / source.height);
  });
  it('carries the same cover into the lesson rectangle in local viewport coordinates', () => {
    const frame = { x: 10, y: 20, width: 1280, height: 720 };
    expect(openingCoverTransform(source, frame)).toBe(`translate3d(81px,94px,0) scale(${593 / 500},${482 / 370})`);
    expect(openingCoverTransform(target, frame)).toBe(`translate3d(16px,85px,0) scale(${933 / 500},${1143 / 370})`);
  });
  it('finishes with an identity transform, without a final position correction', () => {
    expect(openingTransform(target, target)).toBe('translate3d(0px,0px,0) scale(1,1)');
  });
});
