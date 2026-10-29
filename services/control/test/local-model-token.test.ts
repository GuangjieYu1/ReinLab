import { expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  CapabilitySigner,
  verifyCapabilityToken,
  verifyModelToken,
  verifyRuntimeModelToken,
} from "../src/mcp/token";
it("runtime model token is separate from both MCP and clarification audiences and bound to research roles", () => {
  const signer = new CapabilitySigner(
      generateKeyPairSync("ed25519").privateKey,
    ),
    now = Math.floor(Date.now() / 1000);
  const { token, claims } = signer.issue(
    {
      account: randomUUID(),
      dossier: randomUUID(),
      run: randomUUID(),
      hold: randomUUID(),
      role: "research-read",
      bench: "research",
      version: "1.2.0",
      effectiveDigest: "a".repeat(64),
      catalogDigest: "b".repeat(64),
      scopeDigest: "c".repeat(64),
    },
    now,
  );
  const model = signer.issueRuntimeModel(claims);
  expect(verifyRuntimeModelToken(model, signer.publicKey, now)).toEqual(claims);
  for (const verify of [verifyCapabilityToken, verifyModelToken])
    expect(() => verify(model, signer.publicKey, now)).toThrow();
  expect(() => verifyRuntimeModelToken(token, signer.publicKey, now)).toThrow();
  for (const patch of [
    { role: "research-audit" },
    { role: "research-clarify", version: "1.1.0" },
    { bench: "other" },
    { version: "9.0.0" },
  ])
    expect(() => signer.issueRuntimeModel({ ...claims, ...patch })).toThrow();
});
