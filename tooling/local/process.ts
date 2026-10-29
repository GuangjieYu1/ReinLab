import { spawn } from 'node:child_process';

/** CLI output may contain local keys. Keep it in memory and expose stable codes only. */
export function quietCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false;
    const bound = (old: string, chunk: Buffer) => (old + chunk.toString()).slice(-2 * 1024 * 1024);
    child.stdout.on('data', chunk => { stdout = bound(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = bound(stderr, chunk); });
    const signal = (value: NodeJS.Signals) => {
      try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid!, value); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, options.timeoutMs ?? 900000);
    const force = setTimeout(() => signal('SIGKILL'), (options.timeoutMs ?? 900000) + 3000);
    child.once('error', () => { clearTimeout(timer); clearTimeout(force); reject(new Error('LOCAL_COMMAND_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(force);
      if (timedOut) { reject(new Error('LOCAL_COMMAND_TIMEOUT')); return; }
      if (code === 0) { resolve(stdout); return; }
      let reason = timedOut ? 'LOCAL_COMMAND_TIMEOUT' : 'LOCAL_COMMAND_FAILED';
      if (/no space left on device/i.test(stderr + stdout)) reason = 'LOCAL_DISK_FULL';
      if (/port.*already (allocated|in use)|address already in use/i.test(stderr + stdout)) reason = 'LOCAL_PORT_BUSY';
      if (/failed to (pull|download)|manifest unknown|no matching manifest/i.test(stderr + stdout)) reason = 'LOCAL_IMAGE_UNAVAILABLE';
      if (/unhealthy|health check|healthcheck/i.test(stderr + stdout)) reason = 'LOCAL_SERVICE_UNHEALTHY';
      reject(new Error(reason));
    });
  });
}
