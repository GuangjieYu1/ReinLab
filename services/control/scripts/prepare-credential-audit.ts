/** Generates a real, verified and revoked capability solely for exact-value auditing. No model. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localPaths } from "../../../tooling/local/paths";
import { readRuntimeConfiguration } from "../src/configuration";
import { ensureSigningKey } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { mcpFixture } from "../test/mcp-fixture";
import { homedir } from "node:os";
const paths = localPaths(),
  config = readRuntimeConfiguration(paths.runtime),
  parent = join(paths.state, "audit");
await mkdir(parent, { mode: 0o700, recursive: true });
const f = await mcpFixture(),
  signing =
    config.REINLAB_MCP_SIGNING_KEY_FILE ??
    join(homedir(), ".config/reinlab/mcp/signing.pem");
try {
  const authority = new CapabilityAuthority(
      f.db,
      await ensureSigningKey(signing),
    ),
    token = await authority.issue(f.account, f.run);
  await authority.validate(token);
  await authority.revoke(f.account, f.run);
  let refused = false;
  try {
    await authority.validate(token);
  } catch {
    refused = true;
  }
  if (!refused) throw Error("AUDIT_REVOKE_FAILED");
  const directory = await mkdtemp(join(parent, "capability-")),
    file = join(directory, "capability.json");
  await writeFile(file, JSON.stringify({ token }), { mode: 0o600, flag: "wx" });
  console.log(
    JSON.stringify({
      code: "AUDIT_FIXTURE_READY",
      file,
      signing,
      credentialDirectory: config.REINLAB_DOCKER_CREDENTIAL_DIR,
      modelRequests: 0,
    }),
  );
} finally {
  await f.close();
}
