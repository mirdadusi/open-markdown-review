import mermaid from "mermaid";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(value: unknown): void; getState(): unknown };

const vscode = acquireVsCodeApi();
const renderedDiagrams: Record<string, string> = {};
const diagramErrors: Record<string, string> = {};
let selectedTarget: HTMLElement | undefined;

function post(command: string, data: Record<string, unknown> = {}): void {
  vscode.postMessage({ command, ...data });
}

function showToast(message: string): void {
  const toast = document.querySelector<HTMLElement>("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2200);
}

function activateDocument(path: string): void {
  document.querySelectorAll(".document").forEach((item) => item.classList.toggle("active", item.getAttribute("data-document") === path));
  document.querySelectorAll(".document-button").forEach((item) => item.classList.toggle("active", item.getAttribute("data-document") === path));
  vscode.setState({ document: path });
}

function threadIds(element: HTMLElement): string[] {
  return (element.dataset.threadIds ?? element.dataset.threadId ?? "").split(/\s+/).filter(Boolean);
}

function focusComment(threadId: string): void {
  document.querySelectorAll(".thread.active").forEach((item) => item.classList.remove("active"));
  const thread = document.getElementById(`thread-${threadId}`);
  if (!thread) return;
  thread.classList.add("active");
  thread.scrollIntoView({ behavior: "smooth", block: "center" });
  thread.focus({ preventScroll: true });
}

function revealCommentedContent(threadId: string): void {
  const thread = document.getElementById(`thread-${threadId}`) as HTMLElement | null;
  const documentPath = thread?.dataset.document;
  if (documentPath) activateDocument(documentPath);
  const selector = `[data-thread-ids~="${CSS.escape(threadId)}"]`;
  const anchors = [...document.querySelectorAll<HTMLElement>(selector)].filter((item) => !item.classList.contains("thread"));
  const anchor = anchors.find((item) => item.classList.contains("comment-highlight") || item.matches(".comment-anchored")) ?? anchors[0];
  if (!anchor) {
    showToast("The exact rendered anchor is unavailable; open the source location instead.");
    return;
  }
  document.querySelectorAll(".comment-anchor-active").forEach((item) => item.classList.remove("comment-anchor-active"));
  anchor.classList.add("comment-anchor-active");
  anchor.scrollIntoView({ behavior: "smooth", block: "center" });
  anchor.focus({ preventScroll: true });
  window.setTimeout(() => anchor.classList.remove("comment-anchor-active"), 2400);
}

async function renderMermaid(): Promise<void> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: document.body.classList.contains("vscode-dark") ? "dark" : "default",
    fontFamily: getComputedStyle(document.body).fontFamily,
  });
  for (const element of document.querySelectorAll<HTMLElement>(".mermaid-block")) {
    const id = element.dataset.diagramId;
    const encodedSource = element.dataset.sourceB64;
    if (!id || encodedSource === undefined) continue;
    const source = new TextDecoder().decode(Uint8Array.from(atob(encodedSource), (character) => character.charCodeAt(0)));
    try {
      const rendered = await mermaid.render(`svg_${id.replace(/[^A-Za-z0-9_]/g, "_")}`, source);
      renderedDiagrams[id] = rendered.svg;
      element.innerHTML = rendered.svg;
      element.dataset.rendered = "true";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagramErrors[id] = message;
      element.innerHTML = "";
      const failure = document.createElement("pre");
      failure.className = "mermaid-error";
      failure.textContent = `Mermaid rendering failed\n${message}`;
      element.append(failure);
    }
  }
  post("renderReady", { diagrams: renderedDiagrams, diagramErrors });
}

function targetPayload(target: HTMLElement): Record<string, unknown> {
  const kind = target.dataset.targetKind ?? "text";
  const payload: Record<string, unknown> = {
    document: target.dataset.document,
    kind,
    lineStart: Number(target.dataset.lineStart ?? 0),
    lineEnd: Number(target.dataset.lineEnd ?? target.dataset.lineStart ?? 0),
    label: target.dataset.label,
  };
  if (kind === "image") payload.resourceId = target.dataset.resourceId;
  if (kind === "mermaid") payload.diagramId = target.dataset.diagramId;
  if (kind === "table" || kind === "table-cell") payload.tableId = target.dataset.tableId;
  if (kind === "table-cell") {
    payload.row = Number(target.dataset.row ?? 0);
    payload.column = Number(target.dataset.column ?? 0);
  }
  return payload;
}

function textSelectionPayload(): Record<string, unknown> | undefined {
  const selection = window.getSelection();
  const quote = selection?.toString().trim() ?? "";
  if (!quote) return undefined;
  const element = selection?.anchorNode instanceof HTMLElement
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement;
  const activeDocument = element?.closest<HTMLElement>(".document") ?? document.querySelector<HTMLElement>(".document.active");
  const block = element?.closest<HTMLElement>("[data-line-start]");
  return {
    document: activeDocument?.dataset.document,
    kind: "text",
    quote,
    lineStart: Number(block?.dataset.lineStart ?? 0),
    lineEnd: Number(block?.dataset.lineEnd ?? block?.dataset.lineStart ?? 0),
  };
}

