import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const args = parseArgs(process.argv.slice(2));
const extensionId = args.extensionId ?? `${pkg.publisher}.${pkg.name}`;
const version = args.version ?? pkg.version;
const targets = (args.targets ?? "portable,win32-x64").split(",");
if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(extensionId)) throw new Error(`Invalid Marketplace extension ID: ${extensionId}`);
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Marketplace version: ${version}`);
if (!targets.length || targets.some(target => !["portable", "win32-x64"].includes(target))) throw new Error(`Invalid Marketplace targets: ${targets.join(",")}`);

const cli = require.resolve("@vscode/vsce/vsce");
const result = spawnSync(process.execPath, [cli, "show", extensionId, "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Marketplace query failed: ${(result.stderr || result.stdout).trim()}`);
const listing = JSON.parse(result.stdout);
if (`${listing.publisher?.publisherName}.${listing.extensionName}` !== extensionId || !Array.isArray(listing.versions)) {
  throw new Error("Marketplace response identity is invalid.");
}
const published = listing.versions.filter(candidate => candidate.version === version && candidate.flags === 1);
for (const target of targets) {
  const targetPlatform = target === "portable" ? undefined : target;
  if (!published.some(candidate => candidate.targetPlatform === targetPlatform)) {
    throw new Error(`Marketplace ${extensionId} ${version} is missing the ${target} package.`);
  }
}
console.log(`Marketplace exposes ${extensionId} ${version} for ${targets.join(" and ")}.`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index], value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? ""}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!["extensionId", "version", "targets"].includes(name)) throw new Error(`Unknown argument: ${key}`);
    parsed[name] = value;
  }
  return parsed;
}
