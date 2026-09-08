import MarkdownIt from "markdown-it";
import mermaid from "mermaid";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import eventSchema from "../../protocol/schemas/event.schema.json";
import manifestSchema from "../../protocol/schemas/manifest.schema.json";
import revisionSchema from "../../protocol/schemas/revision.schema.json";
import { buildReviewState } from "../protocol/state";
import type {
  ActorRef,
  MarkdownAnchor,
  ReviewEvent,
  ReviewManifest,
  ReviewRevision,
  ReviewThread,
  Sha256Digest,
} from "../protocol/types";

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

interface LoadedDocument {
  source: string;
  digest: Sha256Digest;
}

const eventFiles = new Map<string, ReviewEvent>();
const documents = new Map<string, LoadedDocument>();
const resourceUrls = new Map<string, string>();
const HANDLE_DATABASE = "open-markdown-review-portable";
const HANDLE_STORE = "review-folders";
const HANDLE_KEY = location.href;
let reviewRoot: FileSystemDirectoryHandle | undefined;
let rememberedReviewRoot: FileSystemDirectoryHandle | undefined;
let manifest: ReviewManifest | undefined;
let revision: ReviewRevision | undefined;
let state = buildReviewState([]);
let activeDocument = "";
let pollTimer: number | undefined;
let selectedSemanticTarget: HTMLElement | undefined;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateManifestSchema = ajv.compile(manifestSchema);
const validateRevisionSchema = ajv.compile(revisionSchema);
const validateEventSchema = ajv.compile(eventSchema);

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Portable client element is missing: ${selector}`);
  return element;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function status(message: string, kind: "ready" | "working" | "warning" = "ready"): void {
  const element = $("#sync-status");
  element.textContent = message;
  element.className = `sync-status ${kind}`;
}

function showToast(message: string): void {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Folder selection was cancelled.";
  return error instanceof Error ? error.message : String(error);
}

function handlePermissionApi(handle: FileSystemDirectoryHandle): FileSystemDirectoryHandle & {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
} {
  return handle as FileSystemDirectoryHandle & {
    queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  };
}

function handleDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) request.result.createObjectStore(HANDLE_STORE);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Could not open browser handle storage.")));
  });
}

async function storedReviewHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const database = await handleDatabase();
  try {
    return await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, "readonly");
      const request = transaction.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      request.addEventListener("success", () => resolve(request.result as FileSystemDirectoryHandle | undefined));
      request.addEventListener("error", () => reject(request.error ?? new Error("Could not read the remembered review folder.")));
    });
  } finally {
    database.close();
  }
}

async function rememberReviewHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await handleDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Could not remember the review folder.")));
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Could not remember the review folder.")));
    });
  } finally {
    database.close();
  }
}

async function forgetReviewHandle(): Promise<void> {
  const database = await handleDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      transaction.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Could not forget the unavailable review folder.")));
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Could not forget the unavailable review folder.")));
    });
  } finally {
    database.close();
  }
}

function safeSegments(relativePath: string): string[] {
  const segments = relativePath.split("/");
  if (!relativePath || relativePath.includes("\\") || segments.some((item) => !item || item === "." || item === "..")) {
    throw new Error(`Unsafe review-package path: ${relativePath}`);
  }
  return segments[0] === ".review" ? segments.slice(1) : segments;
}

async function directoryAt(relativePath: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!reviewRoot) throw new Error("Choose a review folder first.");
  let current = reviewRoot;
  for (const segment of safeSegments(relativePath)) current = await current.getDirectoryHandle(segment, { create });
  return current;
}

async function fileAt(relativePath: string): Promise<FileSystemFileHandle> {
  if (!reviewRoot) throw new Error("Choose a review folder first.");
  const segments = safeSegments(relativePath);
  const name = segments.pop();
  if (!name) throw new Error(`Invalid file path: ${relativePath}`);
  let current = reviewRoot;
  for (const segment of segments) current = await current.getDirectoryHandle(segment);
  return current.getFileHandle(name);
}

async function readBytes(relativePath: string): Promise<Uint8Array> {
  const file = await (await fileAt(relativePath)).getFile();
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

async function readJson<T>(relativePath: string): Promise<{ value: T; bytes: Uint8Array }> {
  const bytes = await readBytes(relativePath);
  return { value: JSON.parse(new TextDecoder().decode(bytes)) as T, bytes };
}

async function sha256(bytes: Uint8Array | string): Promise<Sha256Digest> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const stable = new Uint8Array(input.byteLength);
  stable.set(input);
  const digest = await crypto.subtle.digest("SHA-256", stable.buffer);
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function assertManifest(value: unknown): asserts value is ReviewManifest {
  if (!validateManifestSchema(value)) throw new Error(`Invalid review manifest: ${ajv.errorsText(validateManifestSchema.errors)}`);
}

function assertRevision(value: unknown): asserts value is ReviewRevision {
  if (!validateRevisionSchema(value)) throw new Error(`Invalid revision descriptor: ${ajv.errorsText(validateRevisionSchema.errors)}`);
  if ((value as unknown as ReviewRevision).reviewId !== manifest?.reviewId) throw new Error("The revision belongs to a different review.");
}

function assertEvent(value: unknown): asserts value is ReviewEvent {
  if (!validateEventSchema(value)) throw new Error(`Invalid review event: ${ajv.errorsText(validateEventSchema.errors)}`);
  const event = value as ReviewEvent;
  if (event.reviewId !== manifest?.reviewId) throw new Error(`Event ${event.id} belongs to a different review.`);
}

async function refreshEvents(): Promise<number> {
  if (!manifest) return 0;
  const directory = await directoryAt(manifest.eventDirectory);
  const present = new Set<string>();
  let added = 0;
  const entries = (directory as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }).entries();
  for await (const [name, handle] of entries) {
    if (handle.kind !== "file" || !name.endsWith(".json")) continue;
    present.add(name);
    if (eventFiles.has(name)) continue;
    try {
      const event = JSON.parse(await (handle as FileSystemFileHandle).getFile().then((file) => file.text())) as unknown;
      assertEvent(event);
      if (`${event.id}.json` !== name) throw new Error(`Event filename does not match its ID: ${name}`);
      eventFiles.set(name, event);
      added += 1;
    } catch (error) {
      console.warn(`Ignored invalid or partially synchronized event ${name}`, error);
    }
  }
  if ([...eventFiles.keys()].some((name) => !present.has(name))) {
    status("Audit warning: a previously read event disappeared", "warning");
  }
  state = buildReviewState([...eventFiles.values()]);
  return added;
}

async function loadLatestRevision(): Promise<void> {
  if (!manifest) throw new Error("Review manifest is not loaded.");
  const latest = state.revisionEvents.at(-1);
  if (!latest) throw new Error("This review has no published revision yet.");
  if (revision?.id === latest.revisionId) return;
  const descriptor = await readJson<ReviewRevision>(latest.revisionPath);
  assertRevision(descriptor.value);
  if (descriptor.value.id !== latest.revisionId) throw new Error("Revision event and descriptor IDs do not match.");
  if (await sha256(descriptor.bytes) !== latest.revisionDigest) throw new Error("Revision descriptor digest verification failed.");
  revision = descriptor.value;
  documents.clear();
  for (const url of resourceUrls.values()) URL.revokeObjectURL(url);
  resourceUrls.clear();
  activeDocument = revision.rootDocument || revision.documents[0]?.path || "";
  renderChrome();
  await renderActiveDocument();
}

function resetReviewConnection(): void {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = undefined;
  reviewRoot = undefined;
  manifest = undefined;
  revision = undefined;
  eventFiles.clear();
  documents.clear();
  for (const url of resourceUrls.values()) URL.revokeObjectURL(url);
  resourceUrls.clear();
  state = buildReviewState([]);
  activeDocument = "";
  selectedSemanticTarget = undefined;
}

async function connectReviewHandle(selected: FileSystemDirectoryHandle, remember: boolean): Promise<void> {
  resetReviewConnection();
  reviewRoot = selected;
  try {
    const loadedManifest = await readJson<ReviewManifest>("manifest.json");
    assertManifest(loadedManifest.value);
    manifest = loadedManifest.value;
    await refreshEvents();
    await loadLatestRevision();
  } catch (error) {
    resetReviewConnection();
    throw error;
  }
  $("#welcome").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  renderState();
  status("Live file sync · checking every 3 seconds");
  pollTimer = window.setInterval(() => void poll(), 3000);
  if (remember) {
    try {
      await rememberReviewHandle(selected);
      rememberedReviewRoot = selected;
    } catch (error) {
      console.warn("The review works, but this browser could not remember the folder handle.", error);
    }
  }
}

async function openReviewFolder(): Promise<void> {
  if (!window.showDirectoryPicker) throw new Error("This browser cannot grant direct folder access. Use current Microsoft Edge or Google Chrome, or open the review in VS Code.");
  status("Waiting for folder permission…", "working");
  let selected = rememberedReviewRoot;
  if (selected) {
    const permission = await handlePermissionApi(selected).requestPermission({ mode: "readwrite" });
    if (permission === "granted") {
      try {
        await connectReviewHandle(selected, false);
        return;
      } catch (error) {
        console.warn("The remembered review folder could not be opened; asking the participant to select the package again.", error);
      }
    }
    rememberedReviewRoot = undefined;
    await forgetReviewHandle().catch(() => undefined);
  }
  selected = await window.showDirectoryPicker({ id: "open-markdown-review", mode: "readwrite" });
  await connectReviewHandle(selected, true);
}

async function restoreRememberedReview(): Promise<void> {
  if (!window.showDirectoryPicker || !window.indexedDB) {
    document.documentElement.dataset.handleRestore = "unsupported";
    return;
  }
  try {
    rememberedReviewRoot = await storedReviewHandle();
    if (!rememberedReviewRoot) {
      document.documentElement.dataset.handleRestore = "none";
      return;
    }
    const permission = await handlePermissionApi(rememberedReviewRoot).queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      status("Opening remembered review…", "working");
      await connectReviewHandle(rememberedReviewRoot, false);
      document.documentElement.dataset.handleRestore = "opened";
      return;
    }
    document.documentElement.dataset.handleRestore = "permission-required";
    ($<HTMLButtonElement>("#open-folder")).textContent = "Allow access to this review folder";
    $("#welcome-detail").textContent = "This browser remembers the review folder, but requires permission again before it can read or append events.";
  } catch (error) {
    console.warn("The remembered review folder is no longer usable.", error);
    document.documentElement.dataset.handleRestore = "retry-required";
    $("#welcome-detail").textContent = "The remembered review could not be opened. Allow access again; if it is unavailable, choose this review package when prompted.";
  }
}

async function poll(): Promise<void> {
  try {
    const added = await refreshEvents();
    const priorRevision = revision?.id;
    await loadLatestRevision();
    if (added) {
      renderState();
      if (revision?.id === priorRevision) await renderActiveDocument(true);
      showToast(`${added} new review update${added === 1 ? "" : "s"}`);
    }
    status("Live file sync · up to date");
  } catch (error) {
    status(`Sync delayed · ${errorMessage(error)}`, "warning");
  }
}

async function verifiedDocument(path: string): Promise<LoadedDocument> {
  const cached = documents.get(path);
  if (cached) return cached;
  const descriptor = revision?.documents.find((item) => item.path === path);
  if (!descriptor) throw new Error(`Frozen document is missing from the revision: ${path}`);
  const bytes = await readBytes(descriptor.blobPath);
  const digest = await sha256(bytes);
  if (digest !== descriptor.digest) throw new Error(`Frozen document digest verification failed: ${path}`);
  const loaded = { source: new TextDecoder().decode(bytes), digest };
  documents.set(path, loaded);
  return loaded;
}

async function resourceUrl(resourceId: string): Promise<string> {
  const cached = resourceUrls.get(resourceId);
  if (cached) return cached;
  const resource = revision?.resources.find((item) => item.id === resourceId);
  if (!resource) throw new Error(`Frozen resource is missing: ${resourceId}`);
  const bytes = await readBytes(resource.blobPath);
  if (await sha256(bytes) !== resource.digest) throw new Error(`Frozen resource digest verification failed: ${resource.originalReference}`);
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const url = URL.createObjectURL(new Blob([stable.buffer], { type: resource.mediaType }));
  resourceUrls.set(resourceId, url);
  return url;
}

function isOpen(thread: ReviewThread): boolean {
  return thread.decisionConflicts.length > 0 || (!thread.resolved && !thread.decision);
}

async function tableIds(documentPath: string, count: number): Promise<string[]> {
  return Promise.all(Array.from({ length: count }, async (_, ordinal) => `table_${(await sha256(`${documentPath}\0${ordinal}`)).slice(7, 31)}`));
}

async function markdownHtml(source: string, documentPath: string): Promise<string> {
  if (!revision) return "";
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  md.validateLink = (url) => /^(?:https?:|mailto:|#|\.\.?\/)/i.test(url);
  const tokens = md.parse(source, {});
  const tableCount = tokens.filter((token) => token.type === "table_open").length;
  const stableTableIds = await tableIds(documentPath, tableCount);
  const references = new Set<string>();
  for (const token of tokens) {
    if (token.type !== "inline") continue;
    for (const child of token.children ?? []) {
      if (child.type === "image") references.add(child.attrGet("src") ?? "");
      if (child.type === "link_open" && child.attrGet("title")?.trim().toLowerCase() === "review:attach") references.add(child.attrGet("href") ?? "");
    }
  }
  const resourceIds = new Map(await Promise.all([...references].map(async (reference) => {
    const digest = await sha256(`${documentPath}\0${reference}`);
    return [reference, `resource_${digest.slice(7, 31)}`] as const;
  })));
  let tableOrdinal = 0;
  let mermaidOrdinal = 0;
  for (const token of tokens) {
    if (["paragraph_open", "heading_open", "blockquote_open", "list_item_open"].includes(token.type) && token.map) {
      token.attrJoin("class", "review-text-block");
      token.attrSet("data-line-start", String(token.map[0]));
      token.attrSet("data-line-end", String(Math.max(token.map[0], token.map[1] - 1)));
    }
    if (token.type === "inline" && token.children) for (const child of token.children) child.meta = { ...(child.meta ?? {}), map: token.map };
    if (token.type === "table_open") token.meta = { ...(token.meta ?? {}), tableId: stableTableIds[tableOrdinal++] };
    if (token.type === "fence" && token.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
      token.meta = { ...(token.meta ?? {}), diagram: revision.mermaidDiagrams.find((item) => item.document === documentPath && item.ordinal === mermaidOrdinal++) };
    }
  }

  const threads = [...state.threads.values()].filter((thread) => thread.revisionId === revision?.id && thread.root.anchor.document === documentPath);
  const defaultText = md.renderer.rules.text;
  md.renderer.rules.text = (items, index, options, env, self) => {
    const token = items[index];
    let output = defaultText ? defaultText(items, index, options, env, self) : escapeHtml(token.content);
    const lineMap = token.meta?.map as [number, number] | undefined;
    const matching = threads.filter((thread) => {
      const target = thread.root.anchor.target;
      if (target && target.kind !== "text") return false;
      if (!token.content.includes(thread.root.anchor.quote.exact)) return false;
      return !lineMap || (thread.root.anchor.range.start.line <= lineMap[1] - 1 && thread.root.anchor.range.end.line >= lineMap[0]);
    });
    for (const thread of matching.sort((left, right) => right.root.anchor.quote.exact.length - left.root.anchor.quote.exact.length)) {
      const exact = escapeHtml(thread.root.anchor.quote.exact);
      if (!exact || !output.includes(exact)) continue;
      output = output.replace(exact, `<mark class="comment-anchor ${isOpen(thread) ? "open" : "closed"}" data-thread-id="${escapeHtml(thread.id)}">${exact}<span>●</span></mark>`);
    }
    return output;
  };

  md.renderer.rules.image = (items, index) => {
    const token = items[index];
    const reference = token.attrGet("src") ?? "";
    const resource = revision?.resources.find((item) => item.id === resourceIds.get(reference) && item.role === "image");
    if (!resource) return `<div class="resource-error">Image was not frozen: ${escapeHtml(reference)}</div>`;
    const comments = threads.filter((thread) => thread.root.anchor.target?.kind === "image" && thread.root.anchor.target.resourceId === resource.id);
    const ids = comments.map((item) => item.id).join(" ");
    const lineMap = token.meta?.map as [number, number] | undefined;
    return `<figure class="selectable-block${comments.length ? " commented" : ""}" data-target-kind="image" data-resource-id="${escapeHtml(resource.id)}" data-label="${escapeHtml(token.content || resource.alt || "Image")}" data-line-start="${lineMap?.[0] ?? 0}" data-line-end="${Math.max(lineMap?.[0] ?? 0, (lineMap?.[1] ?? 1) - 1)}" data-thread-ids="${escapeHtml(ids)}"><img data-frozen-resource="${escapeHtml(resource.id)}" alt="${escapeHtml(token.content || resource.alt || "Image")}"><figcaption>${escapeHtml(token.content || resource.alt || "Image")}</figcaption></figure>`;
  };

  const defaultLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (items, index, options, env, self) => {
    const token = items[index];
    const reference = token.attrGet("href") ?? "";
    if (token.attrGet("title")?.trim().toLowerCase() === "review:attach") {
      const resource = revision?.resources.find((item) => item.id === resourceIds.get(reference) && item.role === "attachment");
      if (resource) {
        token.attrSet("href", "#");
        token.attrSet("data-attachment-id", resource.id);
        token.attrJoin("class", "frozen-attachment");
      }
    } else if (/^https?:\/\//i.test(reference)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noreferrer noopener");
    }
    return defaultLink ? defaultLink(items, index, options, env, self) : self.renderToken(items, index, options);
  };

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (items, index, options, env, self) => {
    const token = items[index];
    if (token.info.trim().split(/\s+/)[0]?.toLowerCase() !== "mermaid") return defaultFence ? defaultFence(items, index, options, env, self) : self.renderToken(items, index, options);
    const diagram = token.meta?.diagram as ReviewRevision["mermaidDiagrams"][number] | undefined;
    if (!diagram) return '<pre class="resource-error">Frozen Mermaid descriptor is missing.</pre>';
    const comments = threads.filter((thread) => thread.root.anchor.target?.kind === "mermaid" && thread.root.anchor.target.diagramId === diagram.id);
    return `<div class="mermaid-block selectable-block${comments.length ? " commented" : ""}" data-target-kind="mermaid" data-diagram-id="${escapeHtml(diagram.id)}" data-label="Mermaid diagram ${diagram.ordinal + 1}" data-line-start="${token.map?.[0] ?? 0}" data-line-end="${Math.max(token.map?.[0] ?? 0, (token.map?.[1] ?? 1) - 1)}" data-thread-ids="${escapeHtml(comments.map((item) => item.id).join(" "))}"><span>Rendering Mermaid…</span></div>`;
  };

  const defaultTableOpen = md.renderer.rules.table_open;
  md.renderer.rules.table_open = (items, index, options, env, self) => {
    const token = items[index];
    const tableId = String(token.meta?.tableId ?? "");
    const comments = threads.filter((thread) => thread.root.anchor.target?.kind === "table" && thread.root.anchor.target.tableId === tableId);
    const table = defaultTableOpen ? defaultTableOpen(items, index, options, env, self) : self.renderToken(items, index, options);
    return `<div class="table-wrap selectable-block${comments.length ? " commented" : ""}" data-target-kind="table" data-table-id="${escapeHtml(tableId)}" data-label="Table" data-line-start="${token.map?.[0] ?? 0}" data-line-end="${Math.max(token.map?.[0] ?? 0, (token.map?.[1] ?? 1) - 1)}" data-thread-ids="${escapeHtml(comments.map((item) => item.id).join(" "))}">${table}`;
  };
  const defaultTableClose = md.renderer.rules.table_close;
  md.renderer.rules.table_close = (items, index, options, env, self) => `${defaultTableClose ? defaultTableClose(items, index, options, env, self) : self.renderToken(items, index, options)}</div>`;
  return md.renderer.render(tokens, md.options, {});
}

async function renderActiveDocument(force = false): Promise<void> {
  if (!revision || !activeDocument) return;
  status(`Loading ${activeDocument}…`, "working");
  const loaded = await verifiedDocument(activeDocument);
  const host = $<HTMLElement>("#document-body");
  host.dataset.document = activeDocument;
  host.innerHTML = await markdownHtml(loaded.source, activeDocument);
  for (const image of host.querySelectorAll<HTMLImageElement>("img[data-frozen-resource]")) {
    const resourceId = image.dataset.frozenResource;
    if (resourceId) image.src = await resourceUrl(resourceId);
  }
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
  for (const element of host.querySelectorAll<HTMLElement>(".mermaid-block")) {
    const diagram = revision.mermaidDiagrams.find((item) => item.id === element.dataset.diagramId);
    if (!diagram) continue;
    try {
      const rendered = await mermaid.render(`omr_${diagram.id.replace(/[^A-Za-z0-9_]/g, "_")}`, diagram.source);
      element.innerHTML = rendered.svg;
    } catch (error) {
      element.textContent = `Mermaid could not be rendered: ${errorMessage(error)}`;
      element.classList.add("resource-error");
    }
  }
  selectedSemanticTarget = undefined;
  $("#selection-hint").textContent = "Select exact text, or click an image, diagram, or table, then choose Comment.";
  status("Live file sync · up to date");
}

function renderChrome(): void {
  if (!manifest || !revision) return;
  $("#review-title").textContent = manifest.title;
  $("#review-meta").textContent = `Revision ${revision.id} · immutable snapshot`;
  $("#document-list").innerHTML = revision.documents.map((item) => `<li><button data-document="${escapeHtml(item.path)}" class="${item.path === activeDocument ? "active" : ""}">${escapeHtml(item.path)}</button></li>`).join("");
  $("#document-list").querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.addEventListener("click", () => {
    activeDocument = button.dataset.document ?? activeDocument;
    $("#document-list").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    void renderActiveDocument(true).catch(reportError);
  }));
}

function renderState(): void {
  if (!revision) return;
  const currentThreads = [...state.threads.values()].filter((thread) => thread.revisionId === revision?.id);
  const unresolved = currentThreads.filter(isOpen);
  const approvals = state.approvals.filter((item) => item.revisionId === revision?.id);
  const rejections = state.rejections.filter((item) => item.revisionId === revision?.id);
  $("#stat-open").textContent = String(unresolved.length);
  $("#stat-approvals").textContent = String(approvals.length);
  $("#stat-rejections").textContent = String(rejections.length);
  $("#stat-images").textContent = String(revision.resources.filter((item) => item.role === "image").length);
  $("#stat-mermaid").textContent = String(revision.mermaidDiagrams.length);
  $("#thread-list").innerHTML = currentThreads.length ? currentThreads.map((thread) => {
    const statusLabel = thread.decisionConflicts.length ? "conflict" : thread.decision?.decision ?? (thread.resolved ? "resolved" : "open");
    const replies = thread.replies.map((reply) => `<li><strong>${escapeHtml(reply.actor.displayName ?? reply.actor.id)}</strong><span>${escapeHtml(reply.body.text)}</span></li>`).join("");
    return `<li class="thread ${isOpen(thread) ? "open" : "closed"}" data-thread-id="${escapeHtml(thread.id)}" data-document="${escapeHtml(thread.root.anchor.document)}"><div class="thread-head"><strong>${escapeHtml(thread.root.actor.displayName ?? thread.root.actor.id)}</strong><span>${escapeHtml(statusLabel)}</span></div><button class="thread-location" data-action="navigate">${escapeHtml(thread.root.anchor.document)}:${thread.root.anchor.range.start.line + 1} · “${escapeHtml(thread.root.anchor.quote.exact.replace(/\s+/g, " ").slice(0, 90))}”</button><p>${escapeHtml(thread.root.body.text)}</p>${replies ? `<ol>${replies}</ol>` : ""}<div class="thread-actions"><button data-action="reply">Reply</button>${isOpen(thread) ? '<button data-action="resolve">Resolve</button><button data-action="decide">Decide</button>' : ""}</div></li>`;
  }).join("") : '<li class="empty">No comments on this revision.</li>';
}

function actor(): ActorRef {
  const id = $("#actor-id") as HTMLInputElement;
  const name = $("#actor-name") as HTMLInputElement;
  if (!id.value.trim()) throw new Error("Enter your stable reviewer ID before writing a review event.");
  localStorage.setItem("omr.actorId", id.value.trim());
  localStorage.setItem("omr.actorName", name.value.trim());
  return { id: id.value.trim(), ...(name.value.trim() ? { displayName: name.value.trim() } : {}) };
}

function id(prefix: "evt" | "thread" | "comment"): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:.]/g, "")}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function writeEvent(event: ReviewEvent): Promise<void> {
  if (!manifest) throw new Error("Review is not loaded.");
  assertEvent(event);
  const directory = await directoryAt(manifest.eventDirectory, false);
  const filename = `${event.id}.json`;
  try {
    await directory.getFileHandle(filename);
    throw new Error(`Event collision: ${filename}`);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
  const bytes = `${JSON.stringify(event, null, 2)}\n`;
  const handle = await directory.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  const published = await handle.getFile().then((file) => file.text());
  if (published !== bytes) throw new Error(`The filesystem did not preserve the exact event bytes for ${filename}.`);
  eventFiles.set(filename, event);
  state = buildReviewState([...eventFiles.values()]);
  renderState();
  await renderActiveDocument(true);
  showToast("Review update saved as an independent event file.");
}

function pointAt(source: string, offset: number): { line: number; character: number } {
  const before = source.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1)?.length ?? 0 };
}

async function selectedAnchor(): Promise<MarkdownAnchor> {
  if (!revision) throw new Error("Revision is not loaded.");
  const document = await verifiedDocument(activeDocument);
  if (selectedSemanticTarget) {
    const startLine = Number(selectedSemanticTarget.dataset.lineStart ?? 0);
    const endLine = Number(selectedSemanticTarget.dataset.lineEnd ?? startLine);
    const label = selectedSemanticTarget.dataset.label ?? selectedSemanticTarget.textContent?.trim().slice(0, 500) ?? "Selected block";
    const kind = selectedSemanticTarget.dataset.targetKind;
    const target = kind === "image"
      ? { kind: "image" as const, resourceId: selectedSemanticTarget.dataset.resourceId!, label }
      : kind === "mermaid"
        ? { kind: "mermaid" as const, diagramId: selectedSemanticTarget.dataset.diagramId!, label }
        : { kind: "table" as const, tableId: selectedSemanticTarget.dataset.tableId!, label };
    return {
      document: activeDocument,
      range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 0 } },
      quote: { exact: label },
      documentDigest: document.digest,
      target,
    };
  }
  const exact = window.getSelection()?.toString().trim() ?? "";
  if (!exact) throw new Error("Select exact rendered text, or click an image, Mermaid diagram, or table first.");
  const first = document.source.indexOf(exact);
  if (first < 0) throw new Error("The rendered selection cannot be mapped exactly to the frozen Markdown. Select a smaller plain-text fragment.");
  const second = document.source.indexOf(exact, first + exact.length);
  if (second >= 0) throw new Error("That text occurs more than once. Select a longer, unique fragment.");
  return {
    document: activeDocument,
    range: { start: pointAt(document.source, first), end: pointAt(document.source, first + exact.length) },
    quote: { exact, prefix: document.source.slice(Math.max(0, first - 32), first), suffix: document.source.slice(first + exact.length, first + exact.length + 32) },
    documentDigest: document.digest,
    target: { kind: "text" },
  };
}

function askText(title: string, label: string, required = true): Promise<string | undefined> {
  const dialog = $("#text-dialog") as HTMLDialogElement;
  $("#dialog-title").textContent = title;
  $("#dialog-label").textContent = label;
  const input = $("#dialog-text") as HTMLTextAreaElement;
  input.value = "";
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    const finish = (value?: string) => {
      dialog.removeEventListener("close", closed);
      resolve(value);
    };
    const closed = () => {
      const value = dialog.returnValue === "submit" ? input.value.trim() : "";
      if (dialog.returnValue === "submit" && required && !value) {
        showToast(`${label} is required.`);
        window.setTimeout(() => void askText(title, label, required).then(resolve), 0);
        return;
      }
      finish(dialog.returnValue === "submit" ? value : undefined);
    };
    dialog.addEventListener("close", closed, { once: true });
  });
}

async function addComment(): Promise<void> {
  if (!manifest || !revision) return;
  const anchor = await selectedAnchor();
  const body = await askText("Add review comment", "Comment");
  if (!body) return;
  const threadId = id("thread");
  await writeEvent({ schemaVersion: "0.3.0", id: id("evt"), type: "comment.created", reviewId: manifest.reviewId, revisionId: revision.id, occurredAt: new Date().toISOString(), actor: actor(), threadId, commentId: id("comment"), anchor, body: { format: "markdown", text: body } });
}

function threadFor(element: Element): ReviewThread {
  const threadId = element.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId;
  const thread = threadId ? state.threads.get(threadId) : undefined;
  if (!thread) throw new Error("Review thread is no longer available.");
  return thread;
}

async function reply(thread: ReviewThread): Promise<void> {
  if (!manifest || !revision) return;
  const body = await askText("Reply to comment", "Reply");
  if (!body) return;
  await writeEvent({ schemaVersion: "0.3.0", id: id("evt"), type: "comment.replied", reviewId: manifest.reviewId, revisionId: revision.id, occurredAt: new Date().toISOString(), actor: actor(), threadId: thread.id, commentId: id("comment"), inReplyTo: thread.replies.at(-1)?.commentId ?? thread.root.commentId, body: { format: "markdown", text: body } });
}

async function resolveThread(thread: ReviewThread): Promise<void> {
  if (!manifest || !revision) return;
  const note = await askText("Resolve comment", "Optional resolution note", false);
  if (note === undefined) return;
  await writeEvent({ schemaVersion: "0.3.0", id: id("evt"), type: "thread.resolved", reviewId: manifest.reviewId, revisionId: revision.id, occurredAt: new Date().toISOString(), actor: actor(), threadId: thread.id, ...(note ? { note } : {}) });
}

async function decideThread(thread: ReviewThread): Promise<void> {
  if (!manifest || !revision) return;
  const decision = await askText("Decide comment", "Enter accepted, rejected, wont-fix, or duplicate");
  if (!decision) return;
  if (!(["accepted", "rejected", "wont-fix", "duplicate"] as const).includes(decision as "accepted")) throw new Error("Decision must be accepted, rejected, wont-fix, or duplicate.");
  const reason = await askText("Decision reason", "Optional reason", false);
  if (reason === undefined) return;
  await writeEvent({ schemaVersion: "0.3.0", id: id("evt"), type: "thread.decided", reviewId: manifest.reviewId, revisionId: revision.id, occurredAt: new Date().toISOString(), actor: actor(), threadId: thread.id, decision: decision as "accepted" | "rejected" | "wont-fix" | "duplicate", ...(reason ? { reason } : {}) });
}

async function approveReview(): Promise<void> {
  if (!manifest || !revision) return;
  const note = await askText("Approve this revision", "Optional approval note", false);
  if (note === undefined) return;
  await writeEvent({ schemaVersion: "0.3.0", id: id("evt"), type: "review.approved", reviewId: manifest.reviewId, revisionId: revision.id, occurredAt: new Date().toISOString(), actor: actor(), ...(note ? { note } : {}) });
}

async function rejectReview(): Promise<void> {
  if (!manifest || !revision) return;
  const reason = await askText("Reject this revision", "Reason");
  if (!reason) return;
  await writeEvent({ schemaVersion: "0.3.0", id: id("evt"), type: "review.rejected", reviewId: manifest.reviewId, revisionId: revision.id, occurredAt: new Date().toISOString(), actor: actor(), reason });
}

async function navigateThread(thread: ReviewThread): Promise<void> {
  if (activeDocument !== thread.root.anchor.document) {
    activeDocument = thread.root.anchor.document;
    renderChrome();
    await renderActiveDocument(true);
  }
  const target = $("#document-body").querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(thread.id)}"], [data-thread-ids~="${CSS.escape(thread.id)}"]`);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.classList.add("active-anchor");
  window.setTimeout(() => target?.classList.remove("active-anchor"), 2200);
}

