import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSafeEventId } from "./ids";
import {
  ReviewEvent,
  ReviewManifest,
  ReviewRevision,
  Sha256Digest,
  StoredContent,
} from "./types";
import { validateEvent, validateEventCapabilities, validateManifest, validateRevision } from "./validation";

export interface LoadedEvents {
  events: ReviewEvent[];
  warnings: string[];
}

export class ReviewStoreError extends Error {}

export function sha256(content: Uint8Array | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** The review root is the package directory itself. It may have any name and location. */
export function reviewPaths(reviewRoot: string) {
  return {
    reviewDirectory: reviewRoot,
    manifest: path.join(reviewRoot, "manifest.json"),
    events: path.join(reviewRoot, "events"),
    revisions: path.join(reviewRoot, "revisions"),
    blobs: path.join(reviewRoot, "blobs", "sha256"),
    exports: path.join(reviewRoot, "exports"),
  };
}

function resolveInside(rootPath: string, relativePath: string, kind: string): string {
  if (!relativePath || relativePath.includes("\\") || relativePath.split("/").includes("..") || path.isAbsolute(relativePath)) {
    throw new ReviewStoreError(`Unsafe ${kind} path: ${relativePath}`);
  }
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ReviewStoreError(`${kind} path escapes its root: ${relativePath}`);
  }
  return resolved;
}

export function resolveInsideWorkspace(workspaceRoot: string, relativePath: string): string {
  return resolveInside(workspaceRoot, relativePath, "workspace");
}

/** Resolves both portable 0.4 paths and legacy `.review/...` paths. */
export function resolveInsideReview(reviewRoot: string, relativePath: string): string {
  const segments = relativePath.split("/");
  if (segments[0] === ".review") segments.shift();
  return resolveInside(reviewRoot, segments.join("/"), "review package");
}

async function writeExclusiveAtomic(target: string, content: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
  await writeFile(temporary, content, { flag: "wx" });
  try {
    // A hard link is an atomic, exclusive publish on the same filesystem.
    try {
      await link(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code ?? "")) throw error;
      // Some mounted SMB/NAS filesystems do not expose hard links. COPYFILE_EXCL
      // retains collision safety; readers already ignore incomplete sync files.
      await copyFile(temporary, target, constants.COPYFILE_EXCL);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function writeArtifactExclusive(target: string, content: Uint8Array): Promise<void> {
  try {
    await writeExclusiveAtomic(target, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ReviewStoreError(`${path.basename(target)} already exists.`);
    }
    throw error;
  }
}

async function writeJsonExclusive(target: string, value: unknown): Promise<Uint8Array> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await writeExclusiveAtomic(target, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ReviewStoreError(`${path.basename(target)} already exists.`);
    }
    throw error;
  }
  return bytes;
}

