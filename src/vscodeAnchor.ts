import { createHash } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { locateQuote } from "./protocol/anchor";
import { MarkdownAnchor, ReviewThread } from "./protocol/types";

const CONTEXT_LENGTH = 80;

export function createAnchor(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  workspaceRoot: string,
): MarkdownAnchor {
  if (selection.isEmpty) throw new Error("Select Markdown text before adding a comment.");

  const documentText = document.getText();
  const startOffset = document.offsetAt(selection.start);
  const endOffset = document.offsetAt(selection.end);
  const relativePath = path.relative(workspaceRoot, document.uri.fsPath).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("The selected document must be inside the review workspace.");
  }

  return {
    document: relativePath,
    range: {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
    },
    quote: {
      exact: document.getText(selection),
      prefix: documentText.slice(Math.max(0, startOffset - CONTEXT_LENGTH), startOffset),
      suffix: documentText.slice(endOffset, endOffset + CONTEXT_LENGTH),
    },
    documentDigest: `sha256:${createHash("sha256").update(documentText).digest("hex")}`,
  };
}

function safeOffsetAt(document: vscode.TextDocument, line: number, character: number): number {
  const safeLine = Math.min(Math.max(0, line), Math.max(0, document.lineCount - 1));
  const lineInfo = document.lineAt(safeLine);
  const safeCharacter = Math.min(Math.max(0, character), lineInfo.range.end.character);
  return document.offsetAt(new vscode.Position(safeLine, safeCharacter));
}

export async function revealThread(workspaceRoot: string, thread: ReviewThread): Promise<void> {
  const anchor = thread.root.anchor;
  const resolvedRoot = path.resolve(workspaceRoot);
  const documentPath = path.resolve(resolvedRoot, ...anchor.document.split("/"));
  const relativeCheck = path.relative(resolvedRoot, documentPath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    throw new Error("The thread anchor points outside the workspace.");
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(documentPath));
  const text = document.getText();
  const preferredOffset = safeOffsetAt(
    document,
    anchor.range.start.line,
    anchor.range.start.character,
  );
  const storedEndOffset = safeOffsetAt(document, anchor.range.end.line, anchor.range.end.character);

  let start = preferredOffset;
  let end = storedEndOffset;
  if (text.slice(start, end) !== anchor.quote.exact) {
    const located = locateQuote(
      text,
      anchor.quote.exact,
      anchor.quote.prefix,
      anchor.quote.suffix,
      preferredOffset,
    );
    if (located) {
      start = located.start;
      end = located.end;
    } else {
      void vscode.window.showWarningMessage(
        "The original quoted text has changed; showing its last known position.",
      );
    }
  }

  const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
