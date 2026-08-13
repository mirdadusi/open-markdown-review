import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadManifest } from "./store";
import { ReviewManifest } from "./types";

export interface DiscoveredReviewPackage {
  reviewRoot: string;
  manifest: ReviewManifest;
}

const EXCLUDED = new Set([".git", "node_modules", "out", "dist"]);

/** Finds review packages below a user-selected folder without following links. */
export async function discoverReviewPackages(
  selectedRoot: string,
  maxDepth = 4,
  maxResults = 50,
): Promise<DiscoveredReviewPackage[]> {
  const found: DiscoveredReviewPackage[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (found.length >= maxResults) return;
    try {
      const manifest = await loadManifest(directory);
      if (manifest) {
        found.push({ reviewRoot: directory, manifest });
        return;
      }
    } catch {
      // A foreign or invalid manifest.json does not make its directory a review package.
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !EXCLUDED.has(entry.name))
      .map((entry) => visit(path.join(directory, entry.name), depth + 1)));
  }
  await visit(path.resolve(selectedRoot), 0);
  return found.sort((left, right) => left.manifest.title.localeCompare(right.manifest.title) || left.reviewRoot.localeCompare(right.reviewRoot));
}
