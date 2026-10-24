import { accessSync, constants, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const nativeArtifactPath = fileURLToPath(new URL('../../.artifacts/account-runtime/reinlab-openscience', import.meta.url));
/** A native test must never turn a missing build into an optional/skipped integration. */
export function requireNativeArtifact(binary = nativeArtifactPath) {
  try {
    if (!statSync(binary).isFile()) throw Error();
    accessSync(binary, constants.R_OK | constants.X_OK);
  } catch {
    throw Error('NATIVE_ARTIFACT_REQUIRED: run node services/account-runtime/build.mjs (Bun 1.3.14), then retry tests.');
  }
  return binary;
}
