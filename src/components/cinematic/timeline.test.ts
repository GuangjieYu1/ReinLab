import { describe, expect, it } from 'vitest';
import { bootMotion } from './reference/boot-motion';
import { track } from './reference/boot-tracks';
import { baselineSelectionWave, cinematicField, damp, extraction } from './reference/archive-motion';
import { BOOT_END, cameraBasis, cinematicCamera, cssCamera, DEFAULT_CELL, decryptionState, FILM_END, projectPoint, UNIT, type Vec3 } from './timeline';

describe('reference opening timing', () => {
  it('keeps all five opening acts instead of a compressed splash screen', () => {
    expect(bootMotion(2, 'LOCAL RESEARCHER').step).toBe('access');
    expect(bootMotion(4.6, 'LOCAL RESEARCHER').step).toBe('logo');
    expect(bootMotion(8, 'LOCAL RESEARCHER').step).toBe('auth');
    expect(bootMotion(15.4, 'LOCAL RESEARCHER').step).toBe('scan');
    expect(bootMotion(19, 'LOCAL RESEARCHER').step).toBe('welcome');
    expect(BOOT_END).toBe(21.92);
    expect(FILM_END).toBe(26.56);
    expect(extraction(FILM_END)).toBeCloseTo(.4, 6);
  });
  it('maps the first phrase and brand to the reference 25 fps frame points', () => {
    expect(bootMotion(1.8, 'LOCAL RESEARCHER').f).toBe(170);
    expect(bootMotion(1.8, 'LOCAL RESEARCHER').access).toBe('A');
    expect(bootMotion(3, 'LOCAL RESEARCHER').access).toBe('ACCESS PERMISSION REQUIRED');
    expect(bootMotion(8, 'LOCAL RESEARCHER').brand.every(line => line.opacity === 1)).toBe(true);
  });
  it('seeking and replaying a moment are deterministic', () => {
    const first = bootMotion(15.2, 'LOCAL RESEARCHER');
    bootMotion(20.5, 'LOCAL RESEARCHER');
    expect(bootMotion(15.2, 'LOCAL RESEARCHER')).toEqual(first);
  });
  it('reaches a complete white handoff without leaving boot branding visible', () => {
    const state = bootMotion(BOOT_END, 'LOCAL RESEARCHER');
    expect(state.backgroundOpacity).toBe(0);
    expect(state.welcomeVisible).toBe(false);
    expect(state.white).toBe(1);
  });
  it('interpolates through measured points without overshooting', () => {
    const points = [[0, 0], [1, 4], [2, 9], [3, 10]] as const;
    for (let f = 0; f <= 3; f += .02) expect(track(points, f)).toBeGreaterThanOrEqual(0);
    expect(track(points, 2)).toBe(9);
    expect(track(points, 20)).toBe(10);
  });
});

describe('array, extraction and decryption', () => {
  it('preserves two separate lifts and the pause between them', () => {
    expect(extraction(25.5)).toBe(0);
    expect(extraction(26.5)).toBeCloseTo(.4, 6);
    expect(extraction(27.4)).toBeCloseTo(.4, 6);
    expect(extraction(29)).toBeCloseTo(3.35, 6);
  });
  it('creates a spatially continuous field, not independent random card motion', () => {
    const a = cinematicField(12, 1, 24, 12, 1);
    const b = cinematicField(12.001, 1, 24, 12, 1);
    expect(Math.abs(a - b)).toBeLessThan(.01);
    expect(Number.isFinite(cinematicField(31, 3, 34, 12, 1))).toBe(true);
  });
  it('has a finite selection ripple that expires after 3.2 seconds', () => {
    expect(baselineSelectionWave(0, -.1)).toBe(0);
    expect(baselineSelectionWave(2, 4)).toBe(0);
    expect(Math.abs(baselineSelectionWave(4, .6))).toBeGreaterThan(.01);
  });
  it('extends, holds, retracts, then clears the frosted cover', () => {
    expect(decryptionState(34).line).toBe(0);
    expect(decryptionState(36.1).line).toBe(1);
    expect(decryptionState(37).clarity).toBe(0);
    expect(decryptionState(38.9).line).toBe(0);
    expect(decryptionState(39.56).clarity).toBeCloseTo(1);
  });
  it('damping preserves continuous state when reversing', () => {
    const state = { value: 0, velocity: 0 };
    damp(state, 4.05, 4.2, 1 / 60);
    const first = state.value;
    damp(state, .4, 4.2, 1 / 60);
    expect(state.value).toBeGreaterThan(first);
    expect(Number.isFinite(state.velocity)).toBe(true);
  });
});

describe('no-WebGL camera projection', () => {
  it('projects the camera aim at screen center', () => {
    const pose = cinematicCamera(28, DEFAULT_CELL);
    const [x, y] = projectPoint(pose.aim, pose);
    expect(x).toBeCloseTo(960);
    expect(y).toBeCloseTo(540);
  });
  it('forms orthogonal view axes', () => {
    const { right, up, direction } = cameraBasis(59, 19);
    const dot = (a: Vec3, b: Vec3) => a.reduce((sum, x, i) => sum + x * b[i], 0);
    expect(dot(right, up)).toBeCloseTo(0);
    expect(dot(right, direction)).toBeCloseTo(0);
    expect(dot(up, direction)).toBeCloseTo(0);
    expect(dot(direction, direction)).toBeCloseTo(1);
  });
  it('matches CSS homogeneous projection to the reference camera equations', () => {
    const pose = cinematicCamera(30, DEFAULT_CELL);
    const point: Vec3 = [-2.6, 1.5, -2.17];
    const { matrix: m, perspective: p } = cssCamera(pose);
    const v = [point[0] * UNIT, -point[1] * UNIT, point[2] * UNIT, 1];
    const transformed = [0, 1, 2].map(row => v.reduce((sum, x, col) => sum + x * m[col * 4 + row], 0));
    const actual = [960 + transformed[0] / (1 - transformed[2] / p), 540 + transformed[1] / (1 - transformed[2] / p)];
    const expected = projectPoint(point, pose);
    expect(actual[0]).toBeCloseTo(expected[0], 6);
    expect(actual[1]).toBeCloseTo(expected[1], 6);
  });
  it('keeps every frame finite over the complete array sequence', () => {
    for (let t = BOOT_END; t <= FILM_END; t += .04) {
      const projection = cssCamera(cinematicCamera(t));
      expect(projection.perspective).toBeGreaterThan(0);
      expect(projection.matrix.every(Number.isFinite)).toBe(true);
    }
  });
});
