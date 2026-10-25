import { spawnSync } from 'node:child_process';
import { requireNativeArtifact } from '../services/account-runtime/artifact.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const files = ['independent-role', 'harness-native', 'runtime-recovery', 'role-runtime', 'runtime-smoke-native', 'pipeline-native', 'run-bridge', 'batch7-native'];
const hash = () => createHash('sha256').update(readFileSync(requireNativeArtifact())).digest('hex');
const before = hash();
const env = { ...process.env, VITE_BACKEND: 'mock', REINLAB_REQUIRE_NATIVE: '1' };
// This regression uses fixture providers only. Never inherit any model key.
delete env.DEEPSEEK_API_KEY;
for (const args of [['build'], ['lint'], ['exec', 'vitest', 'run', ...files.map(f => `services/control/test/${f}.test.ts`), '--reporter=json', '--outputFile=' + (process.env.REINLAB_NATIVE_REPORT ?? '/tmp/reinlab-native-after-build.json')]]) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status || 1);
  if (hash() !== before) throw Error('NATIVE_ARTIFACT_CHANGED_BY_WEB_BUILD');
}
