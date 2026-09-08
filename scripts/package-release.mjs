import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { vsixChannelArgs } from "./release-policy.mjs";

const target = process.argv[2] === "portable" ? undefined : process.argv[2];
const suffix = process.argv[3] ?? process.argv[2] ?? "portable";
const channelArgs = vsixChannelArgs(process.env.OMR_RELEASE_CHANNEL);
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runNpm(args) {
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    return spawnSync(process.execPath, [npmCli, ...args], { cwd: repoRoot, stdio: "inherit" });
  }
  return spawnSync("npm", args, { cwd: repoRoot, stdio: "inherit" });
}

function assertCommandSucceeded(result, message) {
  if (result.error) throw new Error(`${message}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${message} (exit code ${result.status ?? "unknown"}).`);
}

if (target === "win32-x64") {
  const nativePackagePath = path.join(repoRoot, "node_modules", "@img", "sharp-win32-x64", "package.json");
  const expectedVersion = packageJson.dependencies["@img/sharp-wasm32"];
  try {
    const installed = JSON.parse(await readFile(nativePackagePath, "utf8"));
    if (installed.version !== expectedVersion) throw new Error(`expected ${expectedVersion}, found ${installed.version}`);
  } catch {
    const staged = runNpm([
      "install", "--no-save", "--package-lock=false", "--force", `@img/sharp-win32-x64@${expectedVersion}`,
    ]);
    assertCommandSucceeded(staged, "The Windows-native Sharp package could not be staged");
    const installed = JSON.parse(await readFile(nativePackagePath, "utf8"));
    if (installed.version !== expectedVersion) throw new Error(`The staged Windows-native Sharp version is ${installed.version}; expected ${expectedVersion}.`);
  }
}

const filename = `open-markdown-review-${packageJson.version}-${suffix}.vsix`;
const args = ["run", "package:vsix", "--", ...(target ? ["--target", target] : []), ...channelArgs, "--out", filename];
const packaged = runNpm(args);
assertCommandSucceeded(packaged, "VSIX packaging failed");

const output = path.join(repoRoot, filename);
const digest = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`, "utf8");
console.log(`Packaged ${filename} (${digest})`);
