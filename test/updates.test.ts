import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { downloadVerifiedVsix, fetchLatestGitHubRelease } from "../src/updates/githubReleaseClient";
import { artifactNames, compareSemVer, targetForPlatform } from "../src/updates/policy";
import { OMR_UPDATE_SOURCE, validateUpdateSource } from "../src/updates/source";
import type { GitHubReleaseUpdateSource, UpdateRelease } from "../src/updates/types";
import { installVsixThroughWorkbench, VSIX_INSTALL_COMMANDS } from "../src/updates/vsixInstaller";

const enterpriseSource: GitHubReleaseUpdateSource = validateUpdateSource({
  schemaVersion: 1,
  channel: "github-release",
  extensionId: "advanta-czechia.open-markdown-review",
  host: "github.siemens.cloud",
  owner: "Advanta-Czechia",
  repository: "open-markdown-review",
  releasesUrl: "https://github.siemens.cloud/Advanta-Czechia/open-markdown-review/releases",
  latestReleaseApiUrl: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/latest",
  assetRedirectHosts: ["media.github.siemens.cloud"],
  artifactBaseName: "open-markdown-review",
}) as GitHubReleaseUpdateSource;

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

test("update source binds the build to its declared distribution identity", async () => {
  assert.throws(() => validateUpdateSource({
    schemaVersion: 1,
    channel: "marketplace",
    extensionId: "mirdadusi.open-markdown-review",
    marketplaceItemUrl: "https://evil.example/item",
  }));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(OMR_UPDATE_SOURCE.extensionId, `${pkg.publisher}.${pkg.name}`);
  const commands = new Set(pkg.contributes.commands.map((item: { command: string }) => item.command));
  for (const command of ["checkForUpdates", "openUpdateSource"]) {
    assert.ok(commands.has(`openMarkdownReview.${command}`));
    assert.ok(pkg.activationEvents.includes(`onCommand:openMarkdownReview.${command}`));
  }
  if (OMR_UPDATE_SOURCE.channel === "marketplace") {
    assert.equal(OMR_UPDATE_SOURCE.extensionId, "mirdadusi.open-markdown-review");
    assert.ok(!commands.has("openMarkdownReview.installUpdate"), "Marketplace builds must use VS Code's native Update action.");
  } else {
    assert.equal(OMR_UPDATE_SOURCE.extensionId, "advanta-czechia.open-markdown-review");
    assert.ok(commands.has("openMarkdownReview.installUpdate"));
    assert.equal(pkg.contributes.configuration.properties["openMarkdownReview.updateChecks.enabled"].default, true);
  }
});

test("update policy compares SemVer and selects a native Windows package only on Windows x64", () => {
  assert.equal(compareSemVer("0.5.5", "0.5.4"), 1);
  assert.equal(compareSemVer("0.5.5-beta.1", "0.5.5"), -1);
  assert.equal(targetForPlatform("win32", "x64"), "win32-x64");
  assert.equal(targetForPlatform("win32", "arm64"), "portable");
  assert.equal(targetForPlatform("darwin", "x64"), "portable");
  assert.deepEqual(artifactNames(enterpriseSource, "0.5.5", "portable"), {
    vsix: "open-markdown-review-0.5.5-portable.vsix",
    checksum: "open-markdown-review-0.5.5-portable.vsix.sha256",
  });
});

