import { readFile } from "node:fs/promises";
import path from "node:path";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import SVGtoPDF from "svg-to-pdfkit";
import { createId } from "./protocol/ids";
import { MERMAID_RENDERER_VERSION, resourceIdFor } from "./protocol/snapshot";
import {
  appendEvent,
  resolveInsideReview,
  sha256,
  writeArtifactExclusive,
  writeBlob,
} from "./protocol/store";
import {
  ActorRef,
  EVENT_SCHEMA_VERSION,
  ExportCreatedEvent,
  ReviewEvent,
  ReviewManifest,
  ReviewRevision,
  ReviewState,
  Sha256Digest,
  StoredContent,
} from "./protocol/types";
import type { RenderData } from "./renderedView";

export interface PdfExportInput {
  reviewRoot: string;
  manifest: ReviewManifest;
  revision: ReviewRevision;
  state: ReviewState;
  events: ReviewEvent[];
  renderData: RenderData;
  actor: ActorRef;
  clientVersion: string;
  /** Locally verified content-addressed copies used to avoid repeated network reads. */
  contentPaths?: ReadonlyMap<Sha256Digest, string>;
}

function contentPath(input: PdfExportInput, content: StoredContent): string {
  return input.contentPaths?.get(content.digest) ?? resolveInsideReview(input.reviewRoot, content.blobPath);
}

export interface PdfExportResult {
  absolutePath: string;
  relativePath: string;
  event: ExportCreatedEvent;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
const BLUE = "#2458A6";
const INK = "#172033";
const MUTED = "#667085";
const BORDER = "#D0D5DD";
const LIGHT = "#F2F4F7";

function cleanFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "review";
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

function sectionHeading(doc: PDFKit.PDFDocument, text: string, level = 1): void {
  const sizes = [18, 14, 11];
  const size = sizes[Math.min(level - 1, sizes.length - 1)];
  ensureSpace(doc, size * 2.2);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.moveDown(level === 1 ? 0.8 : 0.5).font("Helvetica-Bold").fontSize(size).fillColor(INK).text(text, left, doc.y, { width });
  if (level === 1) doc.moveTo(left, doc.y + 3).lineTo(doc.page.width - doc.page.margins.right, doc.y + 3).strokeColor(BORDER).lineWidth(0.6).stroke().moveDown(0.45);
  else doc.moveDown(0.25);
  doc.x = left;
}

function paragraph(doc: PDFKit.PDFDocument, text: string, options: PDFKit.Mixins.TextOptions = {}): void {
  if (!text.trim()) return;
  ensureSpace(doc, 28);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(text.trim(), left, doc.y, { width, lineGap: 2, ...options }).moveDown(0.5);
  doc.x = left;
}

function keyValue(doc: PDFKit.PDFDocument, key: string, value: string): void {
  const x = doc.page.margins.left;
  const width = doc.page.width - x - doc.page.margins.right;
  const labelWidth = 130;
  const valueWidth = width - 138;
  doc.font("Helvetica-Bold").fontSize(8.5);
  const labelHeight = doc.heightOfString(key, { width: labelWidth });
  doc.font("Helvetica");
  const valueHeight = doc.heightOfString(value, { width: valueWidth });
  const rowHeight = Math.max(labelHeight, valueHeight) + 5;
  ensureSpace(doc, rowHeight);
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED).text(key, x, y, { width: labelWidth, lineBreak: true });
  doc.font("Helvetica").fillColor(INK).text(value, x + 138, y, { width: valueWidth, lineBreak: true });
  doc.x = x;
  doc.y = y + rowHeight;
}

