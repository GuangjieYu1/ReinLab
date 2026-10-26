import { it, expect, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = vi.hoisted(() => ({
  active: false,
  image: "reinlab-account:local-fixture",
  host: "127.0.0.1",
  driver: "docker",
  upgrade: vi.fn(),
  ensure: vi.fn(),
  query: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      query = fixture.query;
      async end() {}
    },
  },
}));
vi.mock("../src/configuration", () => ({
  readRuntimeConfiguration: (file: string) =>
    file.endsWith("setup.env")
      ? {
          DATABASE_URL:
            "postgres://postgres:synthetic-only@" +
            fixture.host +
            ":54322/postgres",
        }
      : {
          DATABASE_URL_APP: "postgres://fixture@127.0.0.1:54322/postgres",
          PROVISIONER_DRIVER: fixture.driver,
          ACCOUNT_IMAGE: fixture.image,
        },
}));
vi.mock("../src/db/database", () => ({
  Database: class {
    async assertSafeRole() {}
    async withAccount(_id: string, work: any) {
      return work({
        query: async () => ({ rowCount: fixture.active ? 1 : 0 }),
      });
    }
  },
}));
vi.mock("../src/provisioner/lifecycle", () => ({
  lifecycleFromEnvironment: () => ({ upgrade: fixture.upgrade }),
}));
vi.mock("../src/provisioner", () => ({
  provisionerFromEnvironment: () => ({ ensure: fixture.ensure }),
}));
import { upgradeLocalRealAccounts } from "../scripts/local-real-upgrade";
const id = "12345678-1234-4123-8123-123456789abc";
it("upgrade startup defers unfinished work; idle upgrade uses wait and reuses the persisted operation", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-local-upgrade-")),
  );
  fixture.query.mockResolvedValue({ rows: [{ account_id: id }] });
  fixture.upgrade.mockResolvedValue({ code: "UPDATE_REQUESTED" });
  fixture.ensure.mockResolvedValue({ state: "ready" });
  fixture.upgrade.mockClear();
  try {
    fixture.active = true;
    expect(
      await upgradeLocalRealAccounts(
        join(root, "runtime.env"),
        join(root, "setup.env"),
      ),
    ).toEqual({ upgraded: 0, deferred: 1 });
    expect(fixture.upgrade).not.toHaveBeenCalled();
    fixture.active = false;
    for (let i = 0; i < 2; i++)
      expect(
        await upgradeLocalRealAccounts(
          join(root, "runtime.env"),
          join(root, "setup.env"),
        ),
      ).toEqual({ upgraded: 1, deferred: 0 });
    expect(fixture.upgrade.mock.calls[0].slice(0, 3)).toEqual([
      id,
      fixture.image,
      "wait",
    ]);
    expect(fixture.upgrade.mock.calls[0][3]).toBe(
      fixture.upgrade.mock.calls[1][3],
    );
  } finally {
    fixture.active = false;
    await rm(root, { recursive: true, force: true });
  }
});
it("a failed health result cannot be replaced by a fresh operation for another image", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-local-upgrade-unknown-")),
  );
  fixture.query.mockResolvedValue({ rows: [{ account_id: id }] });
  fixture.ensure.mockResolvedValue({ state: "failed" });
  fixture.upgrade.mockClear();
  try {
    await expect(
      upgradeLocalRealAccounts(
        join(root, "runtime.env"),
        join(root, "setup.env"),
      ),
    ).rejects.toThrow("LOCAL_MODEL_UPGRADE_INDETERMINATE");
    fixture.image = "reinlab-account:local-another";
    await expect(
      upgradeLocalRealAccounts(
        join(root, "runtime.env"),
        join(root, "setup.env"),
      ),
    ).rejects.toThrow("LOCAL_MODEL_UPGRADE_INDETERMINATE");
    expect(fixture.upgrade).toHaveBeenCalledTimes(1);
  } finally {
    fixture.image = "reinlab-account:local-fixture";
    fixture.ensure.mockResolvedValue({ state: "ready" });
    await rm(root, { recursive: true, force: true });
  }
});
it.each(["host", "driver"])(
  "administrative enumeration rejects nonlocal %s",
  async (key) => {
    const previous = fixture[key];
    fixture[key] = key === "host" ? "remote.invalid" : "fly";
    fixture.query.mockClear();
    try {
      await expect(
        upgradeLocalRealAccounts("/fixture/runtime.env", "/fixture/setup.env"),
      ).rejects.toThrow("LOCAL_MODEL_UPGRADE_SCOPE_INVALID");
      expect(fixture.query).not.toHaveBeenCalled();
    } finally {
      fixture[key] = previous;
    }
  },
);