test("GitHub release checks accept one exact target/checksum pair and preserve an ETag", async () => {
  const names = artifactNames(enterpriseSource, "0.5.5", "win32-x64");
  const release = {
    tag_name: "v0.5.5",
    html_url: `${enterpriseSource.releasesUrl}/tag/v0.5.5`,
    draft: false,
    prerelease: false,
    assets: [
      { name: names.vsix, url: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/assets/10" },
      { name: names.checksum, url: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/assets/11" },
    ],
  };
  const fetchImpl = (async () => json(release, { etag: '"release-055"' })) as typeof fetch;
  const result = await fetchLatestGitHubRelease({ source: enterpriseSource, fetchImpl, platform: "win32", arch: "x64" });
  assert.equal(result.kind, "release");
  if (result.kind === "release") {
    assert.equal(result.etag, '"release-055"');
    assert.equal(result.release.artifact.target, "win32-x64");
    assert.equal(result.release.artifact.name, names.vsix);
  }
});

test("GitHub release checks reject prereleases, unsafe URLs, duplicates, and missing platform assets", async () => {
  const names = artifactNames(enterpriseSource, "0.5.5", "portable");
  const base = {
    tag_name: "v0.5.5",
    html_url: `${enterpriseSource.releasesUrl}/tag/v0.5.5`,
    draft: false,
    prerelease: false,
    assets: [
      { name: names.vsix, url: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/assets/10" },
      { name: names.checksum, url: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/assets/11" },
    ],
  };
  for (const invalid of [
    { ...base, prerelease: true },
    { ...base, html_url: "https://evil.example/release" },
    { ...base, assets: [...base.assets, base.assets[0]] },
    { ...base, assets: [] },
  ]) {
    const result = await fetchLatestGitHubRelease({ source: enterpriseSource, fetchImpl: (async () => json(invalid)) as typeof fetch, platform: "darwin", arch: "arm64" });
    assert.equal(result.kind, "invalid-metadata");
  }
});

test("enterprise downloads validate redirects, checksum filename, size, and SHA-256 without leaking the token", async () => {
  const bytes = Buffer.from("verified enterprise VSIX");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifact = artifactNames(enterpriseSource, "0.5.5", "portable");
  const release: UpdateRelease = {
    version: "0.5.5",
    tag: "v0.5.5",
    releaseUrl: `${enterpriseSource.releasesUrl}/tag/v0.5.5`,
    artifact: {
      name: artifact.vsix,
      checksumName: artifact.checksum,
      target: "portable",
      apiUrl: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/assets/10",
      checksumApiUrl: "https://github.siemens.cloud/api/v3/repos/Advanta-Czechia/open-markdown-review/releases/assets/11",
    },
  };
  const checksumRedirect = `https://media.github.siemens.cloud/assets/${artifact.checksum}?signature=one`;
  const vsixRedirect = `https://media.github.siemens.cloud/assets/${artifact.vsix}?signature=two`;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const requestHeaders = init?.headers as Record<string, string> | undefined;
    if (url === release.artifact.checksumApiUrl) {
      assert.equal(requestHeaders?.Authorization, "Bearer secret");
      return new Response(null, { status: 302, headers: { location: checksumRedirect } });
    }
    if (url === checksumRedirect) {
      assert.equal(requestHeaders?.Authorization, undefined);
      return new Response(`${hash}  ${artifact.vsix}\n`);
    }
    if (url === release.artifact.apiUrl) {
      assert.equal(requestHeaders?.Authorization, "Bearer secret");
      return new Response(null, { status: 302, headers: { location: vsixRedirect } });
    }
    if (url === vsixRedirect) {
      assert.equal(requestHeaders?.Authorization, undefined);
      return new Response(bytes);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const result = await downloadVerifiedVsix({ source: enterpriseSource, release, token: "secret", fetchImpl });
  assert.equal(result.kind, "downloaded");
  if (result.kind === "downloaded") assert.deepEqual(Buffer.from(result.bytes), bytes);

  const tooSmall = await downloadVerifiedVsix({ source: enterpriseSource, release, token: "secret", fetchImpl, maxBytes: 4 });
  assert.equal(tooSmall.kind, "invalid-metadata");
});

test("VSIX installation falls back only after the primary workbench installer fails", async () => {
  const calls: string[] = [];
  const selected = await installVsixThroughWorkbench("review.vsix", async command => {
    calls.push(command);
    if (command === VSIX_INSTALL_COMMANDS[0]) throw new Error("unavailable");
  });
  assert.equal(selected, VSIX_INSTALL_COMMANDS[1]);
  assert.deepEqual(calls, [...VSIX_INSTALL_COMMANDS]);
});
