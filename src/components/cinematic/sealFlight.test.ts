import { describe, expect, it } from 'vitest';
import { flightQuad, matrixFor, rectQuad, type Quad } from './sealFlight';

const project = (matrix: string, x: number, y: number) => {
  const v = matrix.slice(9, -1).split(',').map(Number);
  const w = v[3] * x + v[7] * y + v[15];
  return [(v[0] * x + v[4] * y + v[12]) / w, (v[1] * x + v[5] * y + v[13]) / w];
};

describe('seal flight', () => {
  it('maps a box onto itself as the identity', () => {
    const corners = [[0, 0], [200, 0], [0, 200], [200, 200]];
    const matrix = matrixFor(200, 200, rectQuad(0, 0, 200, 200));
    corners.forEach(([x, y]) => expect(project(matrix, x, y).map(n => Math.round(n))).toEqual([x, y]));
  });
  it('lands every corner on an oblique quad', () => {
    const quad: Quad = [[100, 50], [300, 80], [120, 260], [280, 300]];
    const matrix = matrixFor(200, 200, quad);
    [[0, 0], [200, 0], [0, 200], [200, 200]].forEach(([x, y], index) => {
      const [px, py] = project(matrix, x, y);
      expect(px).toBeCloseTo(quad[index][0], 1); expect(py).toBeCloseTo(quad[index][1], 1);
    });
  });
  it('starts at the source and ends exactly on the target', () => {
    const from = rectQuad(0, 0, 100, 100), to: Quad = [[10, 20], [90, 30], [15, 120], [95, 110]];
    expect(flightQuad(from, to, 0)).toEqual(from);
    flightQuad(from, to, 1).forEach(([x, y], index) => { expect(x).toBeCloseTo(to[index][0], 6); expect(y).toBeCloseTo(to[index][1], 6); });
  });
});
