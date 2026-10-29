import { expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CapabilitySigner, verifyCapabilityToken, hash } from "../src/mcp/token";

it("T-MCP-1 Ed25519 signature, audience, canonical encoding and maximum two hour expiry are enforced", () => {
  const keys = generateKeyPairSync("ed25519"), signer = new CapabilitySigner(keys.privateKey);
  const identity = { account: randomUUID(), dossier: randomUUID(), run: randomUUID(), role: "research-read", bench: "research", version: "1.0.0", effectiveDigest: hash("effective"), catalogDigest: hash("catalog"), scopeDigest: hash("scope"), hold: randomUUID() };
  const { token, claims } = signer.issue(identity, 100, 60);
  expect(verifyCapabilityToken(token, signer.publicKey, 101)).toEqual(claims);
  for (const invalid of [undefined, "", token.slice(0, -8) + "aaaaaaaa", token.replace(/^./, "X"), token + ".extra"])
    expect(() => verifyCapabilityToken(invalid, signer.publicKey, 101)).toThrow(expect.objectContaining({ code: "CAPABILITY_TOKEN_INVALID" }));
  expect(() => verifyCapabilityToken(token, signer.publicKey, 160)).toThrow();
  expect(() => verifyCapabilityToken(token, signer.publicKey, 99)).toThrow();
  expect(() => verifyCapabilityToken(token, generateKeyPairSync("ed25519").publicKey, 101)).toThrow();
  expect(() => signer.issue(identity, 100, 7201)).toThrow();
  expect(() => signer.issue(identity, 100, 0)).toThrow();
});
