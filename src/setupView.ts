import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { validateDocumentSelection } from "./protocol/scope";

export interface ReviewSetupDefaults {
  initialized: boolean;
  workspaceName: string;
  title: string;
  availableDocuments: string[];
  selectedDocuments: string[];
  rootDocument?: string;
  sourceRoot: string;
  storageRoot: string;
  storageEditable: boolean;
  portableBrowserDefault: boolean;
}

export interface ReviewSetupResult {
  title: string;
  documentPaths: string[];
  rootDocument: string;
  storageRoot: string;
  includePortableBrowser: boolean;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function html(context: vscode.ExtensionContext, webview: vscode.Webview, defaults: ReviewSetupDefaults): string {
  const nonce = randomBytes(18).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "setup.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "setup.css"));
  const data = JSON.stringify(defaults).replaceAll("<", "\\u003c");
  const action = defaults.initialized ? "Create auditable revision" : "Initialize and create revision";
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${styleUri}"><title>Review setup</title></head><body>
<main class="setup-shell"><header class="hero"><div><span class="eyebrow">OPEN MARKDOWN REVIEW</span><h1>${defaults.initialized ? "Choose documents for the next revision" : "Set up a Markdown review"}</h1><p>${defaults.initialized ? "The selected files will form one new immutable, auditable revision. The previous revision remains unchanged." : "Choose individual Markdown files or entire folders. Only selected files become part of the review."}</p></div><div class="step-badge">${defaults.initialized ? "New revision" : "Review setup"}</div></header>
<section class="card details-card"><label for="review-title">Review title</label><input id="review-title" type="text" value="${escapeHtml(defaults.title)}" ${defaults.initialized ? "disabled" : ""}><span class="field-help">Shared with reviewers and shown in the audit PDF.</span></section>
<section class="card storage-card"><div><label for="storage-location">Review package folder</label><span id="storage-mode" class="storage-mode"></span></div><div class="storage-control"><input id="storage-location" type="text" readonly value="${escapeHtml(defaults.storageRoot)}">${defaults.storageEditable ? '<button id="choose-storage" class="secondary">Choose or create folder…</button>' : ""}</div><span class="field-help">This selected folder is the complete review package. Keep the default <code>.review</code>, or choose any name and any normal local disk, mounted shared drive, NAS/SMB/NFS folder, Git workspace, or synchronized folder.</span></section>
${defaults.initialized ? "" : `<section class="card access-card"><div class="picker-heading"><div><h2>Participant access</h2><p>Every new review includes both VS Code access and the HTML review toolbox.</p></div><span class="recommended">Included</span></div><div class="access-options">
<label class="access-option"><input type="radio" name="participant-access" value="portable" checked disabled><span><strong>VS Code + portable browser</strong><small>Creates one self-contained, review-named <code>Review-&lt;name&gt;.html</code> beside the package. Reviewers grant it access to this folder once; later openings resume automatically when permission remains granted. It embeds only review identity binding—not a copy of the review. JavaScript, Mermaid, styling and PDF libraries are bundled runtime dependencies.</small></span></label>
</div><div class="browser-boundary"><strong>Browser safety boundary</strong><span>The browser asks the participant to choose this review folder and to enter a review identity. It cannot silently inherit Windows identity, and unsupported browsers remain read-only or show a compatibility message.</span></div></section>`}
<section class="card picker-card"><div class="picker-heading"><div><h2>Markdown documents</h2><p>Select a folder to include all Markdown below it, or choose individual files.</p></div><div class="summary"><strong id="selected-count">0</strong><span>selected</span></div></div>
<div class="toolbar"><div class="search-wrap"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Filter files and folders…"></div><button id="select-all" class="secondary">Select all</button><button id="clear-all" class="secondary">Clear</button></div>
<div id="empty-state" class="empty-state" hidden>No Markdown files were found in this workspace.</div><div id="document-tree" class="document-tree" role="tree" aria-label="Markdown documents"></div></section>
<section class="card root-card"><label for="root-document">Start document</label><select id="root-document"></select><span class="field-help">This document opens first and appears first in the audit PDF.</span></section>
<div id="validation" class="validation" role="alert" hidden></div>
<footer><div class="scope-note"><span>Portable scope</span>The exact selected paths are frozen into each revision and travel with the shared folder.</div><div class="footer-actions"><button id="cancel" class="secondary">Cancel</button><button id="submit" class="primary">${action}</button></div></footer>
</main><script id="setup-data" type="application/json">${data}</script><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

export class ReviewSetupPanel {
  static show(context: vscode.ExtensionContext, defaults: ReviewSetupDefaults): Promise<ReviewSetupResult | undefined> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        "openMarkdownReview.setup",
        defaults.initialized ? "Review Documents · New Revision" : "Set Up Markdown Review",
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] },
      );
      let completed = false;
      const finish = (value?: ReviewSetupResult) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      panel.webview.html = html(context, panel.webview, defaults);
      const messageDisposable = panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
        if (message.command === "cancel") {
          finish();
          panel.dispose();
          return;
        }
        if (message.command === "chooseStorage" && defaults.storageEditable) {
          void vscode.window.showOpenDialog({
            title: "Choose where the review package will be stored",
            defaultUri: vscode.Uri.file(path.dirname(defaults.storageRoot)),
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Use this folder",
          }).then((selected) => {
            const storageRoot = selected?.[0]?.fsPath;
            if (!storageRoot) return;
            defaults.storageRoot = storageRoot;
            const relative = path.relative(defaults.sourceRoot, storageRoot);
            const insideWorkspace = !relative.startsWith("..") && !path.isAbsolute(relative);
            void panel.webview.postMessage({ command: "storageSelected", storageRoot, insideWorkspace });
          });
          return;
        }
        if (message.command !== "submit") return;
        const title = typeof message.title === "string" ? message.title.trim() : "";
        const documentPaths = Array.isArray(message.documentPaths)
          ? message.documentPaths.filter((item): item is string => typeof item === "string").sort()
          : [];
        const rootDocument = typeof message.rootDocument === "string" ? message.rootDocument : "";
        const storageRoot = typeof message.storageRoot === "string" ? message.storageRoot : "";
        const errors = validateDocumentSelection(defaults.availableDocuments, documentPaths, rootDocument);
        if (!defaults.initialized && !title) errors.unshift("Enter a review title.");
        if (!storageRoot || storageRoot !== defaults.storageRoot) errors.unshift("Choose a valid review package location.");
        if (errors.length) {
          void panel.webview.postMessage({ command: "validation", errors });
          return;
        }
        finish({
          title: defaults.initialized ? defaults.title : title,
          documentPaths,
          rootDocument,
          storageRoot,
          includePortableBrowser: !defaults.initialized && message.includePortableBrowser === true,
        });
        panel.dispose();
      });
      panel.onDidDispose(() => {
        messageDisposable.dispose();
        finish();
      });
    });
  }
}
