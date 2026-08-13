import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import * as vscode from "vscode";
import { resourceIdFor, tableIdFor } from "./protocol/snapshot";
import { resolveInsideReview } from "./protocol/store";
import {
  ReviewManifest,
  ReviewRevision,
  ReviewSuggestion,
  ReviewState,
  ReviewThread,
} from "./protocol/types";

export interface RenderedCommentRequest {
  document: string;
  kind: "text" | "image" | "mermaid" | "table" | "table-cell";
  quote?: string;
  lineStart?: number;
  lineEnd?: number;
  label?: string;
  resourceId?: string;
  diagramId?: string;
  tableId?: string;
  row?: number;
  column?: number;
}

export interface RenderData {
  diagrams: Record<string, string>;
  diagramErrors: Record<string, string>;
}

export interface RenderedViewHandlers {
  addComment(request: RenderedCommentRequest): Promise<void>;
  addSuggestion(request: RenderedCommentRequest): Promise<void>;
  replyThread(threadId: string): Promise<void>;
  decideThread(threadId: string): Promise<void>;
  decideSuggestion(suggestionId: string, decision: "accepted" | "rejected"): Promise<void>;
  applySuggestion(suggestionId: string): Promise<void>;
  approve(): Promise<void>;
  reject(): Promise<void>;
  exportPdf(): Promise<void>;
  openThread(threadId: string): Promise<void>;
  openAttachment(resourceId: string): Promise<void>;
  refresh(): Promise<void>;
}

