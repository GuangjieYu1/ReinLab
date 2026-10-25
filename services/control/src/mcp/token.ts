import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CapabilityScope = z
  .object({
    grants: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
            permission: z.enum(["allow", "ask"]),
            writeTargets: z.array(z.string()).max(64),
          })
          .strict()
      )
      .max(128),
    memory: z
      .object({
        layers: z.array(z.enum(["L2", "L3", "L4"])),
        refs: z.array(uuid).max(128).nullable(),
        assignedCitations: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const TokenClaims = z
  .object({
    v: z.literal(1),
    iss: z.literal("reinlab-control"),
    aud: z.literal("reinlab-mcp"),
    jti: uuid,
    account: uuid,
    dossier: uuid,
    run: uuid,
    role: z.string().min(1).max(64),
    bench: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    effectiveDigest: digest,
    catalogDigest: digest,
    scopeDigest: digest,
    hold: uuid,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.exp > v.iat && v.exp - v.iat <= 7200);
export type TokenClaims = z.infer<typeof TokenClaims>;
export type CapabilityScope = z.infer<typeof CapabilityScope>;
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const tokenDenied = () =>
  new ApiFailure("CAPABILITY_TOKEN_INVALID", 401, "能力令牌缺失或无效。");
const header = Buffer.from('{"alg":"EdDSA","typ":"rlcap1"}').toString(
  "base64url"
);
const decode = (text: string) => {
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) throw tokenDenied();
  return bytes;
};
/** Does not log, stringify errors containing input, or read any token from the environment. */
export class CapabilitySigner {
  readonly publicKey: KeyObject;
  constructor(private readonly privateKey: KeyObject) {
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    )
      throw tokenDenied();
    this.publicKey = createPublicKey(privateKey);
  }
  /** Separate audience: a search MCP credential is not a paid-model credential. */
  issueModel(claims: TokenClaims) {
    if (claims.role !== "research-clarify" || claims.version !== "1.2.0")
      throw tokenDenied();
    const message =
      header +
      "." +
      Buffer.from(
        canonical({ ...claims, aud: "reinlab-clarify-model" })
      ).toString("base64url");
    return (
      message +
      "." +
      sign(null, Buffer.from(message), this.privateKey).toString("base64url")
    );
  }
  issue(
    identity: Omit<TokenClaims, "v" | "iss" | "aud" | "jti" | "iat" | "exp">,
    now: number,
    ttl = 7200
  ) {
    const claims = TokenClaims.parse({
      ...identity,
      v: 1,
      iss: "reinlab-control",
      aud: "reinlab-mcp",
      jti: randomUUID(),
      iat: now,
      exp: now + ttl,
    });
    const payload = Buffer.from(canonical(claims)).toString("base64url");
    const message = header + "." + payload;
    return {
      claims,
      token:
        message +
        "." +
        sign(null, Buffer.from(message), this.privateKey).toString("base64url"),
    };
  }
}
export function verifyModelToken(
  raw: unknown,
  publicKey: KeyObject,
  now: number
): TokenClaims {
  try {
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      typeof raw !== "string" ||
      raw.length > 4096
    )
      throw tokenDenied();
    const parts = raw.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== header ||
      !verify(
        null,
        Buffer.from(parts[0] + "." + parts[1]),
        publicKey,
        decode(parts[2])
      )
    )
      throw tokenDenied();
    const payload = JSON.parse(decode(parts[1]).toString());
    if (payload.aud !== "reinlab-clarify-model") throw tokenDenied();
    const claims = TokenClaims.parse({ ...payload, aud: "reinlab-mcp" });
    if (
      claims.exp <= now ||
      claims.iat > now ||
      claims.role !== "research-clarify" ||
      claims.version !== "1.2.0"
    )
      throw tokenDenied();
    return claims; // Original MCP claims hash is the online revocation/hold authority.
  } catch {
    throw tokenDenied();
  }
}
export function verifyCapabilityToken(
  raw: unknown,
  publicKey: KeyObject,
  now: number
): TokenClaims {
  try {
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      typeof raw !== "string" ||
      raw.length > 4096
    )
      throw tokenDenied();
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== header) throw tokenDenied();
    const signature = decode(parts[2]);
    if (
      signature.length !== 64 ||
      !verify(
        null,
        Buffer.from(parts[0] + "." + parts[1]),
        publicKey,
        signature
      )
    )
      throw tokenDenied();
    const claims = TokenClaims.parse(
      JSON.parse(decode(parts[1]).toString("utf8"))
    );
    if (!Number.isInteger(now) || claims.exp <= now || claims.iat > now)
      throw tokenDenied();
    return claims;
  } catch {
    throw tokenDenied();
  }
}
/** Private file, private parent, canonical ancestors; never key contents in argv/env. */
export async function readSigningKey(file: string): Promise<CapabilitySigner> {
  let bytes: Buffer | undefined;
  try {
    if (!path.isAbsolute(file) || (await realpath(file)) !== file)
      throw tokenDenied();
    const parent = await lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.mode & 0o077) throw tokenDenied();
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077 || st.size > 8192)
        throw tokenDenied();
      bytes = await handle.readFile();
      return new CapabilitySigner(createPrivateKey(bytes));
    } finally {
      await handle.close();
    }
  } catch {
    throw tokenDenied();
  } finally {
    bytes?.fill(0);
  }
}

/** Local service-owned key, generated once into a protected file; never exported. */
export async function ensureSigningKey(file: string) {
  if (!path.isAbsolute(file)) throw tokenDenied();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.mode & 0o077 ||
    (await realpath(path.dirname(file))) !== path.dirname(file)
  )
    throw tokenDenied();
  let bytes: Buffer | undefined;
  try {
    bytes = Buffer.from(
      generateKeyPairSync("ed25519").privateKey.export({
        type: "pkcs8",
        format: "pem",
      })
    );
    const h = await open(file, "wx", 0o600);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw tokenDenied();
  } finally {
    bytes?.fill(0);
  }
  return readSigningKey(file);
}
