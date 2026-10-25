import { expect, it } from 'vitest';
import { assertHatchetContainer } from '../../worker/src/hatchet-container';

const expected = { imageId: 'sha256:' + 'a'.repeat(64), imageEnv: ['PUBLIC=1'], volume: 'owned', network: 'local' };
const safe = () => ({
  Id: 'b'.repeat(64), Image: expected.imageId,
  Config: { Labels: { 'io.reinlab.hatchet': 'owned' }, Entrypoint: null, Cmd: ['./hatchet-lite', '--config', '/run/reinlab-hatchet'], Env: ['PUBLIC=1'] },
  HostConfig: { ReadonlyRootfs: true, Memory: 805306368, NanoCpus: 1000000000, PidsLimit: 256, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], NetworkMode: 'local', PortBindings: { '7070/tcp': [{ HostIp: '127.0.0.1', HostPort: '57070' }], '8888/tcp': [{ HostIp: '127.0.0.1', HostPort: '58888' }] }, Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' } } as Record<string, unknown>,
  NetworkSettings: { Networks: { local: {} } }, Mounts: [{ Type: 'volume', Name: 'owned', Destination: '/run/reinlab-hatchet', RW: false }],
});

it.each([
  ['DeviceRequests', [{ Driver: 'fixture', Count: -1, Capabilities: [['gpu']] }]],
  ['IpcMode', 'container:' + 'c'.repeat(64)],
  ['UTSMode', 'host'],
  ['UsernsMode', 'host'],
  ['VolumesFrom', ['foreign:ro']],
])('reuse rejects unexpected host capability %s', (field, value) => {
  const fixture = safe(); fixture.HostConfig[field] = value;
  expect(() => assertHatchetContainer(fixture, expected)).toThrow('HATCHET_CONTAINER_DRIFT');
});
