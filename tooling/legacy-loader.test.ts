import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSource, checkWorkspace } from './boundaries';

const original = readFileSync('e2e/legacy/run.mjs', 'utf8');
describe('audited legacy test loader boundary', () => {
  it('allows the byte-identical user-provided test runner', () => {
    expect(checkSource('e2e/legacy/run.mjs', original)).toEqual([]);
  });
  it('does not grant the loader exemption to byte-identical code at another workspace path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'reinlab-legacy-loader-'));
    try {
      writeFileSync(path.join(root, 'package.json'), '{}');
      mkdirSync(path.join(root, 'e2e/legacy'), { recursive: true });
      writeFileSync(path.join(root, 'e2e/legacy/run.mjs'), original);
      expect(checkWorkspace(root)).toEqual([]);
      mkdirSync(path.join(root, 'tooling'));
      writeFileSync(path.join(root, 'tooling/copied-runner.mjs'), original);
      const errors = checkWorkspace(root);
      expect(errors.filter(error => error.includes('tooling/copied-runner.mjs') && error.includes('无法静态验证'))).toHaveLength(3);
      expect(errors.some(error => error.startsWith('e2e/legacy/run.mjs:'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('does not exempt a changed runner or any other dynamic loader', () => {
    expect(checkSource('e2e/legacy/run.mjs', original + '\nimport sdk from "@synsci/sdk";')).toContainEqual(expect.stringContaining('禁止依赖 @synsci/sdk'));
    expect(checkSource('e2e/legacy/run.mjs', original.replace('async function loadPlaywright()', 'async function anotherLoader()'))).toContainEqual(expect.stringContaining('无法静态验证'));
    expect(checkSource('services/control/src/other.ts', 'import(process.env.LOADER)')).toContainEqual(expect.stringContaining('无法静态验证'));
  });
});
