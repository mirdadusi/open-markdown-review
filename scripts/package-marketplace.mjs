import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const requestedTarget = process.argv[2] ?? "portable";
if (!new Set(["portable", "win32-x64"]).has(requestedTarget)) {
  throw new Error("Usage: npm run package:marketplace -- portable|win32-x64");
}

const target = requestedTarget === "portable" ? undefined : requestedTarget;
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
    if (installed.version !== expectedVersion) {
      throw new Error(`The staged Windows-native Sharp version is ${installed.version}; expected ${expectedVersion}.`);
    }
  }
}

assertCommandSucceeded(runNpm(["run", "verify:marketplace"]), "Marketplace verification failed");
assertCommandSucceeded(runNpm(["run", "compile"]), "Extension compilation failed");

const filename = `open-markdown-review-${packageJson.version}-${requestedTarget}.vsix`;
let stagedNativePackage;
if (!target) {
  const nativePackagePath = path.join(repoRoot, "node_modules", "@img", "sharp-win32-x64");
  try {
    const nativeStat = await lstat(nativePackagePath);
    if (!nativeStat.isDirectory() || nativeStat.isSymbolicLink()) {
      throw new Error("The installed Windows-native Sharp package is not a normal directory.");
    }
    const stagingDirectory = path.join(repoRoot, ".staging");
    await mkdir(stagingDirectory, { recursive: true });
    const holdingPath = path.join(stagingDirectory, `sharp-win32-x64-${process.pid}`);
    try {
      await lstat(holdingPath);
      throw new Error(`Refusing to replace existing packaging staging path: ${holdingPath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(nativePackagePath, holdingPath);
    stagedNativePackage = { nativePackagePath, holdingPath };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const args = [
  "run", "package:marketplace:vsix", "--",
  ...(target ? ["--target", target] : []),
  "--githubBranch", "main",
  "--out", filename,
];
try {
  assertCommandSucceeded(runNpm(args), "Marketplace VSIX packaging failed");
} finally {
  if (stagedNativePackage) {
    await rename(stagedNativePackage.holdingPath, stagedNativePackage.nativePackagePath);
  }
}

const output = path.join(repoRoot, filename);
const digest = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`, "utf8");
console.log(`Packaged Marketplace artifact ${filename} (${digest})`);
