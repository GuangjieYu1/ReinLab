import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";

const uuid = z.string().uuid();
/**
 * Kernel scope token: identity and access range only. It carries no budget,
 * catalog or capability-digest state, so nothing here can gate a model call.
 */
export const KernelClaims = z
  .object({
    v: z.literal(1),
    iss: z.literal("reinlab-control"),
    aud: z.literal("reinlab-kernel"),
    account: uuid,
    dossier: uuid,
    run: uuid,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine((claims) => claims.exp > claims.iat && claims.exp - claims.iat <= 7200);
export type KernelClaims = z.infer<typeof KernelClaims>;
export type KernelIdentity = Pick<KernelClaims, "account" | "dossier" | "run">;

const header = Buffer.from('{"alg":"EdDSA","typ":"rlker1"}').toString(
  "base64url",
);
const invalid = () =>
  new ApiFailure("KERNEL_TOKEN_INVALID", 401, "运行令牌缺失或无效。");
const decode = (text: string) => {
  const bytes = Buffer.from(text, "base64url");
  if (bytes.toString("base64url") !== text) throw invalid();
  return bytes;
};

/** Ed25519 scope signer shared by the kernel launch and the model endpoint. */
export class KernelAuth {
  readonly publicKey: KeyObject;
  constructor(private readonly privateKey: KeyObject) {
    if (
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    )
      throw invalid();
    this.publicKey = createPublicKey(privateKey);
  }
  issue(identity: KernelIdentity, now: number, ttl = 7200): string {
    const claims = KernelClaims.parse({
      ...identity,
      v: 1,
      iss: "reinlab-control",
      aud: "reinlab-kernel",
      iat: now,
      exp: now + ttl,
    });
    const message =
      header + "." + Buffer.from(canonical(claims)).toString("base64url");
    return (
      message +
      "." +
      sign(null, Buffer.from(message), this.privateKey).toString("base64url")
    );
  }
  verify(raw: unknown, now: number): KernelClaims {
    try {
      if (
        this.publicKey.asymmetricKeyType !== "ed25519" ||
        typeof raw !== "string" ||
        raw.length === 0 ||
        raw.length > 4096
      )
        throw invalid();
      const parts = raw.split(".");
      if (
        parts.length !== 3 ||
        parts[0] !== header ||
        !verify(
          null,
          Buffer.from(parts[0] + "." + parts[1]),
          this.publicKey,
          decode(parts[2]),
        )
      )
        throw invalid();
      const claims = KernelClaims.parse(JSON.parse(decode(parts[1]).toString()));
      if (claims.exp <= now || claims.iat > now) throw invalid();
      return claims;
    } catch {
      throw invalid();
    }
  }
}
