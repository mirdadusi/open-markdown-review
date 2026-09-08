import { readFile } from "node:fs/promises";
import path from "node:path";
import { ReviewStoreError, writeArtifactExclusive } from "./protocol/store";

export const PORTABLE_BROWSER_FILENAME = "OpenMarkdownReview.html";

/**
 * Installs the generic browser client beside the authoritative protocol files.
 * The client is deliberately not referenced by manifest.json: it is replaceable
 * software, not review evidence, and never contains review-specific state.
 */
export async function installPortableBrowserClient(
  reviewRoot: string,
  clientArtifactPath: string,
): Promise<string> {
  const bytes = await readFile(clientArtifactPath);
  if (!bytes.includes(Buffer.from('name="open-markdown-review-portable-client"', "utf8"))) {
    throw new ReviewStoreError("The packaged portable browser client is invalid.");
  }
  const target = path.join(reviewRoot, PORTABLE_BROWSER_FILENAME);
  await writeArtifactExclusive(target, bytes);
  return target;
}
