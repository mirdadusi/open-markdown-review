import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { DEFAULT_IO_CONCURRENCY, mapWithConcurrency } from "./concurrency";
import { createId } from "./ids";
import { appendEvent, sha256, writeBlob, writeRevision } from "./store";
import {
  ActorRef,
  EVENT_SCHEMA_VERSION,
  ExternalReference,
  MermaidDiagram,
  REVISION_SCHEMA_VERSION,
  RevisionCreatedEvent,
  RevisionDiagnostic,
  RevisionResource,
  ReviewManifest,
  ReviewRevision,
} from "./types";

export const MERMAID_RENDERER_VERSION = "11.10.1";

export interface SnapshotOptions {
  rootDocument: string;
  /** Exact workspace-relative Markdown paths to freeze. Defaults to all Markdown files for compatibility. */
  documentPaths?: string[];
  /** Physical review package directory. It may be inside or outside the source workspace. */
  storageRoot?: string;
  remoteResourceLimitBytes?: number;
  allowInsecureHttp?: boolean;
  fetchImplementation?: typeof fetch;
  ioConcurrency?: number;
  onProgress?: (message: string, completed: number, total: number) => void;
}

export interface SnapshotResult {
  revision: ReviewRevision;
  event: RevisionCreatedEvent;
}

interface DiscoveredResource {
  document: string;
  reference: string;
  alt?: string;
  role: "image" | "attachment";
}