function reportError(error: unknown): void {
  status(errorMessage(error), "warning");
  showToast(errorMessage(error));
  console.error(error);
}

$("#open-folder").addEventListener("click", () => void openReviewFolder().catch(reportError));
$("#comment").addEventListener("click", () => void addComment().catch(reportError));
$("#approve").addEventListener("click", () => void approveReview().catch(reportError));
$("#reject").addEventListener("click", () => void rejectReview().catch(reportError));
$("#refresh").addEventListener("click", () => void poll().catch(reportError));
$("#print").addEventListener("click", () => window.print());
$("#thread-list").addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  try {
    const thread = threadFor(button);
    if (button.dataset.action === "reply") void reply(thread).catch(reportError);
    if (button.dataset.action === "resolve") void resolveThread(thread).catch(reportError);
    if (button.dataset.action === "decide") void decideThread(thread).catch(reportError);
    if (button.dataset.action === "navigate") void navigateThread(thread).catch(reportError);
  } catch (error) {
    reportError(error);
  }
});
$("#document-body").addEventListener("click", (event) => {
  const attachment = (event.target as Element).closest<HTMLElement>("[data-attachment-id]");
  if (attachment?.dataset.attachmentId) {
    event.preventDefault();
    void resourceUrl(attachment.dataset.attachmentId).then((url) => window.open(url, "_blank", "noopener")).catch(reportError);
    return;
  }
  const comment = (event.target as Element).closest<HTMLElement>("[data-thread-id]");
  if (comment?.dataset.threadId) {
    document.querySelector<HTMLElement>(`.thread[data-thread-id="${CSS.escape(comment.dataset.threadId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const semantic = (event.target as Element).closest<HTMLElement>(".selectable-block");
  $("#document-body").querySelectorAll(".selected-target").forEach((item) => item.classList.remove("selected-target"));
  selectedSemanticTarget = semantic ?? undefined;
  if (semantic) {
    semantic.classList.add("selected-target");
    $("#selection-hint").textContent = `${semantic.dataset.label ?? "Block"} selected for comment.`;
  }
});

const actorId = $("#actor-id") as HTMLInputElement;
const actorName = $("#actor-name") as HTMLInputElement;
actorId.value = localStorage.getItem("omr.actorId") ?? "";
actorName.value = localStorage.getItem("omr.actorName") ?? "";
if (!window.showDirectoryPicker) {
  ($("#open-folder") as HTMLButtonElement).disabled = true;
  status("Direct folder access is unavailable in this browser", "warning");
  $("#compatibility").textContent = "Open this file in current Microsoft Edge or Google Chrome. Firefox and Safari do not currently provide the required read/write folder API.";
}

document.documentElement.dataset.clientReady = "true";
document.documentElement.dataset.folderAccess = window.showDirectoryPicker ? "available" : "unavailable";
void restoreRememberedReview().catch(reportError);
