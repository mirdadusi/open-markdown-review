import sourceJson from "../../release/update-source.json";
import type { GitHubReleaseUpdateSource, MarketplaceUpdateSource, UpdateSource } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isHostname(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.toLowerCase()) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && url.port === "" && url.pathname === "/";
  } catch {
    return false;
  }
}

export function validateUpdateSource(value: unknown): UpdateSource {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.extensionId !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(value.extensionId)) {
    throw new Error("Update source identity is invalid.");
  }

  if (value.channel === "marketplace") {
    const expected = `https://marketplace.visualstudio.com/items?itemName=${value.extensionId}`;
    if (!isHttpsUrl(value.marketplaceItemUrl) || value.marketplaceItemUrl !== expected) {
      throw new Error("Marketplace update source URL does not match its extension identity.");
    }
    return value as unknown as MarketplaceUpdateSource;
  }

  if (value.channel === "github-release") {
    for (const key of ["owner", "repository", "artifactBaseName"]) {
      if (typeof value[key] !== "string" || !value[key]) throw new Error(`GitHub update source is missing ${key}.`);
    }
    if (!isHostname(value.host) || !isHttpsUrl(value.releasesUrl) || !isHttpsUrl(value.latestReleaseApiUrl) ||
        !Array.isArray(value.assetRedirectHosts) || value.assetRedirectHosts.some(host => !isHostname(host))) {
      throw new Error("GitHub update source endpoints are invalid.");
    }
    const expectedReleases = `https://${value.host}/${value.owner}/${value.repository}/releases`;
    const expectedApi = `https://${value.host}/api/v3/repos/${value.owner}/${value.repository}/releases/latest`;
    if (value.releasesUrl !== expectedReleases || value.latestReleaseApiUrl !== expectedApi) {
      throw new Error("GitHub update source URLs do not match its repository identity.");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value.artifactBaseName as string)) {
      throw new Error("GitHub update artifact base name is invalid.");
    }
    return value as unknown as GitHubReleaseUpdateSource;
  }

  throw new Error("Unsupported update source channel.");
}

export const OMR_UPDATE_SOURCE = validateUpdateSource(sourceJson);