interface DocumentHtml {
  path: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function lineAttributes(token: Token): string {
  const start = token.map?.[0] ?? 0;
  const end = Math.max(start, (token.map?.[1] ?? start + 1) - 1);
  return `data-line-start="${start}" data-line-end="${end}"`;
}

function isOpenThread(thread: ReviewThread): boolean {
  return !thread.resolved && !thread.decision && !thread.decisionConflicts.length;
}

function commentAttributes(threads: readonly ReviewThread[]): string {
  if (!threads.length) return "";
  const ids = threads.map((thread) => thread.id).join(" ");
  const state = threads.some(isOpenThread) ? "open" : "resolved";
  return ` comment-anchored comment-${state}" data-thread-ids="${escapeHtml(ids)}`;
}

function markTokenWithComments(token: Token, threads: readonly ReviewThread[]): void {
  if (!threads.length) return;
  token.attrJoin("class", `comment-anchored ${threads.some(isOpenThread) ? "comment-open" : "comment-resolved"}`);
  token.attrSet("data-thread-ids", threads.map((thread) => thread.id).join(" "));
  token.attrSet("tabindex", "0");
  token.attrSet("role", "button");
  token.attrSet("aria-label", `${threads.length} review comment${threads.length === 1 ? "" : "s"}`);
}

export function renderDocument(
  source: string,
  documentPath: string,
  revision: ReviewRevision,
  state: ReviewState,
  webview: vscode.Webview,
  reviewRoot: string,
): string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  md.validateLink = (url) => /^(?:https?:|mailto:|#|\.\.?\/)/i.test(url);
  const tokens = md.parse(source, {});
  const resources = new Map(revision.resources.map((resource) => [resource.id, resource]));
  const suggestions = [...state.suggestions.values()].filter(
    (suggestion) => suggestion.revisionId === revision.id && suggestion.created.anchor.document === documentPath && suggestion.status !== "applied",
  );
  const documentThreads = [...state.threads.values()].filter(
    (thread) => thread.revisionId === revision.id && thread.root.anchor.document === documentPath,
  );
  const textThreads = documentThreads.filter((thread) => !thread.root.anchor.target || thread.root.anchor.target.kind === "text");
  let tableOrdinal = 0;
  let currentTableId = "";
  let row = -1;
  let column = 0;
  let mermaidOrdinal = 0;

  for (const token of tokens) {
    if (["paragraph_open", "heading_open", "blockquote_open", "list_item_open"].includes(token.type) && token.map) {
      token.attrJoin("class", "review-text-block");
      token.attrSet("data-document", documentPath);
      token.attrSet("data-line-start", String(token.map[0]));
      token.attrSet("data-line-end", String(Math.max(token.map[0], token.map[1] - 1)));
      const blockThreads = textThreads.filter((thread) => {
        const start = thread.root.anchor.range.start.line;
        const end = thread.root.anchor.range.end.line;
        return start <= token.map![1] - 1 && end >= token.map![0];
      });
      if (blockThreads.length) {
        token.attrJoin("class", "comment-anchor-block");
        token.attrSet("data-thread-ids", blockThreads.map((thread) => thread.id).join(" "));
      }
    }
    if (token.type === "table_open") {
      currentTableId = tableIdFor(documentPath, tableOrdinal++);
      token.meta = { ...(token.meta ?? {}), tableId: currentTableId };
      row = -1;
    } else if (token.type === "tr_open") {
      row += 1;
      column = 0;
    } else if ((token.type === "th_open" || token.type === "td_open") && currentTableId) {
      token.attrSet("class", "selectable-cell");
      token.attrSet("data-target-kind", "table-cell");
      token.attrSet("data-document", documentPath);
      token.attrSet("data-table-id", currentTableId);
      const cellColumn = column++;
      token.attrSet("data-row", String(row));
      token.attrSet("data-column", String(cellColumn));
      token.attrSet("data-line-start", String(token.map?.[0] ?? 0));
      markTokenWithComments(token, documentThreads.filter((thread) => {
        const target = thread.root.anchor.target;
        return target?.kind === "table-cell" && target.tableId === currentTableId && target.row === row && target.column === cellColumn;
      }));
    } else if (token.type === "inline" && token.children) {
      for (const child of token.children) {
        child.meta = { ...(child.meta ?? {}), map: token.map };
      }
    } else if (token.type === "fence" && token.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
      token.meta = {
        ...(token.meta ?? {}),
        diagram: revision.mermaidDiagrams.find(
          (diagram) => diagram.document === documentPath && diagram.ordinal === mermaidOrdinal++,
        ),
      };
    }
  }

  const defaultText = md.renderer.rules.text;
  md.renderer.rules.text = (textTokens, index, options, env, self) => {
    const token = textTokens[index];
    let output = defaultText ? defaultText(textTokens, index, options, env, self) : escapeHtml(token.content);
    for (const suggestion of suggestions) {
      const exact = suggestion.created.anchor.quote.exact;
      const escaped = escapeHtml(exact);
      if (!escaped || !output.includes(escaped)) continue;
      const operation = suggestion.created.operation;
      const replacement = operation.kind === "delete" ? "" : escapeHtml(operation.replacement);
      const insert = operation.kind === "insert"
        ? operation.position === "before" ? `<ins>${replacement}</ins>${escaped}` : `${escaped}<ins>${replacement}</ins>`
        : `<del>${escaped}</del>${replacement ? `<ins>${replacement}</ins>` : ""}`;
      output = output.replace(escaped, `<span class="suggested-change ${escapeHtml(suggestion.status)}" data-suggestion-id="${escapeHtml(suggestion.id)}">${insert}</span>`);
    }
    const map = token.meta?.map as [number, number] | null | undefined;
    const matching = textThreads.filter((thread) => {
      const exact = thread.root.anchor.quote.exact;
      if (!exact || !token.content.includes(exact)) return false;
      if (!map) return true;
      const start = thread.root.anchor.range.start.line;
      const end = thread.root.anchor.range.end.line;
      return start <= map[1] - 1 && end >= map[0];
    });
    const byQuote = new Map<string, ReviewThread[]>();
    for (const thread of matching) {
      const exact = thread.root.anchor.quote.exact;
      byQuote.set(exact, [...(byQuote.get(exact) ?? []), thread]);
    }
    for (const [exact, threads] of [...byQuote].sort((left, right) => right[0].length - left[0].length)) {
      const escaped = escapeHtml(exact);
      if (!output.includes(escaped)) continue;
      const ids = threads.map((thread) => thread.id).join(" ");
      const status = threads.some(isOpenThread) ? "open" : "resolved";
      const count = threads.length > 1 ? `<span class="comment-count">${threads.length}</span>` : `<span class="comment-glyph" aria-hidden="true">●</span>`;
      output = output.replace(escaped, `<span class="comment-highlight comment-${status}" data-thread-ids="${escapeHtml(ids)}" tabindex="0" role="button" aria-label="Open ${threads.length} review comment${threads.length === 1 ? "" : "s"}">${escaped}${count}</span>`);
    }
    return output;
  };

  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (imageTokens, index, options, env, self) => {
    const token = imageTokens[index];
    const reference = token.attrGet("src") ?? "";
    const resource = resources.get(resourceIdFor(documentPath, reference));
    if (!resource) {
      return `<div class="mermaid-error">Image was not captured: ${escapeHtml(reference)}</div>`;
    }
    const uri = webview.asWebviewUri(vscode.Uri.file(resolveInsideReview(reviewRoot, resource.blobPath)));
    const alt = token.content || resource.alt || "Image";
    const map = (token.meta?.map as [number, number] | null | undefined) ?? [0, 1];
    const comments = documentThreads.filter((thread) => thread.root.anchor.target?.kind === "image" && thread.root.anchor.target.resourceId === resource.id);
    return `<figure class="review-image selectable-block${commentAttributes(comments)}" data-target-kind="image" data-document="${escapeHtml(documentPath)}" data-resource-id="${escapeHtml(resource.id)}" data-label="${escapeHtml(alt)}" data-quote="${escapeHtml(alt)}" data-line-start="${map[0]}" data-line-end="${Math.max(map[0], map[1] - 1)}"><img src="${uri}" alt="${escapeHtml(alt)}"><figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  };
  if (!defaultImage) void defaultImage;

  const defaultLinkOpen = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (linkTokens, index, options, env, self) => {
    const token = linkTokens[index];
    const reference = token.attrGet("href") ?? "";
    if (token.attrGet("title")?.trim().toLowerCase() === "review:attach") {
      const resource = resources.get(resourceIdFor(documentPath, reference));
      if (resource) {
        token.attrSet("href", "#");
        token.attrSet("title", `Frozen attachment · ${resource.digest}`);
        token.attrSet("data-resource-id", resource.id);
        token.attrSet("class", "frozen-attachment");
      }
    } else if (/^https?:\/\//i.test(reference)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noreferrer noopener");
    }
    return defaultLinkOpen
      ? defaultLinkOpen(linkTokens, index, options, env, self)
      : self.renderToken(linkTokens, index, options);
  };

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (fenceTokens, index, options, env, self) => {
    const token = fenceTokens[index];
    if (token.info.trim().split(/\s+/)[0]?.toLowerCase() !== "mermaid") {
      return defaultFence ? defaultFence(fenceTokens, index, options, env, self) : self.renderToken(fenceTokens, index, options);
    }
    const diagram = token.meta?.diagram as ReviewRevision["mermaidDiagrams"][number] | undefined;
    if (!diagram) return `<pre class="mermaid-error">Mermaid descriptor is missing.</pre>`;
    const encodedSource = Buffer.from(diagram.source, "utf8").toString("base64");
    const comments = documentThreads.filter((thread) => thread.root.anchor.target?.kind === "mermaid" && thread.root.anchor.target.diagramId === diagram.id);
    return `<div class="mermaid-block selectable-block${commentAttributes(comments)}" data-target-kind="mermaid" data-document="${escapeHtml(documentPath)}" data-diagram-id="${escapeHtml(diagram.id)}" data-label="Mermaid diagram ${diagram.ordinal + 1}" data-quote="${escapeHtml(diagram.source.slice(0, 500))}" data-source-b64="${encodedSource}" ${lineAttributes(token)}><span class="badge">Rendering Mermaid…</span></div>`;
  };

  const defaultTableOpen = md.renderer.rules.table_open;
  md.renderer.rules.table_open = (tableTokens, index, options, env, self) => {
    const token = tableTokens[index];
    const tableId = String(token.meta?.tableId ?? tableIdFor(documentPath, 0));
    const rendered = defaultTableOpen
      ? defaultTableOpen(tableTokens, index, options, env, self)
      : self.renderToken(tableTokens, index, options);
    const comments = documentThreads.filter((thread) => thread.root.anchor.target?.kind === "table" && thread.root.anchor.target.tableId === tableId);
    return `<div class="table-wrap selectable-block${commentAttributes(comments)}" data-target-kind="table" data-document="${escapeHtml(documentPath)}" data-table-id="${escapeHtml(tableId)}" data-label="Table" data-quote="Table" ${lineAttributes(token)}>${rendered}`;
  };
  const defaultTableClose = md.renderer.rules.table_close;
  md.renderer.rules.table_close = (tableTokens, index, options, env, self) => {
    const rendered = defaultTableClose
      ? defaultTableClose(tableTokens, index, options, env, self)
      : self.renderToken(tableTokens, index, options);
    return `${rendered}</div>`;
  };

  return md.renderer.render(tokens, md.options, {});
}

async function buildDocuments(
  revision: ReviewRevision,
  state: ReviewState,
  webview: vscode.Webview,
  reviewRoot: string,
): Promise<DocumentHtml[]> {
  return Promise.all(
    revision.documents.map(async (document) => {
      const source = await readFile(resolveInsideReview(reviewRoot, document.blobPath), "utf8");
      return { path: document.path, html: renderDocument(source, document.path, revision, state, webview, reviewRoot) };
    }),
  );
}

export function threadHtml(thread: ReviewThread): string {
  const author = thread.root.actor.displayName ?? thread.root.actor.id;
  const status = thread.decisionConflicts.length ? "conflict" : thread.decision?.decision ?? (thread.resolved ? "resolved" : "open");
  const location = `${thread.root.anchor.document}:${thread.root.anchor.range.start.line + 1}`;
  const replies = thread.replies.length
    ? `<ol class="reply-list">${thread.replies.map((reply) => `<li><strong>${escapeHtml(reply.actor.displayName ?? reply.actor.id)}</strong><span>${escapeHtml(reply.body.text)}</span></li>`).join("")}</ol>`
    : "";
  return `<li id="thread-${escapeHtml(thread.id)}" class="thread${thread.resolved || thread.decision ? " resolved" : ""}" data-thread-id="${escapeHtml(thread.id)}" data-document="${escapeHtml(thread.root.anchor.document)}" tabindex="0"><div class="thread-head"><span>${escapeHtml(author)}</span><span class="badge${status === "accepted" || status === "resolved" ? " ok" : ""}">${escapeHtml(status)}</span></div><button class="thread-location" data-command="navigateThread" data-thread-id="${escapeHtml(thread.id)}" title="Show highlighted content">${escapeHtml(location)} · “${escapeHtml(thread.root.anchor.quote.exact.replace(/\s+/g, " ").slice(0, 72))}”</button><p>${escapeHtml(thread.root.body.text)}</p>${replies}<div class="inline-actions"><button data-command="replyThread" data-thread-id="${escapeHtml(thread.id)}">Reply</button><button data-command="decideThread" data-thread-id="${escapeHtml(thread.id)}">Decide</button><button data-command="openThread" data-thread-id="${escapeHtml(thread.id)}">Open source</button></div></li>`;
}

function suggestionHtml(suggestion: ReviewSuggestion): string {
  const operation = suggestion.created.operation;
  const oldText = suggestion.created.anchor.quote.exact;
  const replacement = operation.kind === "delete" ? "" : operation.replacement;
  const preview = operation.kind === "insert"
    ? operation.position === "before" ? `<ins>${escapeHtml(replacement)}</ins> ${escapeHtml(oldText)}` : `${escapeHtml(oldText)} <ins>${escapeHtml(replacement)}</ins>`
    : `<del>${escapeHtml(oldText)}</del>${replacement ? ` <ins>${escapeHtml(replacement)}</ins>` : ""}`;
  const actions = suggestion.status === "open" || suggestion.status === "conflicted"
    ? `<button data-command="acceptSuggestion" data-suggestion-id="${escapeHtml(suggestion.id)}">Accept</button><button data-command="rejectSuggestion" data-suggestion-id="${escapeHtml(suggestion.id)}">Reject</button>`
    : suggestion.status === "accepted"
      ? `<button data-command="applySuggestion" data-suggestion-id="${escapeHtml(suggestion.id)}">Apply to source</button>`
      : "";
  return `<li class="suggestion"><div class="thread-head"><span>${escapeHtml(suggestion.created.anchor.document)}:${suggestion.created.anchor.range.start.line + 1}</span><span class="badge ${suggestion.status === "accepted" || suggestion.status === "applied" ? "ok" : ""}">${escapeHtml(suggestion.status)}</span></div><div class="change-preview">${preview}</div><p>${escapeHtml(suggestion.created.rationale.text)}</p><div class="inline-actions">${actions}</div></li>`;
}

async function buildHtml(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  reviewRoot: string,
  manifest: ReviewManifest,
  revision: ReviewRevision,
  state: ReviewState,
): Promise<string> {
  const documents = await buildDocuments(revision, state, panel.webview, reviewRoot);
  const nonce = randomBytes(18).toString("base64");
  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "review.js"));
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "review.css"));
  const revisionThreads = [...state.threads.values()].filter((thread) => thread.revisionId === revision.id);
  const unresolved = state.unresolvedThreads.filter((thread) => thread.revisionId === revision.id).length;
  const approvals = state.approvals.filter((approval) => approval.revisionId === revision.id).length;
  const rejections = state.rejections.filter((rejection) => rejection.revisionId === revision.id).length;
  const revisionSuggestions = [...state.suggestions.values()].filter((suggestion) => suggestion.revisionId === revision.id);
  const documentButtons = documents
    .map((document) => `<li><button class="document-button" data-document="${escapeHtml(document.path)}">${escapeHtml(document.path)}</button></li>`)
    .join("");
  const documentBodies = documents
    .map((document) => `<article class="document" data-document="${escapeHtml(document.path)}"><div class="document-path">Frozen document · ${escapeHtml(document.path)}</div><div class="markdown-body">${document.html}</div></article>`)
    .join("");
  const threads = revisionThreads.length ? revisionThreads.map(threadHtml).join("") : `<li class="empty">No comments on this revision.</li>`;
  const suggestions = revisionSuggestions.length ? revisionSuggestions.map(suggestionHtml).join("") : `<li class="empty">No suggested edits on this revision.</li>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${styleUri}"><title>${escapeHtml(manifest.title)}</title></head>
<body><div class="app"><header class="topbar"><div class="brand"><strong>${escapeHtml(manifest.title)}</strong><span>Revision ${escapeHtml(revision.id)} · immutable snapshot</span></div><div class="actions"><button class="button" data-command="refresh">Refresh</button><button class="button" data-command="addComment">Comment</button><button class="button" data-command="addSuggestion">Suggest edit</button><button class="button" data-command="approve">Approve</button><button class="button" data-command="reject">Reject</button><button class="button primary" data-command="export">Export audit PDF</button></div></header>
<div class="layout"><nav class="sidebar left"><section class="sidebar-section"><h2 class="sidebar-title">Documents</h2><ul class="document-list">${documentButtons}</ul></section><section class="sidebar-section"><h2 class="sidebar-title">Revision status</h2><div class="status"><span>Open threads</span><strong>${unresolved}</strong><span>Open suggestions</span><strong>${state.openSuggestions.filter((item) => item.revisionId === revision.id).length}</strong><span>Approvals</span><strong>${approvals}</strong><span>Rejections</span><strong>${rejections}</strong><span>Images</span><strong>${revision.resources.filter((item) => item.role === "image").length}</strong><span>Attachments</span><strong>${revision.resources.filter((item) => item.role === "attachment").length}</strong><span>Mermaid</span><strong>${revision.mermaidDiagrams.length}</strong><span>External links</span><strong>${revision.externalReferences.length}</strong></div></section><section class="sidebar-section"><div id="selection-hint" class="selection-hint">Select text to comment or suggest an edit.</div></section></nav>
<main class="content">${documentBodies}</main><aside class="sidebar right"><section class="sidebar-section"><h2 class="sidebar-title">Review threads</h2><ul class="thread-list">${threads}</ul></section><section class="sidebar-section"><h2 class="sidebar-title">Suggested edits</h2><ul class="thread-list">${suggestions}</ul></section></aside></div></div><div id="toast" class="toast"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

export class RenderedReviewPanel implements vscode.Disposable {
  private static current: RenderedReviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private renderData?: RenderData;
  private renderWaiters: Array<(data: RenderData) => void> = [];
  private disposed = false;
  private pendingThreadId?: string;

  get isDisposed(): boolean {
    return this.disposed;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly reviewRoot: string,
    private manifest: ReviewManifest,
    private revision: ReviewRevision,
    private state: ReviewState,
    private readonly handlers: RenderedViewHandlers,
  ) {
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message) => void this.receive(message)),
    );
  }