function plainInline(token: Token): string {
  return (token.children ?? [])
    .map((child) => {
      if (child.type === "text" || child.type === "code_inline" || child.type === "html_inline") return child.content;
      if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
      if (child.type === "image") return child.content;
      return "";
    })
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function parseTable(tokens: Token[], start: number): { rows: string[][]; end: number } {
  const rows: string[][] = [];
  let currentRow: string[] | undefined;
  let currentCell = "";
  let inCell = false;
  let index = start;
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "tr_open") currentRow = [];
    else if (token.type === "th_open" || token.type === "td_open") {
      inCell = true;
      currentCell = "";
    } else if (token.type === "inline" && inCell) currentCell += plainInline(token);
    else if (token.type === "th_close" || token.type === "td_close") {
      currentRow?.push(currentCell);
      inCell = false;
    } else if (token.type === "tr_close" && currentRow) {
      rows.push(currentRow);
      currentRow = undefined;
    } else if (token.type === "table_close") break;
  }
  return { rows, end: index };
}

function drawTable(doc: PDFKit.PDFDocument, rows: string[][]): void {
  if (!rows.length) return;
  const columns = Math.max(...rows.map((row) => row.length));
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cellWidth = available / columns;
  const fontSize = columns > 7 ? 6.5 : columns > 5 ? 7.2 : 8;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const heights = Array.from({ length: columns }, (_, column) =>
      doc.font(rowIndex === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).heightOfString(row[column] ?? "", { width: cellWidth - 10, lineGap: 1 }),
    );
    const height = Math.max(22, ...heights.map((value) => value + 10));
    ensureSpace(doc, Math.min(height, doc.page.height - doc.page.margins.top - doc.page.margins.bottom));
    const y = doc.y;
    for (let column = 0; column < columns; column++) {
      const x = doc.page.margins.left + column * cellWidth;
      doc.rect(x, y, cellWidth, height).fillAndStroke(rowIndex === 0 ? LIGHT : "#FFFFFF", BORDER);
      doc.font(rowIndex === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor(INK).text(row[column] ?? "", x + 5, y + 5, { width: cellWidth - 10, height: height - 10, ellipsis: false, lineGap: 1 });
    }
    doc.y = y + height;
  }
  doc.moveDown(0.7);
}

