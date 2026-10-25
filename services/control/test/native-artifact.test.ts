import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { requireNativeArtifact, nativeArtifactPath } from '../../account-runtime/artifact.mjs';

it('E-1 native artifacts survive the web output boundary and missing is a build failure, never optional', () => {
  expect(nativeArtifactPath).toBe(resolve('.artifacts/account-runtime/reinlab-openscience'));
  const root = mkdtempSync(join(tmpdir(), 'reinlab-native-required-'));
  const binary = join(root, 'reinlab-openscience');
  try {
    for (const required of [undefined, '0', '1']) {
      const previous = process.env.REINLAB_REQUIRE_NATIVE;
      try {
        if (required === undefined) delete process.env.REINLAB_REQUIRE_NATIVE;
        else process.env.REINLAB_REQUIRE_NATIVE = required;
        expect(() => requireNativeArtifact(binary)).toThrow(/node services\/account-runtime\/build.mjs/);
      } finally {
        if (previous === undefined) delete process.env.REINLAB_REQUIRE_NATIVE;
        else process.env.REINLAB_REQUIRE_NATIVE = previous;
      }
    }
    writeFileSync(binary, 'fixture executable'); chmodSync(binary, 0o600);
    expect(() => requireNativeArtifact(binary)).toThrow(/NATIVE_ARTIFACT_REQUIRED/);
    chmodSync(binary, 0o700);
    expect(requireNativeArtifact(binary)).toBe(binary);
    rmSync(binary); mkdirSync(binary);
    expect(() => requireNativeArtifact(binary)).toThrow(/NATIVE_ARTIFACT_REQUIRED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
