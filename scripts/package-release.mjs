import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const target = process.argv[2] === "portable" ? undefined : process.argv[2];
const suffix = process.argv[3] ?? process.argv[2] ?? "portable";
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

if (target === "win32-x64") {
  try {
    require.resolve("@img/sharp-win32-x64");
  } catch {
    throw new Error("The Windows-native Sharp package is missing. Build win32-x64 releases on a Windows x64 runner after npm ci.");
  }
}

const filename = `open-markdown-review-${packageJson.version}-${suffix}.vsix`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["run", "package:vsix", "--", ...(target ? ["--target", target] : []), "--out", filename];
const packaged = spawnSync(npm, args, { cwd: repoRoot, stdio: "inherit" });
if (packaged.status !== 0) process.exit(packaged.status ?? 1);

const output = path.join(repoRoot, filename);
const digest = createHash("sha256").update(await readFile(output)).digest("hex");
await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`, "utf8");
console.log(`Packaged ${filename} (${digest})`);
