import { it, expect } from "vitest";
import {
  decideLocalImage,
  accountImageTag,
  ACCOUNT_IMAGE_INPUTS,
  ensureLocalAccountImage,
  type ImageObservation,
} from "./image";
import {
  mkdtemp,
  realpath,
  rm,
  lstat,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const image = "reinlab-account:local-123456abcdef",
  first = "sha256:" + "a".repeat(64),
  other = "sha256:" + "b".repeat(64);
const base: ImageObservation = {
  image,
  currentId: first,
  pinnedId: first,
  containers: [],
};
it("固定镜像pin拒绝覆盖或消失，不能计划重新build", () => {
  expect(decideLocalImage(base)).toBe("reuse");
  for (const currentId of [other, null])
    expect(() => decideLocalImage({ ...base, currentId })).toThrow(
      currentId ? "LOCAL_IMAGE_PIN_CHANGED" : "LOCAL_IMAGE_PIN_MISSING",
    );
});
it("无pin时旧容器约束禁止同tag重建/错基线，干净首次才允许build", () => {
  const containers = [{ reference: image, imageId: first }];
  expect(() =>
    decideLocalImage({ ...base, pinnedId: null, currentId: null, containers }),
  ).toThrow("LOCAL_IMAGE_REFERENCE_CONFLICT");
  expect(() =>
    decideLocalImage({ ...base, pinnedId: null, currentId: other, containers }),
  ).toThrow("LOCAL_IMAGE_REFERENCE_CONFLICT");
  expect(
    decideLocalImage({ ...base, pinnedId: null, currentId: first, containers }),
  ).toBe("pin");
  expect(
    decideLocalImage({
      ...base,
      pinnedId: null,
      currentId: null,
      containers: [{ reference: "unrelated:tag", imageId: other }],
    }),
  ).toBe("build");
});
function fake(
  initial: string | null,
  containers: { reference: string; imageId: string }[] = [],
) {
  let current = initial;
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "ls")
      return current ? current + "\n" : "";
    if (args[0] === "image" && args[1] === "inspect") {
      if (!current) throw Error("provider-secret");
      return current + "\n";
    }
    if (args[0] === "container" && args[1] === "ls")
      return containers
        .map((_, i) => (i + 1).toString(16).padStart(64, "0"))
        .join("\n");
    if (args[0] === "container" && args[1] === "inspect") {
      return args
        .slice(4)
        .map((id) => {
          const n = Number.parseInt(id, 16) - 1;
          return JSON.stringify([
            containers[n].reference,
            containers[n].imageId,
          ]);
        })
        .join("\n");
    }
    if (args[0] === "build") {
      current = first;
      return "";
    }
    throw Error("unexpected command");
  };
  return {
    run,
    calls,
    set: (value: string | null) => {
      current = value;
    },
  };
}
it("纯fake CLI首次build落mode600 pin，再启动不build；tag漂移/消失保持pin不变", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-image-pin-")),
    ),
    pinFile = join(dir, "image.env"),
    f = fake(null);
  try {
    expect(await ensureLocalAccountImage({ image, pinFile, run: f.run })).toBe(
      first,
    );
    expect((await lstat(pinFile)).mode & 0o777).toBe(0o600);
    const original = await readFile(pinFile, "utf8");
    expect(await ensureLocalAccountImage({ image, pinFile, run: f.run })).toBe(
      first,
    );
    expect(f.calls.filter((c) => c[0] === "build")).toHaveLength(1);
    for (const changed of [other, null]) {
      f.set(changed);
      await expect(
        ensureLocalAccountImage({ image, pinFile, run: f.run }),
      ).rejects.toThrow(
        changed ? "LOCAL_IMAGE_PIN_CHANGED" : "LOCAL_IMAGE_PIN_MISSING",
      );
      expect(await readFile(pinFile, "utf8")).toBe(original);
    }
    expect(f.calls.filter((c) => c[0] === "build")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("旧容器但缺失镜像，无pin也不能执行build或写新pin", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-image-old-")),
    ),
    pinFile = join(dir, "image.env"),
    f = fake(null, [{ reference: image, imageId: first }]);
  try {
    await expect(
      ensureLocalAccountImage({ image, pinFile, run: f.run }),
    ).rejects.toThrow("LOCAL_IMAGE_REFERENCE_CONFLICT");
    expect(f.calls.some((c) => c[0] === "build")).toBe(false);
    await expect(lstat(pinFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(f.calls)).not.toContain("Env");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("首次接纳已有相同镜像及旧容器时保存ID，不重新build；后续pin不能重绑", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-image-adopt-")),
    ),
    pinFile = join(dir, "image.env"),
    f = fake(first, [{ reference: image, imageId: first }]);
  try {
    expect(await ensureLocalAccountImage({ image, pinFile, run: f.run })).toBe(
      first,
    );
    expect(await readFile(pinFile, "utf8")).toContain(first);
    expect(f.calls.some((c) => c[0] === "build")).toBe(false);
    f.set(other);
    await expect(
      ensureLocalAccountImage({ image, pinFile, run: f.run }),
    ).rejects.toThrow("LOCAL_IMAGE_PIN_CHANGED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("Engine读取失败不是镜像不存在，不触发build且不泄provider错误", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-image-error-")),
  );
  const calls: string[][] = [];
  try {
    await expect(
      ensureLocalAccountImage({
        image,
        pinFile: join(dir, "image.env"),
        run: async (args) => {
          calls.push(args);
          throw Error("private-provider-value");
        },
      }),
    ).rejects.toThrow("LOCAL_IMAGE_READ_FAILED");
    expect(calls.some((c) => c[0] === "build")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("启动中tag漂移失败关闭，不发布接受新ID的pin", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-image-race-")),
    ),
    pinFile = join(dir, "image.env"),
    f = fake(first);
  let reads = 0;
  try {
    await expect(
      ensureLocalAccountImage({
        image,
        pinFile,
        run: async (args) => {
          if (args[0] === "image" && args[1] === "ls" && ++reads === 2)
            f.set(other);
          return f.run(args);
        },
      }),
    ).rejects.toThrow("LOCAL_IMAGE_PIN_CHANGED");
    await expect(lstat(pinFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls.some((c) => c[0] === "build")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("损坏pin不是首次安装，任何Docker命令前失败且不重写", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-image-corrupt-")),
    ),
    pinFile = join(dir, "image.env"),
    f = fake(first);
  try {
    await writeFile(
      pinFile,
      "IMAGE_REFERENCE=" + JSON.stringify(image) + '\nIMAGE_ID="invalid"\n',
      { mode: 0o600 },
    );
    await expect(
      ensureLocalAccountImage({ image, pinFile, run: f.run }),
    ).rejects.toThrow("LOCAL_IMAGE_PIN_INVALID");
    expect(f.calls).toHaveLength(0);
    expect(await readFile(pinFile, "utf8")).toContain("invalid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("批量只读容器身份，任一同tag旧容器ID冲突禁止初次pin", async () => {
  const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-image-multi-")),
    ),
    pinFile = join(dir, "image.env"),
    f = fake(first, [
      { reference: "unrelated:tag", imageId: other },
      { reference: image, imageId: other },
    ]);
  try {
    await expect(
      ensureLocalAccountImage({ image, pinFile, run: f.run }),
    ).rejects.toThrow("LOCAL_IMAGE_REFERENCE_CONFLICT");
    expect(
      f.calls.filter((c) => c[0] === "container" && c[1] === "inspect"),
    ).toHaveLength(1);
    expect(f.calls.some((c) => c[0] === "build")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("内容tag覆盖Dockerfile所有COPY输入，每个manifest变化都改变tag", async () => {
  const dockerfile = await readFile("infra/fly/account.Dockerfile", "utf8");
  const copied = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY ") && !line.startsWith("COPY --from="))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
  // Stage artifacts derive from the separately enumerated local source inputs;
  // external stage identities are pinned by the Dockerfile bytes themselves.
  expect(dockerfile).toContain("COPY --from=kernel-build");
  for (const file of copied) expect(ACCOUNT_IMAGE_INPUTS).toContain(file);
  expect(ACCOUNT_IMAGE_INPUTS).toContain("infra/fly/account.Dockerfile");
  const original = await accountImageTag(async (file) =>
    Buffer.from("base:" + file),
  );
  for (const changed of ACCOUNT_IMAGE_INPUTS) {
    expect(
      await accountImageTag(async (file) =>
        Buffer.from((file === changed ? "changed:" : "base:") + file),
      ),
    ).not.toBe(original);
  }
  expect(original).toMatch(/^reinlab-account:local-[a-f0-9]{12}$/);
});