document.addEventListener("click", (event) => {
  const element = event.target as HTMLElement;
  const commentAnchor = element.closest<HTMLElement>(".comment-highlight, .comment-anchored, .comment-anchor-block");
  if (commentAnchor && !element.closest("[data-command]")) {
    const [threadId] = threadIds(commentAnchor);
    if (threadId) focusComment(threadId);
    return;
  }
  const attachment = element.closest<HTMLElement>(".frozen-attachment");
  if (attachment?.dataset.resourceId) {
    event.preventDefault();
    post("openAttachment", { resourceId: attachment.dataset.resourceId });
    return;
  }
  const documentButton = element.closest<HTMLElement>(".document-button");
  if (documentButton?.dataset.document) {
    activateDocument(documentButton.dataset.document);
    return;
  }
  const action = element.closest<HTMLElement>("[data-command]")?.dataset.command;
  if (action === "addComment") {
    const selection = textSelectionPayload();
    if (selection) post("addComment", selection);
    else if (selectedTarget) post("addComment", { ...targetPayload(selectedTarget), quote: selectedTarget.dataset.quote ?? selectedTarget.dataset.label ?? selectedTarget.textContent?.trim().slice(0, 500) });
    else showToast("Select text, a diagram, image, table, or cell first.");
    return;
  }
  if (action === "addSuggestion") {
    const selection = textSelectionPayload();
    if (selection) post("addSuggestion", selection);
    else showToast("Select an exact text string first.");
    return;
  }
  const actionElement = element.closest<HTMLElement>("[data-command]");
  if (action === "replyThread" && actionElement?.dataset.threadId) {
    post("replyThread", { threadId: actionElement.dataset.threadId });
    return;
  }
  if (action === "decideThread" && actionElement?.dataset.threadId) {
    post("decideThread", { threadId: actionElement.dataset.threadId });
    return;
  }
  if (action === "navigateThread" && actionElement?.dataset.threadId) {
    revealCommentedContent(actionElement.dataset.threadId);
    return;
  }
  if (action === "openThread" && actionElement?.dataset.threadId) {
    post("openThread", { threadId: actionElement.dataset.threadId });
    return;
  }
  if (action === "acceptSuggestion" && actionElement?.dataset.suggestionId) {
    post("acceptSuggestion", { suggestionId: actionElement.dataset.suggestionId });
    return;
  }
  if (action === "rejectSuggestion" && actionElement?.dataset.suggestionId) {
    post("rejectSuggestion", { suggestionId: actionElement.dataset.suggestionId });
    return;
  }
  if (action === "applySuggestion" && actionElement?.dataset.suggestionId) {
    post("applySuggestion", { suggestionId: actionElement.dataset.suggestionId });
    return;
  }
  if (action === "approve") post("approve");
  if (action === "reject") post("reject");
  if (action === "export") post("exportPdf");
  if (action === "refresh") post("refresh");

  const block = element.closest<HTMLElement>(".selectable-block, td, th");
  if (block) {
    selectedTarget?.classList.remove("selected");
    selectedTarget = block;
    selectedTarget.classList.add("selected");
    const hint = document.querySelector<HTMLElement>("#selection-hint");
    if (hint) hint.textContent = `${block.dataset.targetKind ?? "block"} selected - Add comment to review it`;
  }

  const thread = element.closest<HTMLElement>(".thread");
  if (thread?.dataset.threadId) revealCommentedContent(thread.dataset.threadId);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const element = event.target as HTMLElement;
  const commentAnchor = element.closest<HTMLElement>(".comment-highlight, .comment-anchored");
  if (commentAnchor) {
    event.preventDefault();
    const [threadId] = threadIds(commentAnchor);
    if (threadId) focusComment(threadId);
    return;
  }
  const thread = element.closest<HTMLElement>(".thread");
  if (thread?.dataset.threadId) {
    event.preventDefault();
    revealCommentedContent(thread.dataset.threadId);
  }
});

window.addEventListener("message", (event) => {
  const message = event.data as { command?: string; threadId?: string };
  if (message.command === "collectRenderData") post("renderData", { diagrams: renderedDiagrams, diagramErrors });
  if (message.command === "refresh") post("refresh");
  if (message.command === "revealThread" && message.threadId) {
    revealCommentedContent(message.threadId);
    focusComment(message.threadId);
  }
});

const saved = vscode.getState() as { document?: string } | undefined;
const firstDocument = saved?.document ?? document.querySelector<HTMLElement>(".document-button")?.dataset.document;
if (firstDocument) activateDocument(firstDocument);
void renderMermaid();