interface ParsedDocument {
  images: DiscoveredResource[];
  attachments: DiscoveredResource[];
  externalReferences: ExternalReference[];
  mermaidDiagrams: MermaidDiagram[];
}

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const EXCLUDED_DIRECTORIES = new Set([".git", ".review", ".vscode", ".local-preview", "node_modules", "out", "dist"]);

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function deterministicId(prefix: string, input: string): string {
  return `${prefix}_${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

export function sanitizeExternalUri(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|sig|signature|secret|auth|api[-_]?key/i.test(key)) url.searchParams.set(key, "REDACTED");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

export function resourceIdFor(document: string, reference: string): string {
  return deterministicId("resource", `${document}\0${reference}`);
}

/** Stable table-v1 ID: table_ + first 24 hex SHA-256 characters of document NUL ordinal. */
export function tableIdFor(document: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error("Table ordinal must be a non-negative integer.");
  return deterministicId("table", `${document}\0${ordinal}`);
}

function parseInlineLinks(children: readonly Token[], document: string): {
  images: DiscoveredResource[];
  attachments: DiscoveredResource[];
  links: ExternalReference[];
} {
  const images: DiscoveredResource[] = [];
  const attachments: DiscoveredResource[] = [];
  const links: ExternalReference[] = [];
  const linkStack: Array<{ href: string; label: string; attach: boolean }> = [];
  for (const token of children) {
    if (token.type === "image") {
      const reference = token.attrGet("src");
      if (reference) images.push({ document, reference, alt: token.content || undefined, role: "image" });
    } else if (token.type === "link_open") {
      const href = token.attrGet("href");
      if (href) linkStack.push({ href, label: "", attach: token.attrGet("title")?.trim().toLowerCase() === "review:attach" });
    } else if (token.type === "link_close") {
      const open = linkStack.pop();
      if (open?.attach) {
        attachments.push({ document, reference: open.href, alt: open.label.trim() || undefined, role: "attachment" });
      } else if (open && /^https?:\/\//i.test(open.href)) {
        links.push({
          id: deterministicId("reference", `${document}\0${open.href}`),
          document,
          uri: sanitizeExternalUri(open.href),
          ...(open.label.trim() ? { label: open.label.trim() } : {}),
          relation: "link",
        });
      }
    } else if (linkStack.length && (token.type === "text" || token.type === "code_inline")) {
      linkStack[linkStack.length - 1].label += token.content;
    }
  }
  return { images, attachments, links };
}

export function inspectMarkdown(source: string, document: string): ParsedDocument {
  const images: DiscoveredResource[] = [];
  const attachments: DiscoveredResource[] = [];
  const externalReferences: ExternalReference[] = [];
  const mermaidDiagrams: MermaidDiagram[] = [];
  let mermaidOrdinal = 0;

  for (const token of markdown.parse(source, {})) {
    if (token.type === "inline" && token.children) {
      const parsed = parseInlineLinks(token.children, document);
      images.push(...parsed.images);
      attachments.push(...parsed.attachments);
      externalReferences.push(...parsed.links);
    } else if (token.type === "fence" && token.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
      const sourceText = token.content.trimEnd();
      mermaidDiagrams.push({
        id: deterministicId("diagram", `${document}\0${mermaidOrdinal}\0${sourceText}`),
        document,
        ordinal: mermaidOrdinal++,
        sourceDigest: sha256(sourceText),
        source: sourceText,
      });
    }
  }

  return {
    images,
    attachments,
    externalReferences: [...new Map(externalReferences.map((item) => [item.id, item])).values()],
    mermaidDiagrams,
  };
}

export async function findMarkdownFiles(workspaceRoot: string, concurrency = DEFAULT_IO_CONCURRENCY): Promise<string[]> {
  const result: string[] = [];
  let directories = [workspaceRoot];
  while (directories.length) {
    const levels = await mapWithConcurrency(directories, concurrency, async (directory) => {
      try {
        return await readdir(directory, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return [];
        throw error;
      }
    });
    const next: string[] = [];
    for (let index = 0; index < directories.length; index += 1) {
      for (const entry of levels[index]) {
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directories[index], entry.name);
        if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) next.push(absolute);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(toPosix(path.relative(workspaceRoot, absolute)));
      }
    }
    directories = next;
  }
  return result.sort();
}

function inferMediaType(reference: string, responseType?: string | null): string {
  const cleanType = responseType?.split(";", 1)[0]?.trim().toLowerCase();
  if (cleanType && cleanType !== "application/octet-stream") return cleanType;
  const extension = path.extname(reference.split(/[?#]/, 1)[0]).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".avif": "image/avif",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".csv": "text/csv",
      ".json": "application/json",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[extension] ?? "application/octet-stream"
  );
}

async function readLimitedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`resource is larger than ${limit} bytes`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error(`resource exceeded ${limit} bytes while downloading`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeDataUri(reference: string): { bytes: Uint8Array; mediaType: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(reference);
  if (!match) throw new Error("invalid data URI");
  const mediaType = match[1] || "text/plain";
  const bytes = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
  return { bytes, mediaType };
}

async function captureResource(
  sourceRoot: string,
  storageRoot: string,
  blobDirectory: ReviewManifest["blobDirectory"],
  resource: DiscoveredResource,
  options: SnapshotOptions,
): Promise<RevisionResource> {
  const referenceWithoutFragment = resource.reference.split("#", 1)[0];
  let bytes: Uint8Array;
  let mediaType: string;
  let sourceKind: RevisionResource["sourceKind"];

  if (referenceWithoutFragment.startsWith("data:")) {
    ({ bytes, mediaType } = decodeDataUri(referenceWithoutFragment));
    sourceKind = "data";
  } else if (/^https?:\/\//i.test(referenceWithoutFragment)) {
    const url = new URL(referenceWithoutFragment);
    if (url.protocol === "http:" && !options.allowInsecureHttp) throw new Error("plain HTTP capture is disabled");
    if (url.username || url.password) throw new Error("URLs containing credentials are not accepted");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await (options.fetchImplementation ?? fetch)(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Open-Markdown-Review/0.4" },
      });
      bytes = await readLimitedResponse(response, options.remoteResourceLimitBytes ?? 15 * 1024 * 1024);
      mediaType = inferMediaType(url.pathname, response.headers.get("content-type"));
    } finally {
      clearTimeout(timeout);
    }
    sourceKind = "remote";
  } else {
    const documentDirectory = path.dirname(path.resolve(sourceRoot, ...resource.document.split("/")));
    const decodedPath = decodeURIComponent(referenceWithoutFragment.split("?", 1)[0]);
    const target = path.resolve(documentDirectory, decodedPath);
    const relative = path.relative(path.resolve(sourceRoot), target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("local resource escapes the workspace");
    bytes = await readFile(target);
    mediaType = inferMediaType(decodedPath);
    sourceKind = "workspace";
  }

  if (resource.role === "image" && !mediaType.startsWith("image/")) throw new Error(`embedded image has unsupported media type ${mediaType}`);
  if (resource.role === "attachment" && /^(?:text\/html|application\/(?:javascript|x-msdownload|x-sh|x-executable))$/i.test(mediaType)) {
    throw new Error(`active attachment media type is blocked: ${mediaType}`);
  }
  const stored = await writeBlob(storageRoot, bytes, mediaType, blobDirectory);
  return {
    id: resourceIdFor(resource.document, resource.reference),
    document: resource.document,
    originalReference: sanitizeExternalUri(resource.reference),
    sourceKind,
    role: resource.role,
    ...(resource.alt ? { alt: resource.alt } : {}),
    capturedAt: new Date().toISOString(),
    ...stored,
  };
}

export async function createSnapshot(
  workspaceRoot: string,
  manifest: ReviewManifest,
  actor: ActorRef,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const storageRoot = options.storageRoot ?? path.join(workspaceRoot, ".review");
  const ioConcurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const requested = options.documentPaths?.length
    ? [...new Set(options.documentPaths)].sort()
    : await findMarkdownFiles(workspaceRoot, ioConcurrency);
  const unknown: string[] = [];
  await mapWithConcurrency(requested, ioConcurrency, async (item) => {
    if (!item || item.includes("\\") || path.isAbsolute(item) || item.split("/").includes("..") || !/\.md$/i.test(item)) {
      unknown.push(item);
      return;
    }
    const absolute = path.resolve(workspaceRoot, ...item.split("/"));
    const relative = path.relative(path.resolve(workspaceRoot), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      unknown.push(item);
      return;
    }
    try {
      if (!(await stat(absolute)).isFile()) unknown.push(item);
    } catch {
      unknown.push(item);
    }
  });
  if (unknown.length) throw new Error(`Selected Markdown document not found: ${unknown.join(", ")}`);
  if (!requested.length) throw new Error("Select at least one Markdown document for the revision.");
  if (!requested.includes(options.rootDocument)) throw new Error(`Root document is not in the selected review scope: ${options.rootDocument}`);

  let completed = 0;
  const documentCaptures = await mapWithConcurrency(requested, ioConcurrency, async (documentPath) => {
    const bytes = await readFile(path.resolve(workspaceRoot, ...documentPath.split("/")));
    const result = {
      document: { path: documentPath, ...(await writeBlob(storageRoot, bytes, "text/markdown", manifest.blobDirectory)) },
      parsed: inspectMarkdown(bytes.toString("utf8"), documentPath),
    };
    completed += 1;
    options.onProgress?.(`Frozen ${documentPath}`, completed, requested.length);
    return result;
  });
  const documents = documentCaptures.map((capture) => capture.document);
  const images: DiscoveredResource[] = [];
  const attachments: DiscoveredResource[] = [];
  const externalReferences: ExternalReference[] = [];
  const mermaidDiagrams: MermaidDiagram[] = [];
  for (const { parsed } of documentCaptures) {
    images.push(...parsed.images);
    attachments.push(...parsed.attachments);
    externalReferences.push(...parsed.externalReferences);
    mermaidDiagrams.push(...parsed.mermaidDiagrams);
  }

  const diagnostics: RevisionDiagnostic[] = [];
  const discoveredResources = [...images, ...attachments];
  const totalWork = requested.length + discoveredResources.length;
  const captures = await mapWithConcurrency(discoveredResources, ioConcurrency, async (resource) => {
    try {
      const captured = await captureResource(workspaceRoot, storageRoot, manifest.blobDirectory, resource, options);
      completed += 1;
      options.onProgress?.(`Frozen ${resource.reference}`, completed, totalWork);
      return captured;
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "resource.capture-failed",
        document: resource.document,
        reference: sanitizeExternalUri(resource.reference),
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  });
  if (diagnostics.some((item) => item.severity === "error")) {
    const details = diagnostics.map((item) => `${item.document}: ${item.reference}: ${item.message}`).join("\n");
    throw new Error(`The revision was not created because an embedded resource could not be frozen:\n${details}`);
  }

  const now = new Date();
  const revision: ReviewRevision = {
    schemaVersion: REVISION_SCHEMA_VERSION,
    id: createId("revision", now),
    reviewId: manifest.reviewId,
    createdAt: now.toISOString(),
    createdBy: actor,
    rootDocument: options.rootDocument,
    documents,
    resources: captures.filter((resource): resource is RevisionResource => resource !== undefined),
    externalReferences: [...new Map(externalReferences.map((item) => [item.id, item])).values()],
    mermaidDiagrams,
    diagnostics,
    renderer: { markdownProfile: "commonmark-gfm", mermaidVersion: MERMAID_RENDERER_VERSION },
  };
  const stored = await writeRevision(storageRoot, revision, manifest.revisionDirectory);
  const event: RevisionCreatedEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: createId("evt", now),
    type: "revision.created",
    reviewId: manifest.reviewId,
    occurredAt: now.toISOString(),
    actor,
    revisionId: revision.id,
    ...stored,
  };
  options.onProgress?.("Publishing immutable revision", totalWork, totalWork);
  await appendEvent(storageRoot, event, manifest);
  return { revision, event };
}
