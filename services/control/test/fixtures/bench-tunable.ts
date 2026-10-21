import { createHash } from "node:crypto";
import { canonical } from "../../src/api/context";
import {
  initialEffective,
  type EffectiveBench,
} from "../../src/harness/resolver";
/** A separately declared test bench; never broadens the real research manifest. */
export function fixtureBenchWithTunables(
  base: EffectiveBench,
  tunable: string[],
) {
  const manifest = { ...structuredClone(base.manifest), tunable: [...tunable] };
  const referencedHashes = Object.fromEntries(
    Object.entries(manifest.roles).map(([role, definition]) => [
      definition.prompt,
      createHash("sha256").update(base.prompts[role]).digest("hex"),
    ]),
  );
  return initialEffective({
    manifest,
    prompts: { ...base.prompts },
    referencedHashes,
    registryHash: base.registryHash,
    digest: createHash("sha256")
      .update(
        canonical({
          manifest,
          referencedHashes,
          registryHash: base.registryHash,
        }),
      )
      .digest("hex"),
  });
}
