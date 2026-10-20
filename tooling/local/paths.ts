import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export function localPaths() {
  const root = resolve('.');
  const id = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const state = process.env.REINLAB_LOCAL_STATE_DIR ?? join(homedir(), '.local/state/reinlab', id);
  return { root, state, runtime: join(state, 'runtime.env'), setup: join(state, 'setup.env'), process: join(state, 'control.json') };
}
