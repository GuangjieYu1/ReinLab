import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { KernelAuth } from "../src/kernel/auth";

const key = () => generateKeyPairSync("ed25519").privateKey;
const ids = {
  account: "10000000-0000-4000-8000-000000000001",
  dossier: "20000000-0000-4000-8000-000000000002",
  run: "30000000-0000-4000-8000-000000000003",
};
const now = 1_800_000_000;
const auth = new KernelAuth(key());

describe("kernel run token", () => {
  it("round-trips only the account/dossier/run scope with a bounded lifetime", () => {
    const token = auth.issue(ids, now);
    const claims = auth.verify(token, now + 1);
    expect(claims).toMatchObject({ ...ids, aud: "reinlab-kernel", iss: "reinlab-control" });
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(7200);
  });

  it("rejects a token with a changed signature", () => {
    const token = auth.issue(ids, now);
    const [head, body, signature] = token.split(".");
    const tampered = [head, body, signature.slice(0, -4) + "AAAA"].join(".");
    expect(() => auth.verify(tampered, now + 1)).toThrow();
  });

  it("rejects an expired token and does not accept a future start", () => {
    const token = auth.issue(ids, now);
    expect(() => auth.verify(token, now + 7201)).toThrow();
    expect(() => auth.verify(token, now - 1)).toThrow();
  });

  it("rejects a token signed by another key", () => {
    const token = new KernelAuth(key()).issue(ids, now);
    expect(() => auth.verify(token, now + 1)).toThrow();
  });

  it("rejects anything that is not a three-part scoped token", () => {
    for (const raw of ["", "abc", "a.b", "a.b.c", "x".repeat(4200)])
      expect(() => auth.verify(raw, now + 1)).toThrow();
    expect(() => auth.verify(undefined, now + 1)).toThrow();
  });
});
