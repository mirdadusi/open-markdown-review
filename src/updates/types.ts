export interface MarketplaceUpdateSource {
  schemaVersion: 1;
  channel: "marketplace";
  extensionId: string;
  marketplaceItemUrl: string;
}

export interface GitHubReleaseUpdateSource {
  schemaVersion: 1;
  channel: "github-release";
  extensionId: string;
  host: string;
  owner: string;
  repository: string;
  releasesUrl: string;
  latestReleaseApiUrl: string;
  assetRedirectHosts: string[];
  artifactBaseName: string;
}

export type UpdateSource = MarketplaceUpdateSource | GitHubReleaseUpdateSource;
export type UpdateTarget = "portable" | "win32-x64";

export interface ReleaseArtifact {
  name: string;
  apiUrl: string;
  checksumName: string;
  checksumApiUrl: string;
  target: UpdateTarget;
}

export interface UpdateRelease {
  version: string;
  tag: string;
  releaseUrl: string;
  artifact: ReleaseArtifact;
}

export type UpdateFetchResult =
  | { kind: "release"; release: UpdateRelease; etag?: string }
  | { kind: "not-modified" }
  | { kind: "authentication-required" }
  | { kind: "unavailable"; reason: "offline" | "timeout" | "server" }
  | { kind: "invalid-metadata"; detail: string };

export type UpdateDownloadResult =
  | { kind: "downloaded"; name: string; bytes: Uint8Array }
  | { kind: "authentication-required" }
  | { kind: "unavailable"; reason: "offline" | "timeout" | "server" }
  | { kind: "invalid-metadata"; detail: string };

export interface StoredUpdateState {
  lastCheckedAt?: string;
  retryAfter?: string;
  etag?: string;
  cachedRelease?: UpdateRelease;
  lastNotifiedVersion?: string;
  remindVersion?: string;
  remindAfter?: string;
}
