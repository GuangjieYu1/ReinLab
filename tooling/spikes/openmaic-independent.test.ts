import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const read = (name: string) => readFileSync(new URL(`../../evidence/P2-01/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(read(name));
const html = read('interactive.html');

// Run the unchanged sample's main script with minimal DOM controls. No rendering,
// external KaTeX, frame isolation or browser security is simulated by this harness.
type SampleSnapshot = {
  state: { x: number; iter: number; eta: number; running: boolean; ended: boolean; endReason: string };
  hud: { objective: string; gradient: string };
};
function sampleRuntime(actions: string): SampleSnapshot[] {
  const prefix = `
function control(value = '') {
 const listeners = {};
 return { value, textContent: '', className: '', disabled: false, type: '',
  classList: { toggle() {} }, style: {}, blur() {}, setAttribute() {}, appendChild() {},
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ width: 320, height: 320 }),
  getContext: () => ({ setTransform() {} }),
  addEventListener(name, callback) { listeners[name] = callback; },
  trigger(name) { if (listeners[name]) listeners[name].call(this); }, getAttribute: () => '' };
}
const nodes = new Map();
for (const id of ['experiment','canvas','initialX-slider','learningRate-slider','initialX-display','learningRate-display','hud-x','hud-f','hud-g','hud-n','hud-status','main-btn','step-btn','reset-btn']) nodes.set(id, control());
nodes.get('initialX-slider').value = '0';
nodes.get('learningRate-slider').value = '0.1';
const presets = Array.from({ length: 4 }, (_, i) => Object.assign(control(), { getAttribute: () => String(i) }));
const document = { getElementById: id => nodes.get(id), createElement: () => control(),
 querySelector: () => control(), querySelectorAll: selector => selector === '[data-preset]' ? presets : [], addEventListener() {} };
const window = { addEventListener() {}, devicePixelRatio: 1 };
function requestAnimationFrame() {}
const snapshots = [];
function snapshot() { snapshots.push({state: {...state}, hud: {objective: nodes.get('hud-f').textContent, gradient: nodes.get('hud-g').textContent}}); }
`;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const main = scripts.filter(([, attrs, body]) => !/src=|application\/json/i.test(attrs) && body.includes('function stepOnce()'));
  expect(main).toHaveLength(1);
  // Standard-input execution of the original script, with a static DOM scaffold.
  // No dynamic module loading or in-process execution API is used.
  const output = execFileSync(process.execPath, ['--input-type=commonjs'], {
    input: prefix + '\n' + main[0][2] + '\n' + actions + '\nprocess.stdout.write(JSON.stringify(snapshots));',
    encoding: 'utf8', timeout: 3000,
  });
  return JSON.parse(output);
}

describe('P2-01 independent artifact contract', () => {
  it('ties the original bytes to report and recorded browser sample without assigning provider usage', () => {
    const report = json('live-generation.json');
    const hash = createHash('sha256').update(html).digest('hex');
    expect(Buffer.byteLength(html)).toBe(report.htmlBytes);
    expect(hash).toBe(report.htmlSha256);
    expect(json('browser-test.json').sampleSha256).toBe(hash);
    expect(report).toMatchObject({ status: 200, state: 'generated', realService: true, effectiveOutlineType: 'interactive', widgetType: 'simulation', callCount: 1, providerCallCount: null, costCny: null, courseCreationEndpointCalled: false });
    expect(report.callCountScope).toContain('HTTP');
    expect(report.callCountScope).toContain('未知');
    expect(report.durationMs).toBeGreaterThan(0);
  });
  it('requests exactly one matching interactive outline and records all missing-field rejections', () => {
    const request = json('request.json');
    expect(request.allOutlines).toEqual([request.outline]);
    expect(request.outline.type).toBe('interactive');
    expect(request.stageId).toBeTruthy();
    expect(request.requirements).toMatchObject({ webSearch: false, interactiveMode: true });
    expect(json('validation.json').results).toEqual(['outline','allOutlines','stageId'].map(missing => ({ missing, status: 400, errorCode: 'MISSING_REQUIRED_FIELD' })));
  });
  it('records source equivalence independently from unknown deployment build provenance', () => {
    const manifest = json('source-manifest.json');
    expect(manifest.reference.files).toHaveLength(6);
    expect(manifest.reference.files).toEqual(manifest.deployment.files);
    expect(manifest.reference.packageVersion).toBe(manifest.deployment.packageVersion);
    expect(json('build-manifest.json').files).toHaveLength(3);
    for (const f of json('build-manifest.json').files) expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('unchanged generated sample numerical behavior (minimal DOM child process)', () => {
  it('single-step and reset act through actual registered button listeners', () => {
    const [stepped, reset] = sampleRuntime(`nodes.get('step-btn').trigger('click'); snapshot(); nodes.get('reset-btn').trigger('click'); snapshot();`);
    expect(stepped.state.x).toBeCloseTo(0.6, 12);
    expect(stepped.hud.objective).toBe('5.760');
    expect(stepped.hud.gradient).toBe('-4.800');
    expect(stepped.state.iter).toBe(1);
    expect(reset.state).toMatchObject({ x: 0, iter: 0, running: false, ended: false });
    expect(reset.hud.objective).toBe('9.000');
  });
  it.each([0.05, 0.45, 0.9, 1.1])('preset η=%s follows the analytic recurrence for three steps', eta => {
    const samples = sampleRuntime(`presets[${[0.05,0.45,0.9,1.1].indexOf(eta)}].trigger('click'); snapshot(); for (let n = 1; n <= 3; n++) { stepOnce(); snapshot(); }`);
    expect(samples[0].state).toMatchObject({ eta, x: 0, iter: 0, running: true });
    for (let n = 1; n <= 3; n++) {
      expect(samples[n].state.x).toBeCloseTo(3 - 3 * (1 - 2 * eta) ** n, 10);
      expect(samples[n].state.iter).toBe(n);
    }
  });
  it.each([[1, 'converged'], [3, 'diverged']])('preset %s reaches its declared stopping condition', (preset, reason) => {
    const [stopped, after] = sampleRuntime(`presets[${Number(preset)}].trigger('click'); for (let n = 0; n < 120 && !state.ended; n++) stepOnce(); snapshot(); stepOnce(); snapshot();`);
    expect(stopped.state).toMatchObject({ ended: true, running: false, endReason: reason });
    expect(after.state.x).toBe(stopped.state.x);
  });
});
