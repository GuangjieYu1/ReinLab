import { accountCredentialFiles } from "./credential-file";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
export const OS_VERSION = "2.0.150";
export const Tokens = z
  .object({
    auth: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    container: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type Tokens = z.infer<typeof Tokens>;
export type Envelope = { iv: string; tag: string; ciphertext: string };
export function encryptBundle(
  account: string,
  key: Buffer,
  tokens: Tokens,
): Envelope {
  z.string().uuid().parse(account);
  Tokens.parse(tokens);
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("reinlab:machine:v1:" + account));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
export function decryptBundle(
  account: string,
  key: Buffer,
  e: Envelope,
): Tokens {
  z.string().uuid().parse(account);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(e.iv, "base64"),
  );
  decipher.setAAD(Buffer.from("reinlab:machine:v1:" + account));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  return Tokens.parse(
    JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(e.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ),
  );
}
export function parseReady(line: string): boolean {
  try {
    const v = JSON.parse(line);
    return (
      v.type === "server.ready" &&
      v.schemaVersion === 1 &&
      v.version === OS_VERSION &&
      Number.isSafeInteger(v.pid) &&
      v.pid > 0 &&
      ["http://127.0.0.1:4096", "http://localhost:4096"].includes(v.url)
    );
  } catch {
    return false;
  }
}
export function machinePlan(i: {
  accountId: string;
  volumeId: string;
  image: string;
  controlUrl: string;
  tokens: Tokens;
}) {
  z.string().uuid().parse(i.accountId);
  Tokens.parse(i.tokens);
  z.string()
    .regex(/^vol_[a-zA-Z0-9]+$/)
    .parse(i.volumeId);
  if (
    !/^registry\.fly\.io\/[a-z0-9-]+(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/.test(
      i.image,
    )
  )
    throw new Error("ACCOUNT_IMAGE_INVALID");
  const url = new URL(i.controlUrl);
  if (
    url.protocol !== "http:" ||
    !url.hostname.endsWith(".internal") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("CONTROL_PRIVATE_URL_REQUIRED");
  return {
    name: "rl-" + i.accountId.replaceAll("-", ""),
    region: "nrt",
    config: {
      image: i.image,
      auto_destroy: false,
      restart: { policy: "always" },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
      mounts: [{ volume: i.volumeId, path: "/data" }],
      metadata: {
        reinlab_account_id: i.accountId,
        reinlab_os_version: OS_VERSION,
      },
      files: accountCredentialFiles(i.accountId, i.tokens),
      env: {
        REINLAB_ACCOUNT_CREDENTIAL_FILE: "/run/reinlab-source/account.json",
        OPENSCIENCE_DATA_DIR: "/data/os-data",
        OPENSCIENCE_CONFIG_DIR: "/data/os-config",
        REINLAB_CONTROL_URL: i.controlUrl,
        REINLAB_ACCOUNT_ID: i.accountId,
      },
    },
  };
}
