import type { GitHubReleaseUpdateSource, UpdateRelease, UpdateTarget } from "./types";

interface ParsedSemVer {
  core: [bigint, bigint, bigint];
  prerelease: string[];
}

const IDENTIFIER = /^[0-9A-Za-z-]+$/;

function parseSemVer(value: string, allowLeadingV = false): ParsedSemVer | null {
  let normalized = value;
  if (allowLeadingV && normalized.startsWith("v")) normalized = normalized.slice(1);
  if (!normalized || normalized.trim() !== normalized) return null;
  const plus = normalized.indexOf("+");
  const withoutBuild = plus >= 0 ? normalized.slice(0, plus) : normalized;
  const build = plus >= 0 ? normalized.slice(plus + 1) : "";
  if (plus >= 0 && (!build || build.split(".").some(part => !IDENTIFIER.test(part)))) return null;
  const dash = withoutBuild.indexOf("-");
  const coreText = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const prereleaseText = dash >= 0 ? withoutBuild.slice(dash + 1) : "";
  if (dash >= 0 && !prereleaseText) return null;
  const core = coreText.split(".");
  if (core.length !== 3 || core.some(part => !/^(0|[1-9][0-9]*)$/.test(part))) return null;
  const prerelease = prereleaseText ? prereleaseText.split(".") : [];
  if (prerelease.some(part => !IDENTIFIER.test(part) || (/^[0-9]+$/.test(part) && part.length > 1 && part.startsWith("0")))) return null;
  return { core: [BigInt(core[0]), BigInt(core[1]), BigInt(core[2])], prerelease };
}

export function isStrictSemVer(value: string): boolean {
  return parseSemVer(value) !== null;
}

export function normalizeReleaseTag(value: string): string | undefined {
  return parseSemVer(value, true) ? (value.startsWith("v") ? value.slice(1) : value) : undefined;
}

export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) throw new Error("Cannot compare invalid semantic versions.");
  for (let index = 0; index < 3; index++) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^[0-9]+$/.test(av), bn = /^[0-9]+$/.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an) return -1;
    if (bn) return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

export function targetForPlatform(platform: NodeJS.Platform, arch: string): UpdateTarget {
  return platform === "win32" && arch === "x64" ? "win32-x64" : "portable";
}

export function artifactNames(source: GitHubReleaseUpdateSource, version: string, target: UpdateTarget): { vsix: string; checksum: string } {
  if (!isStrictSemVer(version)) throw new Error("Release version is not valid SemVer.");
  const vsix = `${source.artifactBaseName}-${version}-${target}.vsix`;
  return { vsix, checksum: `${vsix}.sha256` };
}

export function isAllowedReleaseUrl(value: string, source: GitHubReleaseUpdateSource, tag: string): boolean {
  return value === `${source.releasesUrl}/tag/${tag}`;
}

export function isAllowedAssetApiUrl(value: string, source: GitHubReleaseUpdateSource): boolean {
  try {
    const url = new URL(value);
    const prefix = `/api/v3/repos/${source.owner}/${source.repository}/releases/assets/`;
    return url.protocol === "https:" && url.hostname === source.host && url.port === "" &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith(prefix) && /^[0-9]+$/.test(url.pathname.slice(prefix.length));
  } catch {
    return false;
  }
}

export function isAllowedAssetRedirect(value: string, source: GitHubReleaseUpdateSource): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && [source.host, ...source.assetRedirectHosts].includes(url.hostname) &&
      url.port === "" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function hasNewerRelease(currentVersion: string, release: UpdateRelease): boolean {
  if (!isStrictSemVer(currentVersion) || !isStrictSemVer(release.version)) throw new Error("Installed or release version is invalid.");
  return compareSemVer(release.version, currentVersion) > 0;
}
