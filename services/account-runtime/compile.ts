import path from "node:path";
import {
  generateKeyFragments,
  createEncryptPromptsPlugin,
} from "./upstream/backend/cli/script/encrypt-prompts-plugin.ts";
import { headlessAssets } from "./upstream/backend/cli/script/build-options.ts";
import { nativePackageName } from "./upstream/backend/cli/script/native-targets.ts";
if (Bun.version !== "1.3.14") throw Error("ACCOUNT_BUILD_BUN_VERSION");
globalThis.fetch = (() =>
  Promise.reject(Error("ACCOUNT_BUILD_NETWORK_FORBIDDEN"))) as typeof fetch;
await import("./upstream/backend/cli/script/generate-skill-bundle.ts");
const cli = path.join(import.meta.dir, "upstream/backend/cli");
const pkg = await Bun.file(path.join(cli, "package.json")).json();
if (pkg.version !== "2.0.150") throw Error("ACCOUNT_BUILD_SOURCE_VERSION");
const target = { os: process.platform, arch: process.arch };
const { plugin, defines } = createEncryptPromptsPlugin(generateKeyFragments());
const result = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "entry.ts")],
  conditions: ["browser"],
  tsconfig: path.join(cli, "tsconfig.json"),
  plugins: [plugin, headlessAssets(cli)],
  compile: {
    target: `bun-${target.os}-${target.arch}`,
    outfile: path.join(import.meta.dir, "reinlab-openscience"),
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    execArgv: ["--user-agent=openscience/2.0.150", "--use-system-ca", "--"],
  },
  define: {
    ...defines,
    OPENSCIENCE_VERSION: JSON.stringify(pkg.version),
    OPENSCIENCE_CHANNEL: JSON.stringify("latest"),
    OPENSCIENCE_LIBC: "",
    OPENSCIENCE_PLATFORM_PACKAGE: JSON.stringify(
      nativePackageName(pkg.name, target),
    ),
    OPENSCIENCE_ARTIFACT_SOURCE: JSON.stringify(
      "e700f00c0e4a45f7cd56d94d626d0e11b45b38c1",
    ),
  },
});
if (!result.success) {
  console.error(result.logs);
  throw Error("ACCOUNT_BUILD_FAILED");
}
