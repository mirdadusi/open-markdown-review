import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const failures = [];

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

async function requireFile(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath));
  } catch {
    failures.push(`Required Marketplace file is missing: ${relativePath}`);
  }
}

requireValue(packageJson.name === "open-markdown-review", "Unexpected extension name.");
requireValue(packageJson.publisher === "mirdadusi", "Marketplace publisher must be mirdadusi.");
requireValue(/^\d+\.\d+\.\d+$/.test(packageJson.version), "Extension version must be a three-part semantic version.");
requireValue(packageJson.license === "MIT", "The public extension must use the MIT license.");
requireValue(packageJson.pricing === "Free", "Marketplace pricing must be declared as Free.");
requireValue(packageJson.icon === "media/marketplace-icon.png", "Marketplace icon path is missing or unexpected.");
requireValue(packageJson.galleryBanner?.theme === "light", "The Marketplace gallery banner must use the light theme.");
requireValue(packageJson.repository?.url === "https://github.com/mirdadusi/open-markdown-review.git", "Repository metadata must point to the public upstream repository.");
requireValue(packageJson.bugs?.url === "https://github.com/mirdadusi/open-markdown-review/issues", "Issue tracker metadata is missing or unexpected.");

const requiredKeywords = ["markdown", "review", "local-first", "mermaid"];
for (const keyword of requiredKeywords) {
  requireValue(packageJson.keywords?.includes(keyword), `Required Marketplace keyword is missing: ${keyword}`);
}

for (const relativePath of [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
  "SUPPORT.md",
  packageJson.icon,
  "docs/images/marketplace/vscode-setup.png",
  "docs/images/marketplace/vscode-review.png",
  "docs/images/marketplace/browser-review.png",
]) {
  await requireFile(relativePath);
}

async function readPngSize(relativePath) {
  const bytes = await readFile(path.join(repoRoot, relativePath));
  const signature = "89504e470d0a1a0a";
  requireValue(bytes.subarray(0, 8).toString("hex") === signature, `${relativePath} is not a PNG file.`);
  if (bytes.length < 24) return { width: 0, height: 0 };
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const iconSize = await readPngSize(packageJson.icon);
requireValue(iconSize.width >= 128 && iconSize.height >= 128, "Marketplace icon must be at least 128 by 128 pixels.");

const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
requireValue(readme.includes(`Open Markdown Review ${packageJson.version}`), "README heading does not match package version.");
requireValue(readme.includes("docs/images/marketplace/vscode-review.png"), "README does not show the VS Code review screenshot.");
requireValue(readme.includes("docs/images/marketplace/browser-review.png"), "README does not show the browser review screenshot.");

const readmeWithoutFencedExamples = readme.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
const markdownImagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
for (const match of readmeWithoutFencedExamples.matchAll(markdownImagePattern)) {
  const reference = match[1];
  if (/^https:\/\//i.test(reference)) continue;
  requireValue(!/^(?:data:|file:|http:)/i.test(reference), `README image uses an unsupported URL: ${reference}`);
  const relativePath = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  requireValue(!relativePath.toLowerCase().endsWith(".svg"), `Marketplace README image must not be SVG: ${relativePath}`);
  const resolved = path.resolve(repoRoot, relativePath);
  requireValue(resolved.startsWith(`${repoRoot}${path.sep}`), `README image escapes the repository: ${relativePath}`);
  await requireFile(relativePath);
}

const publicFiles = ["package.json", "README.md", "SUPPORT.md", "SECURITY.md"];
const privateMarkers = [/github\.siemens\.cloud/i, /Advanta-Czechia/i, /czprga\d*/i];
for (const relativePath of publicFiles) {
  const content = await readFile(path.join(repoRoot, relativePath), "utf8");
  for (const marker of privateMarkers) {
    requireValue(!marker.test(content), `${relativePath} contains a corporate/internal marker matched by ${marker}.`);
  }
}

if (failures.length > 0) {
  console.error("Marketplace verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Marketplace presentation verified for ${packageJson.publisher}.${packageJson.name} ${packageJson.version}.`);
}