function svgSize(svg: string): { width: number; height: number } {
  const viewBox = /viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)["']/i.exec(svg);
  if (viewBox) return { width: Number(viewBox[1]) || 800, height: Number(viewBox[2]) || 450 };
  const width = Number(/\bwidth=["']([\d.]+)/i.exec(svg)?.[1]) || 800;
  const height = Number(/\bheight=["']([\d.]+)/i.exec(svg)?.[1]) || 450;
  return { width, height };
}

function drawSvg(doc: PDFKit.PDFDocument, svg: string, caption: string): void {
  const size = svgSize(svg);
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxHeight = 420;
  const scale = Math.min(availableWidth / size.width, maxHeight / size.height, 1);
  const width = size.width * scale;
  const height = size.height * scale;
  ensureSpace(doc, height + 34);
  const x = doc.page.margins.left + (availableWidth - width) / 2;
  const y = doc.y;
  SVGtoPDF(doc, svg, x, y, { width, height, preserveAspectRatio: "xMidYMid meet" });
  doc.y = y + height + 5;
  doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(MUTED).text(caption, { align: "center" }).moveDown(0.7);
}

async function drawImage(
  doc: PDFKit.PDFDocument,
  bytes: Buffer,
  mediaType: string,
  caption: string,
): Promise<void> {
  if (mediaType === "image/svg+xml") {
    drawSvg(doc, bytes.toString("utf8"), caption);
    return;
  }
  const normalized = await sharp(bytes, { animated: false }).rotate().png().toBuffer();
  const metadata = await sharp(normalized).metadata();
  const sourceWidth = metadata.width ?? 800;
  const sourceHeight = metadata.height ?? 450;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const scale = Math.min(availableWidth / sourceWidth, 420 / sourceHeight, 1);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  ensureSpace(doc, height + 34);
  const x = doc.page.margins.left + (availableWidth - width) / 2;
  doc.image(normalized, x, doc.y, { width, height });
  doc.y += height + 5;
  doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(MUTED).text(caption, { align: "center" }).moveDown(0.7);
}

async function renderMarkdown(
  doc: PDFKit.PDFDocument,
  source: string,
  documentPath: string,
  input: PdfExportInput,
): Promise<void> {
  const tokens = md.parse(source, {});
  let pendingBlock: "paragraph" | "heading" | undefined;
  let headingLevel = 1;
  let listDepth = 0;
  let listItem = false;
  let diagramOrdinal = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "heading_open") {
      pendingBlock = "heading";
      headingLevel = Number(token.tag.slice(1)) || 1;
    } else if (token.type === "paragraph_open") pendingBlock = "paragraph";
    else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") listDepth += 1;
    else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") listDepth = Math.max(0, listDepth - 1);
    else if (token.type === "list_item_open") listItem = true;
    else if (token.type === "list_item_close") listItem = false;
    else if (token.type === "inline") {
      const images = (token.children ?? []).filter((child) => child.type === "image");
      const text = plainInline(token);
      if (pendingBlock === "heading") sectionHeading(doc, text, Math.min(3, headingLevel));
      else if (images.length) {
        const nonImageText = (token.children ?? []).filter((child) => child.type !== "image").map((child) => child.content).join("").trim();
        if (nonImageText) paragraph(doc, nonImageText);
        for (const image of images) {
          const reference = image.attrGet("src") ?? "";
          const resource = input.revision.resources.find((item) => item.id === resourceIdFor(documentPath, reference));
          if (!resource) paragraph(doc, `[Image unavailable: ${reference}]`);
          else await drawImage(doc, await readFile(contentPath(input, resource)), resource.mediaType, image.content || resource.alt || reference);
        }
      } else if (pendingBlock === "paragraph" || listItem) {
        paragraph(doc, `${listDepth || listItem ? "• ".padStart(Math.max(2, listDepth * 2), " ") : ""}${text}`, {
          indent: listDepth ? 12 * Math.max(1, listDepth) : 0,
        });
      }
      pendingBlock = undefined;
    } else if (token.type === "fence") {
      if (token.info.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") {
        const descriptor = input.revision.mermaidDiagrams.find((item) => item.document === documentPath && item.ordinal === diagramOrdinal++);
        const svg = descriptor ? input.renderData.diagrams[descriptor.id] : undefined;
        if (!descriptor || !svg) throw new Error(`Missing rendered Mermaid diagram ${diagramOrdinal} in ${documentPath}`);
        drawSvg(doc, svg, `Mermaid diagram ${diagramOrdinal} · source ${descriptor.sourceDigest.slice(0, 20)}…`);
      } else {
        ensureSpace(doc, 55);
        doc.font("Courier").fontSize(7.5).fillColor(INK).rect(doc.page.margins.left, doc.y, doc.page.width - doc.page.margins.left - doc.page.margins.right, Math.min(220, doc.heightOfString(token.content, { width: 480 }) + 18)).fill(LIGHT);
        doc.fillColor(INK).text(token.content.trimEnd(), doc.page.margins.left + 9, doc.y + 9, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 18 }).moveDown(0.6);
      }
    } else if (token.type === "table_open") {
      const parsed = parseTable(tokens, index);
      drawTable(doc, parsed.rows);
      index = parsed.end;
    } else if (token.type === "hr") {
      ensureSpace(doc, 16);
      doc.moveTo(doc.page.margins.left, doc.y + 5).lineTo(doc.page.width - doc.page.margins.right, doc.y + 5).strokeColor(BORDER).stroke().moveDown(0.8);
    }
  }
}

function addAuditSections(doc: PDFKit.PDFDocument, input: PdfExportInput, exportId: string, included: ReviewEvent[]): void {
  const revisionThreads = [...input.state.threads.values()].filter((thread) => thread.revisionId === input.revision.id);
  const approvals = input.state.approvals.filter((approval) => approval.revisionId === input.revision.id);
  const rejections = input.state.rejections.filter((rejection) => rejection.revisionId === input.revision.id);
  const suggestions = [...input.state.suggestions.values()].filter((suggestion) => suggestion.revisionId === input.revision.id);
  doc.addPage();
  doc.outline.addItem("Review record");
  sectionHeading(doc, "Review record");
  paragraph(doc, `${revisionThreads.length} thread(s), ${input.state.unresolvedThreads.filter((thread) => thread.revisionId === input.revision.id).length} unresolved, ${suggestions.length} suggested edit(s), ${approvals.length} approval(s), ${rejections.length} rejection(s).`);
  for (const [index, thread] of revisionThreads.entries()) {
    sectionHeading(doc, `${index + 1}. ${thread.resolved ? "Resolved" : "Open"} comment`, 2);
    keyValue(doc, "Document", `${thread.root.anchor.document}:${thread.root.anchor.range.start.line + 1}`);
    keyValue(doc, "Revision", thread.revisionId);
    keyValue(doc, "Author", thread.root.actor.displayName ?? thread.root.actor.id);
    keyValue(doc, "Target", thread.root.anchor.target?.kind ?? "text");
    paragraph(doc, `Quoted content: “${thread.root.anchor.quote.exact}”`);
    paragraph(doc, thread.root.body.text);
    for (const reply of thread.replies) paragraph(doc, `Reply — ${reply.actor.displayName ?? reply.actor.id}: ${reply.body.text}`, { indent: 16 });
    if (thread.decision) {
      keyValue(doc, "Comment decision", `${thread.decision.decision} · ${thread.decision.actor.displayName ?? thread.decision.actor.id}${thread.decision.reason ? ` · ${thread.decision.reason}` : ""}`);
    }
    for (const conflict of thread.decisionConflicts) keyValue(doc, "Decision conflict", `${conflict.decision} · ${conflict.actor.displayName ?? conflict.actor.id}`);
    if (thread.resolved) keyValue(doc, "Resolved by", thread.resolved.actor.displayName ?? thread.resolved.actor.id);
  }
  sectionHeading(doc, "Suggested edits");
  if (!suggestions.length) paragraph(doc, "No suggested edit was recorded for this revision.");
  for (const [index, suggestion] of suggestions.entries()) {
    const operation = suggestion.created.operation;
    sectionHeading(doc, `${index + 1}. ${operation.kind} · ${suggestion.status}`, 2);
    keyValue(doc, "Document", `${suggestion.created.anchor.document}:${suggestion.created.anchor.range.start.line + 1}`);
    keyValue(doc, "Suggested by", suggestion.created.actor.displayName ?? suggestion.created.actor.id);
    keyValue(doc, "Original string", suggestion.created.anchor.quote.exact);
    if (operation.kind !== "delete") keyValue(doc, operation.kind === "insert" ? `Insert ${operation.position}` : "Replacement", operation.replacement);
    paragraph(doc, `Rationale: ${suggestion.created.rationale.text}`);
    if (suggestion.accepted) keyValue(doc, "Accepted by", suggestion.accepted.actor.displayName ?? suggestion.accepted.actor.id);
    if (suggestion.rejected) keyValue(doc, "Rejected by", `${suggestion.rejected.actor.displayName ?? suggestion.rejected.actor.id}${suggestion.rejected.reason ? ` · ${suggestion.rejected.reason}` : ""}`);
    if (suggestion.applied) {
      keyValue(doc, "Applied by", suggestion.applied.actor.displayName ?? suggestion.applied.actor.id);
      keyValue(doc, "Source digest change", `${suggestion.applied.sourceDigestBefore} → ${suggestion.applied.sourceDigestAfter}`);
    }
    for (const conflict of suggestion.decisionConflicts) keyValue(doc, "Decision conflict", `${conflict.type} · ${conflict.actor.displayName ?? conflict.actor.id}`);
  }
  sectionHeading(doc, "Revision decisions");
  if (!approvals.length) paragraph(doc, "No approval event was recorded for this revision.");
  for (const approval of approvals) {
    keyValue(doc, `Approved · ${approval.actor.displayName ?? approval.actor.id}`, `${approval.occurredAt}${approval.note ? ` · ${approval.note}` : ""}`);
  }
  for (const rejection of rejections) keyValue(doc, `Rejected · ${rejection.actor.displayName ?? rejection.actor.id}`, `${rejection.occurredAt} · ${rejection.reason}`);

  doc.addPage();
  doc.outline.addItem("Audit appendix");
  sectionHeading(doc, "Audit appendix");
  keyValue(doc, "Protocol", `${input.manifest.protocol} ${input.manifest.protocolVersion}`);
  keyValue(doc, "Review ID", input.manifest.reviewId);
  keyValue(doc, "Revision ID", input.revision.id);
  keyValue(doc, "Export ID", exportId);
  keyValue(doc, "Client", `Open Markdown Review VS Code ${input.clientVersion}`);
  keyValue(doc, "PDF engine", "PDFKit 0.17.2");
  keyValue(doc, "Mermaid", input.revision.renderer.mermaidVersion);
  paragraph(doc, "The PDF digest is recorded in the adjacent immutable export.created event. It cannot be embedded in the PDF itself because that would change the digest being recorded.");

  sectionHeading(doc, "Frozen documents");
  for (const item of input.revision.documents) keyValue(doc, item.path, `${item.digest} · ${item.byteLength} bytes`);
  sectionHeading(doc, "Captured resources");
  if (!input.revision.resources.length) paragraph(doc, "No embedded resources.");
  for (const item of input.revision.resources) keyValue(doc, item.originalReference, `${item.mediaType} · ${item.digest} · ${item.byteLength} bytes`);
  sectionHeading(doc, "External references");
  if (!input.revision.externalReferences.length) paragraph(doc, "No external links.");
  for (const item of input.revision.externalReferences) keyValue(doc, item.label ?? item.document, item.uri);
  sectionHeading(doc, "Included event inventory");
  for (const event of included) {
    const digest = sha256(`${JSON.stringify(event, null, 2)}\n`);
    keyValue(doc, `${event.type} · ${event.id}`, digest);
  }
}

async function documentToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.end();
  return completed;
}