export async function initializeReview(reviewRoot: string, manifest: ReviewManifest): Promise<void> {
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new ReviewStoreError(validation.errors.join("; "));
  const paths = reviewPaths(reviewRoot);
  await Promise.all([
    mkdir(paths.events, { recursive: true }),
    mkdir(paths.revisions, { recursive: true }),
    mkdir(paths.blobs, { recursive: true }),
    mkdir(paths.exports, { recursive: true }),
  ]);
  await writeJsonExclusive(paths.manifest, manifest).catch((error) => {
    if (error instanceof ReviewStoreError) {
      throw new ReviewStoreError("A review is already initialized in this folder.");
    }
    throw error;
  });
  // Content-addressed files and revision digests require Git to preserve exact bytes.
  await writeExclusiveAtomic(
    path.join(reviewRoot, ".gitattributes"),
    "# Preserve auditable review package bytes exactly.\n* -text\n**/* -text\n",
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

export async function loadManifest(reviewRoot: string): Promise<ReviewManifest | undefined> {
  const target = reviewPaths(reviewRoot).manifest;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new ReviewStoreError(`Invalid JSON in ${target}: ${error.message}`);
    throw error;
  }
  const validation = validateManifest(value);
  if (!validation.ok) throw new ReviewStoreError(`Invalid review manifest: ${validation.errors.join("; ")}`);
  return validation.value;
}

/** Writes immutable bytes once and returns their content-addressed reference. */
export async function writeBlob(
  reviewRoot: string,
  content: Uint8Array,
  mediaType: string,
  blobDirectory = "blobs/sha256",
): Promise<StoredContent> {
  const digest = sha256(content);
  const hash = digest.slice("sha256:".length);
  const blobPath = `${blobDirectory}/${hash.slice(0, 2)}/${hash}`;
  const target = resolveInsideReview(reviewRoot, blobPath);
  try {
    await writeExclusiveAtomic(target, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (sha256(existing) !== digest) throw new ReviewStoreError(`Blob collision detected for ${digest}`);
  }
  return { digest, blobPath, mediaType, byteLength: content.byteLength };
}

export async function writeRevision(
  reviewRoot: string,
  revision: ReviewRevision,
  revisionDirectory = "revisions",
): Promise<{ revisionPath: string; revisionDigest: Sha256Digest }> {
  const validation = validateRevision(revision);
  if (!validation.ok) throw new ReviewStoreError(validation.errors.join("; "));
  const revisionPath = `${revisionDirectory}/${revision.id}.json`;
  const bytes = await writeJsonExclusive(resolveInsideReview(reviewRoot, revisionPath), revision);
  return { revisionPath, revisionDigest: sha256(bytes) };
}

export async function loadRevision(
  reviewRoot: string,
  revisionPath: string,
  expectedDigest?: Sha256Digest,
): Promise<ReviewRevision> {
  const target = resolveInsideReview(reviewRoot, revisionPath);
  const bytes = await readFile(target);
  if (expectedDigest && sha256(bytes) !== expectedDigest) {
    throw new ReviewStoreError(`Revision integrity check failed: ${revisionPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ReviewStoreError(`Invalid revision JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const validation = validateRevision(value);
  if (!validation.ok) throw new ReviewStoreError(`Invalid revision: ${validation.errors.join("; ")}`);
  return validation.value;
}

/** Persists one action to one exclusive-create file; existing files are never edited. */
export async function appendEvent(reviewRoot: string, event: ReviewEvent): Promise<string> {
  const validation = validateEvent(event);
  if (!validation.ok) throw new ReviewStoreError(validation.errors.join("; "));
  if (!isSafeEventId(event.id)) throw new ReviewStoreError("Event id is not safe for use as a filename.");
  const manifest = await loadManifest(reviewRoot);
  if (!manifest) throw new ReviewStoreError("Initialize the review before adding events.");
  if (event.reviewId !== manifest.reviewId) throw new ReviewStoreError("Event reviewId does not match the manifest.");
  const capabilityErrors = validateEventCapabilities(manifest, event);
  if (capabilityErrors.length) throw new ReviewStoreError(capabilityErrors.join("; "));
  const target = path.join(resolveInsideReview(reviewRoot, manifest.eventDirectory), `${event.id}.json`);
  await writeJsonExclusive(target, event);
  return target;
}

export async function loadEvents(reviewRoot: string, reviewId?: string): Promise<LoadedEvents> {
  const manifest = await loadManifest(reviewRoot);
  const eventsDirectory = manifest
    ? resolveInsideReview(reviewRoot, manifest.eventDirectory)
    : reviewPaths(reviewRoot).events;
  let names: string[];
  try {
    names = (await readdir(eventsDirectory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], warnings: [] };
    throw error;
  }

  const events: ReviewEvent[] = [];
  const warnings: string[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        const value: unknown = JSON.parse(await readFile(path.join(eventsDirectory, name), "utf8"));
        const validation = validateEvent(value);
        if (!validation.ok) warnings.push(`${name}: ${validation.errors.join("; ")}`);
        else if (name !== `${validation.value.id}.json`) warnings.push(`${name}: filename must be ${validation.value.id}.json`);
        else if (reviewId && validation.value.reviewId !== reviewId) warnings.push(`${name}: reviewId does not match manifest`);
        else events.push(validation.value);
      } catch (error) {
        warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  return { events, warnings: warnings.sort() };
}

export async function verifyRevisionContent(
  reviewRoot: string,
  revision: ReviewRevision,
): Promise<string[]> {
  const errors: string[] = [];
  for (const content of [...revision.documents, ...revision.resources]) {
    try {
      const bytes = await readFile(resolveInsideReview(reviewRoot, content.blobPath));
      if (sha256(bytes) !== content.digest) errors.push(`${content.blobPath}: digest mismatch`);
      if (bytes.byteLength !== content.byteLength) errors.push(`${content.blobPath}: byte length mismatch`);
    } catch (error) {
      errors.push(`${content.blobPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
