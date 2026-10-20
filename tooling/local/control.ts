import { readPrivateEnv } from './config';
import { localPaths } from './paths';

const environment = await readPrivateEnv(localPaths().runtime);
Object.assign(process.env, environment);
await import('../../services/control/src/main');