  static async show(
    context: vscode.ExtensionContext,
    reviewRoot: string,
    manifest: ReviewManifest,
    revision: ReviewRevision,
    state: ReviewState,
    handlers: RenderedViewHandlers,
  ): Promise<RenderedReviewPanel> {
    if (this.current && this.current.reviewRoot !== reviewRoot) {
      this.current.panel.dispose();
      this.current = undefined;
    }
    if (this.current) {
      this.current.panel.reveal(vscode.ViewColumn.Beside);
      await this.current.update(manifest, revision, state);
      return this.current;
    }
    const panel = vscode.window.createWebviewPanel("openMarkdownReview.rendered", "Rendered Markdown Review", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "media"),
        vscode.Uri.file(reviewRoot),
      ],
    });
    this.current = new RenderedReviewPanel(context, panel, reviewRoot, manifest, revision, state, handlers);
    await this.current.update(manifest, revision, state);
    return this.current;
  }

  async update(manifest: ReviewManifest, revision: ReviewRevision, state: ReviewState): Promise<void> {
    if (this.disposed) return;
    this.manifest = manifest;
    this.revision = revision;
    this.state = state;
    this.renderData = undefined;
    this.panel.title = `${manifest.title} · Review`;
    this.panel.webview.html = await buildHtml(this.context, this.panel, this.reviewRoot, manifest, revision, state);
  }

  async collectRenderData(timeoutMs = 20_000): Promise<RenderData> {
    if (this.renderData) return this.renderData;
    await this.panel.webview.postMessage({ command: "collectRenderData" });
    return new Promise<RenderData>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for Mermaid rendering.")), timeoutMs);
      this.renderWaiters.push((data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
  }

  async revealThread(threadId: string): Promise<void> {
    if (this.disposed) return;
    this.pendingThreadId = threadId;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    await this.panel.webview.postMessage({ command: "revealThread", threadId });
  }

  private async receive(message: Record<string, unknown>): Promise<void> {
    switch (message.command) {
      case "renderReady":
      case "renderData": {
        const data: RenderData = {
          diagrams: (message.diagrams as Record<string, string>) ?? {},
          diagramErrors: (message.diagramErrors as Record<string, string>) ?? {},
        };
        this.renderData = data;
        for (const waiter of this.renderWaiters.splice(0)) waiter(data);
        if (message.command === "renderReady" && this.pendingThreadId) {
          const threadId = this.pendingThreadId;
          this.pendingThreadId = undefined;
          await this.panel.webview.postMessage({ command: "revealThread", threadId });
        }
        break;
      }
      case "addComment":
        await this.handlers.addComment(message as unknown as RenderedCommentRequest);
        break;
      case "addSuggestion":
        await this.handlers.addSuggestion(message as unknown as RenderedCommentRequest);
        break;
      case "replyThread":
        if (typeof message.threadId === "string") await this.handlers.replyThread(message.threadId);
        break;
      case "decideThread":
        if (typeof message.threadId === "string") await this.handlers.decideThread(message.threadId);
        break;
      case "acceptSuggestion":
      case "rejectSuggestion":
        if (typeof message.suggestionId === "string") await this.handlers.decideSuggestion(message.suggestionId, message.command === "acceptSuggestion" ? "accepted" : "rejected");
        break;
      case "applySuggestion":
        if (typeof message.suggestionId === "string") await this.handlers.applySuggestion(message.suggestionId);
        break;
      case "approve":
        await this.handlers.approve();
        break;
      case "reject":
        await this.handlers.reject();
        break;
      case "exportPdf":
        await this.handlers.exportPdf();
        break;
      case "openThread":
        if (typeof message.threadId === "string") await this.handlers.openThread(message.threadId);
        break;
      case "openAttachment":
        if (typeof message.resourceId === "string") await this.handlers.openAttachment(message.resourceId);
        break;
      case "refresh":
        await this.handlers.refresh();
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (RenderedReviewPanel.current === this) RenderedReviewPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
