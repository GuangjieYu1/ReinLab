/** Inspect in memory only: a label is not proof of safe container configuration. */
export function assertHatchetContainer(
  value: any,
  expected: {
    imageId: string;
    imageEnv: string[];
    volume: string;
    network: string;
  }
) {
  const deny = () => {
    throw Error("HATCHET_CONTAINER_DRIFT");
  };
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const config = value?.Config,
    host = value?.HostConfig,
    mounts = value?.Mounts;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(expected.imageId) ||
    value?.Image !== expected.imageId ||
    !/^[a-f0-9]{64}$/.test(value?.Id ?? "")
  )
    deny();
  if (
    config?.Labels?.["io.reinlab.hatchet"] !== expected.volume ||
    !same(config?.Entrypoint, null) ||
    !same(config?.Cmd, [
      "./hatchet-lite",
      "--config",
      "/run/reinlab-hatchet",
    ]) ||
    !same([...(config?.Env ?? [])].sort(), [...expected.imageEnv].sort())
  )
    deny();
  if (
    !host ||
    host.Privileged ||
    !host.ReadonlyRootfs ||
    host.Memory !== 805306368 ||
    host.NanoCpus !== 1000000000 ||
    host.PidsLimit !== 256 ||
    (host.Binds?.length ?? 0) ||
    (host.Devices?.length ?? 0) ||
    (host.DeviceRequests?.length ?? 0) ||
    (host.VolumesFrom?.length ?? 0) ||
    host.UTSMode ||
    host.UsernsMode ||
    (host.CapAdd?.length ?? 0) ||
    !same(host.CapDrop, ["ALL"]) ||
    !same(host.SecurityOpt, ["no-new-privileges"]) ||
    host.NetworkMode !== expected.network ||
    host.PidMode ||
    (host.IpcMode && host.IpcMode !== "private") ||
    host.PublishAllPorts
  )
    deny();
  if (
    !same(host.PortBindings, {
      "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "57070" }],
      "8888/tcp": [{ HostIp: "127.0.0.1", HostPort: "58888" }],
    })
  )
    deny();
  if (
    !same(Object.keys(value?.NetworkSettings?.Networks ?? {}), [
      expected.network,
    ])
  )
    deny();
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0].Type !== "volume" ||
    mounts[0].Name !== expected.volume ||
    mounts[0].Destination !== "/run/reinlab-hatchet" ||
    mounts[0].RW !== false
  )
    deny();
  if (!same(host.Tmpfs, { "/tmp": "rw,noexec,nosuid,size=64m" })) deny();
  return value.Id as string;
}
