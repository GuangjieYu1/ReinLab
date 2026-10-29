import { createServer } from 'node:net';

/** One host-wide setup at a time; the kernel releases this lock on a crash. */
export async function acquireStartupLock(port = 3002) {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(Error('LOCAL_SETUP_BUSY')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  const bound = (server.address() as { port: number }).port;
  let releasing: Promise<void> | undefined;
  return {
    port: bound,
    release: () => releasing ??= new Promise<void>(resolve => server.close(() => resolve())),
  };
}
