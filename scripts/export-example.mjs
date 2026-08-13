import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportAuditPdf } from "../out/src/pdfExport.js";
import { buildReviewState } from "../out/src/protocol/state.js";
import { loadEvents, loadRevision } from "../out/src/protocol/store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = process.env.OMR_EXAMPLE_WORKSPACE
  ? path.resolve(process.env.OMR_EXAMPLE_WORKSPACE)
  : path.join(projectRoot, "protocol", "examples");
const reviewRoot = path.join(workspaceRoot, ".review");
const manifest = JSON.parse(await readFile(path.join(reviewRoot, "manifest.json"), "utf8"));
const loaded = await loadEvents(reviewRoot, manifest.reviewId);
const state = buildReviewState(loaded.events);
const revisionEvent = state.revisionEvents.at(-1);
if (!revisionEvent) throw new Error("Example revision event is missing");
const revision = await loadRevision(reviewRoot, revisionEvent.revisionPath, revisionEvent.revisionDigest);
const diagram = revision.mermaidDiagrams[0];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 180">
  <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2458a6"/></marker></defs>
  <g font-family="Arial, sans-serif" text-anchor="middle" fill="#172033">
    <rect x="20" y="55" width="170" height="70" rx="8" fill="#dce8fa" stroke="#2458a6"/>
    <rect x="275" y="55" width="170" height="70" rx="8" fill="#dce8fa" stroke="#2458a6"/>
    <rect x="530" y="55" width="170" height="70" rx="8" fill="#dce8fa" stroke="#2458a6"/>
    <text x="105" y="96" font-size="15">Markdown workspace</text>
    <text x="360" y="96" font-size="15">Immutable revision</text>
    <text x="615" y="96" font-size="15">Audit PDF</text>
    <path d="M190 90 H275" stroke="#2458a6" stroke-width="3" marker-end="url(#arrow)"/>
    <path d="M445 90 H530" stroke="#2458a6" stroke-width="3" marker-end="url(#arrow)"/>
  </g>
</svg>`;
const result = await exportAuditPdf({
  reviewRoot,
  manifest,
  revision,
  state,
  events: loaded.events,
  renderData: { diagrams: { [diagram.id]: svg }, diagramErrors: {} },
  actor: { id: "mirek", displayName: "Mirek" },
  clientVersion: "0.4.3",
});
const outputDirectory = path.join(projectRoot, "output", "pdf");
await mkdir(outputDirectory, { recursive: true });
const stablePath = path.join(outputDirectory, process.env.OMR_EXAMPLE_OUTPUT ?? "open-markdown-review-sample-audit.pdf");
await copyFile(result.absolutePath, stablePath);
console.log(stablePath);
