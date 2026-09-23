import { createHash } from "node:crypto";
import {
  artifactNames,
  isAllowedAssetApiUrl,
  isAllowedAssetRedirect,
  isAllowedReleaseUrl,
  normalizeReleaseTag,
  targetForPlatform,
} from "./policy";
import type { GitHubReleaseUpdateSource, UpdateDownloadResult, UpdateFetchResult, UpdateRelease } from "./types";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_CHECKSUM_BYTES = 512;
const MAX_VSIX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

interface FetchOptions {
  source: GitHubReleaseUpdateSource;
  token?: string;
  etag?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface DownloadOptions {
  source: GitHubReleaseUpdateSource;
  release: UpdateRelease;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

class ResponseTooLargeError extends Error {}

function headers(token: string | undefined, accept: string): Record<string, string> {
  const result: Record<string, string> = { Accept: accept, "User-Agent": "Open-Markdown-Review-update-check" };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function linkedAbort(parent: AbortSignal | undefined): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return { controller, dispose: () => parent?.removeEventListener("abort", abort) };
}

async function limitedBytes(response: FetchResponse, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new ResponseTooLargeError();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}

async function assetResponse(fetchImpl: typeof fetch, url: string, source: GitHubReleaseUpdateSource, token: string | undefined, signal: AbortSignal): Promise<FetchResponse> {
  let response = await fetchImpl(url, { headers: headers(token, "application/octet-stream"), redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location || !isAllowedAssetRedirect(location, source)) return response;
    response = await fetchImpl(location, {
      headers: headers(undefined, "application/octet-stream"),
      redirect: "error",
      signal,
    });
  }
  return response;
}

function failure(error: unknown): UpdateFetchResult {
  if (error instanceof ResponseTooLargeError || error instanceof SyntaxError) {
    return { kind: "invalid-metadata", detail: "Release metadata is malformed or too large." };
  }
  if (error instanceof Error && error.name === "AbortError") return { kind: "unavailable", reason: "timeout" };
  return { kind: "unavailable", reason: "offline" };
}

export async function fetchLatestGitHubRelease(options: FetchOptions): Promise<UpdateFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const linked = linkedAbort(options.signal);
  const timer = setTimeout(() => linked.controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const requestHeaders = headers(options.token, "application/vnd.github+json");
    if (options.etag) requestHeaders["If-None-Match"] = options.etag;
    const response = await fetchImpl(options.source.latestReleaseApiUrl, { headers: requestHeaders, redirect: "error", signal: linked.controller.signal });
    if (response.status === 304) return { kind: "not-modified" };
    if ([401, 403, 404].includes(response.status)) return { kind: "authentication-required" };
    if (response.status >= 500) return { kind: "unavailable", reason: "server" };
    if (!response.ok) return { kind: "invalid-metadata", detail: `Unexpected GitHub response ${response.status}.` };
    const raw = JSON.parse(Buffer.from(await limitedBytes(response, MAX_METADATA_BYTES)).toString("utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid-metadata", detail: "Release metadata is not an object." };
    const record = raw as Record<string, unknown>;
    if (record.draft !== false || record.prerelease !== false || typeof record.tag_name !== "string" ||
        typeof record.html_url !== "string" || !Array.isArray(record.assets)) {
      return { kind: "invalid-metadata", detail: "Latest release metadata failed validation." };
    }
    const version = normalizeReleaseTag(record.tag_name);
    if (!version || record.tag_name !== `v${version}` || !isAllowedReleaseUrl(record.html_url, options.source, record.tag_name)) {
      return { kind: "invalid-metadata", detail: "Release identity failed validation." };
    }
    const target = targetForPlatform(options.platform ?? process.platform, options.arch ?? process.arch);
    const expected = artifactNames(options.source, version, target);
    const assets = record.assets.filter((asset): asset is Record<string, unknown> => !!asset && typeof asset === "object" && !Array.isArray(asset));
    const findOne = (name: string): string | undefined => {
      const matches = assets.filter(asset => asset.name === name && typeof asset.url === "string");
      if (matches.length !== 1) return undefined;
      const url = matches[0].url as string;
      return isAllowedAssetApiUrl(url, options.source) ? url : undefined;
    };
    const apiUrl = findOne(expected.vsix), checksumApiUrl = findOne(expected.checksum);
    if (!apiUrl || !checksumApiUrl) return { kind: "invalid-metadata", detail: `Release is missing the verified ${target} artifact pair.` };
    return {
      kind: "release",
      etag: response.headers.get("etag") ?? undefined,
      release: {
        version,
        tag: record.tag_name,
        releaseUrl: record.html_url,
        artifact: { name: expected.vsix, apiUrl, checksumName: expected.checksum, checksumApiUrl, target },
      },
    };
  } catch (error) {
    return failure(error);
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }
}

export async function downloadVerifiedVsix(options: DownloadOptions): Promise<UpdateDownloadResult> {
  const { source, release } = options;
  const expected = artifactNames(source, release.version, release.artifact.target);
  if (release.tag !== `v${release.version}` || !isAllowedReleaseUrl(release.releaseUrl, source, release.tag) ||
      release.artifact.name !== expected.vsix || release.artifact.checksumName !== expected.checksum ||
      !isAllowedAssetApiUrl(release.artifact.apiUrl, source) || !isAllowedAssetApiUrl(release.artifact.checksumApiUrl, source)) {
    return { kind: "invalid-metadata", detail: "Release artifact metadata failed validation." };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const linked = linkedAbort(options.signal);
  const timer = setTimeout(() => linked.controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const checksumResponse = await assetResponse(fetchImpl, release.artifact.checksumApiUrl, source, options.token, linked.controller.signal);
    if ([401, 403, 404].includes(checksumResponse.status)) return { kind: "authentication-required" };
    if (checksumResponse.status >= 500) return { kind: "unavailable", reason: "server" };
    if (!checksumResponse.ok) return { kind: "invalid-metadata", detail: "Release checksum could not be downloaded." };
    const checksumText = Buffer.from(await limitedBytes(checksumResponse, MAX_CHECKSUM_BYTES)).toString("utf8");
    const checksumMatch = checksumText.match(/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)\r?\n?$/);
    if (!checksumMatch || checksumMatch[2] !== release.artifact.name) {
      return { kind: "invalid-metadata", detail: "Release checksum file failed validation." };
    }
    const artifactResponse = await assetResponse(fetchImpl, release.artifact.apiUrl, source, options.token, linked.controller.signal);
    if ([401, 403, 404].includes(artifactResponse.status)) return { kind: "authentication-required" };
    if (artifactResponse.status >= 500) return { kind: "unavailable", reason: "server" };
    if (!artifactResponse.ok) return { kind: "invalid-metadata", detail: "Release VSIX could not be downloaded." };
    const bytes = await limitedBytes(artifactResponse, options.maxBytes ?? MAX_VSIX_BYTES);
    if (createHash("sha256").update(bytes).digest("hex") !== checksumMatch[1]) {
      return { kind: "invalid-metadata", detail: "Downloaded VSIX failed SHA-256 verification." };
    }
    return { kind: "downloaded", name: release.artifact.name, bytes };
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return { kind: "invalid-metadata", detail: "Release artifact is larger than the allowed limit." };
    if (error instanceof Error && error.name === "AbortError") return { kind: "unavailable", reason: "timeout" };
    return { kind: "unavailable", reason: "offline" };
  } finally {
    clearTimeout(timer);
    linked.dispose();
  }
}