export async function exportAuditPdf(input: PdfExportInput): Promise<PdfExportResult> {
  const errors = Object.entries(input.renderData.diagramErrors);
  if (errors.length) throw new Error(`PDF export blocked: ${errors.map(([id, message]) => `${id}: ${message}`).join("; ")}`);
  for (const diagram of input.revision.mermaidDiagrams) {
    if (!input.renderData.diagrams[diagram.id]) throw new Error(`PDF export blocked: diagram ${diagram.id} was not rendered.`);
  }

  const now = new Date();
  const exportId = createId("export", now);
  const included = input.events.filter(
    (event) => event.type === "revision.created" ? event.revisionId === input.revision.id : "revisionId" in event && event.revisionId === input.revision.id,
  );
  const doc = new PDFDocument({ size: "A4", margins: { top: 54, bottom: 58, left: 54, right: 54 }, bufferPages: true, info: {
    Title: `${input.manifest.title} — audit review`,
    Author: input.actor.displayName ?? input.actor.id,
    Subject: `Review ${input.manifest.reviewId}, revision ${input.revision.id}`,
    Keywords: "Markdown review audit local-first",
    CreationDate: now,
  } });

  doc.rect(0, 0, doc.page.width, 150).fill(BLUE);
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(27).text("Markdown review", 54, 60, { width: 480 });
  doc.font("Helvetica").fontSize(13).text("Auditable client-side export", 54, 101);
  doc.y = 195;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(22).text(input.manifest.title);
  doc.moveDown(1.2);
  keyValue(doc, "Review ID", input.manifest.reviewId);
  keyValue(doc, "Revision ID", input.revision.id);
  keyValue(doc, "Export ID", exportId);
  keyValue(doc, "Created", now.toISOString());
  keyValue(doc, "Exported by", input.actor.displayName ?? input.actor.id);
  keyValue(doc, "Documents", String(input.revision.documents.length));
  keyValue(doc, "Captured images", String(input.revision.resources.filter((item) => item.role === "image").length));
  keyValue(doc, "Attachments", String(input.revision.resources.filter((item) => item.role === "attachment").length));
  keyValue(doc, "Mermaid diagrams", String(input.revision.mermaidDiagrams.length));
  keyValue(doc, "Unresolved threads", String(input.state.unresolvedThreads.filter((thread) => thread.revisionId === input.revision.id).length));
  keyValue(doc, "Open suggestions", String(input.state.openSuggestions.filter((suggestion) => suggestion.revisionId === input.revision.id).length));
  keyValue(doc, "Approvals / rejections", `${input.state.approvals.filter((event) => event.revisionId === input.revision.id).length} / ${input.state.rejections.filter((event) => event.revisionId === input.revision.id).length}`);
  doc.moveDown(2);
  doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED).text("Generated locally from immutable review files. No review server or cloud PDF service was used.");

  for (const [index, document] of input.revision.documents.entries()) {
    doc.addPage();
    if (index === 0) doc.outline.addItem("Reviewed documents");
    sectionHeading(doc, document.path);
    keyValue(doc, "Frozen digest", document.digest);
    const source = await readFile(contentPath(input, document), "utf8");
    await renderMarkdown(doc, source, document.path, input);
  }
  addAuditSections(doc, input, exportId, included);

  const range = doc.bufferedPageRange();
  for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex++) {
    doc.switchToPage(pageIndex);
    const footerY = doc.page.height - 31;
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(doc.page.margins.left, footerY - 7).lineTo(doc.page.width - doc.page.margins.right, footerY - 7).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(`${input.manifest.title} · ${input.revision.id}`, doc.page.margins.left, footerY, { width: 390, lineBreak: false });
    doc.text(`${pageIndex + 1} / ${range.count}`, doc.page.width - doc.page.margins.right - 70, footerY, { width: 70, align: "right", lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }

  const bytes = await documentToBuffer(doc);
  const relativePath = `${input.manifest.exportDirectory}/${cleanFilename(input.manifest.title)}-${input.revision.id.slice(-12)}-${exportId.slice(-8)}.pdf`;
  const absolutePath = resolveInsideReview(input.reviewRoot, relativePath);
  await writeArtifactExclusive(absolutePath, bytes);

  const renderedDiagramDigests: Record<string, `sha256:${string}`> = {};
  for (const [diagramId, svg] of Object.entries(input.renderData.diagrams)) {
    const stored = await writeBlob(input.reviewRoot, Buffer.from(svg, "utf8"), "image/svg+xml", input.manifest.blobDirectory);
    renderedDiagramDigests[diagramId] = stored.digest;
  }
  const event: ExportCreatedEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: createId("evt", now),
    type: "export.created",
    reviewId: input.manifest.reviewId,
    revisionId: input.revision.id,
    occurredAt: now.toISOString(),
    actor: input.actor,
    exportId,
    format: "application/pdf",
    exportPath: relativePath,
    exportDigest: sha256(bytes),
    includedEventIds: included.map((event) => event.id),
    renderer: {
      client: "open-markdown-review-vscode",
      clientVersion: input.clientVersion,
      pdfEngine: "PDFKit 0.17.2",
      mermaidVersion: MERMAID_RENDERER_VERSION,
    },
    renderedDiagramDigests,
  };
  await appendEvent(input.reviewRoot, event);
  return { absolutePath, relativePath, event };
}
