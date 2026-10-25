import { it, expect } from "vitest";
import { assertHatchetContainer } from "../../worker/src/hatchet-container";
const expected = {
  imageId: "sha256:" + "a".repeat(64),
  imageEnv: ["PUBLIC=1"],
  volume: "owned",
  network: "local",
};
const safe = () => ({
  Id: "b".repeat(64),
  Image: expected.imageId,
  Config: {
    Labels: { "io.reinlab.hatchet": "owned" },
    Entrypoint: null,
    Cmd: ["./hatchet-lite", "--config", "/run/reinlab-hatchet"],
    Env: ["PUBLIC=1"],
  },
  HostConfig: {
    ReadonlyRootfs: true,
    Memory: 805306368,
    NanoCpus: 1000000000,
    PidsLimit: 256,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    NetworkMode: "local",
    PortBindings: {
      "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "57070" }],
      "8888/tcp": [{ HostIp: "127.0.0.1", HostPort: "58888" }],
    },
    Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
  },
  NetworkSettings: { Networks: { local: {} } },
  Mounts: [
    {
      Type: "volume",
      Name: "owned",
      Destination: "/run/reinlab-hatchet",
      RW: false,
    },
  ],
});
it("accepts only pinned local least-privilege container", () =>
  expect(assertHatchetContainer(safe(), expected)).toBe("b".repeat(64)));
it("label cannot mask credential/environment, mount, network or privilege drift", () => {
  for (const mutate of [
    (v: any) => v.Config.Env.push("TOKEN=secret-fixture"),
    (v: any) => (v.Config.Cmd = ["sh"]),
    (v: any) => (v.Image = "sha256:" + "c".repeat(64)),
    (v: any) => (v.Mounts[0].RW = true),
    (v: any) => v.Mounts.push({ Type: "bind", Source: "/private" }),
    (v: any) => (v.HostConfig.Privileged = true),
    (v: any) => (v.HostConfig.CapAdd = ["SYS_ADMIN"]),
    (v: any) => (v.HostConfig.ReadonlyRootfs = false),
    (v: any) => (v.HostConfig.PortBindings["7070/tcp"][0].HostIp = "0.0.0.0"),
    (v: any) => (v.NetworkSettings.Networks.extra = {}),
  ]) {
    const v = safe();
    mutate(v);
    expect(() => assertHatchetContainer(v, expected)).toThrow(
      "HATCHET_CONTAINER_DRIFT"
    );
  }
});
