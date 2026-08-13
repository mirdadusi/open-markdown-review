import path from "node:path";
import * as vscode from "vscode";
import { locateQuote, offsetAtLine } from "./protocol/anchor";
import { ReviewRevision, ReviewState, ReviewThread } from "./protocol/types";

interface DecorationGroup {
  range: vscode.Range;
  threads: ReviewThread[];
  open: boolean;
}

function documentRelativePath(sourceRoot: string, document: vscode.TextDocument): string | undefined {
  if (document.uri.scheme !== "file") return undefined;
  const relative = path.relative(path.resolve(sourceRoot), path.resolve(document.uri.fsPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function rangeForThread(document: vscode.TextDocument, thread: ReviewThread): vscode.Range {
  const anchor = thread.root.anchor;
  const source = document.getText();
  const safeLine = Math.min(anchor.range.start.line, Math.max(0, document.lineCount - 1));
  const preferred = Math.min(source.length, offsetAtLine(source, safeLine) + anchor.range.start.character);
  const located = locateQuote(source, anchor.quote.exact, anchor.quote.prefix ?? "", anchor.quote.suffix ?? "", preferred);
  if (located) return new vscode.Range(document.positionAt(located.start), document.positionAt(located.end));
  const endLine = Math.min(anchor.range.end.line, Math.max(0, document.lineCount - 1));
  const start = new vscode.Position(safeLine, Math.min(anchor.range.start.character, document.lineAt(safeLine).range.end.character));
  const end = new vscode.Position(endLine, Math.min(anchor.range.end.character, document.lineAt(endLine).range.end.character));
  return new vscode.Range(start, end);
}

function hoverForThreads(threads: readonly ReviewThread[]): vscode.MarkdownString {
  const hover = new vscode.MarkdownString(undefined, true);
  hover.isTrusted = { enabledCommands: ["openMarkdownReview.showThread"] };
  hover.appendMarkdown(`**${threads.length} review comment${threads.length === 1 ? "" : "s"}**\n\n`);
  for (const [index, thread] of threads.entries()) {
    const actor = thread.root.actor.displayName ?? thread.root.actor.id;
    hover.appendText(`${actor}: ${thread.root.body.text}`);
    const args = encodeURIComponent(JSON.stringify([thread.id]));
    hover.appendMarkdown(`  [Show comment](command:openMarkdownReview.showThread?${args})`);
    if (index < threads.length - 1) hover.appendMarkdown("\n\n---\n\n");
  }
  return hover;
}

export class CommentDecorations implements vscode.Disposable {
  private readonly openType: vscode.TextEditorDecorationType;
  private readonly resolvedType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private sourceRoot?: string;
  private revision?: ReviewRevision;
  private state?: ReviewState;

  constructor(context: vscode.ExtensionContext) {
    const gutter = vscode.Uri.joinPath(context.extensionUri, "media", "comment-gutter.svg");
    this.openType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
      borderColor: new vscode.ThemeColor("editor.findMatchBorder"),
      borderStyle: "solid",
      borderWidth: "0 0 2px 0",
      gutterIconPath: gutter,
      gutterIconSize: "contain",
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.resolvedType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
      borderColor: new vscode.ThemeColor("editor.wordHighlightBorder"),
      borderStyle: "dotted",
      borderWidth: "0 0 1px 0",
      gutterIconPath: gutter,
      gutterIconSize: "contain",
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.disposables.push(
      this.openType,
      this.resolvedType,
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.visibleTextEditors.find((item) => item.document === event.document);
        if (editor) this.decorate(editor);
      }),
    );
  }

  setReview(sourceRoot: string, revision: ReviewRevision | undefined, state: ReviewState): void {
    this.sourceRoot = sourceRoot;
    this.revision = revision;
    this.state = state;
    this.refresh();
  }

  clear(): void {
    this.sourceRoot = undefined;
    this.revision = undefined;
    this.state = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.openType, []);
      editor.setDecorations(this.resolvedType, []);
    }
  }

  private refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
  }

  private decorate(editor: vscode.TextEditor): void {
    editor.setDecorations(this.openType, []);
    editor.setDecorations(this.resolvedType, []);
    if (!this.sourceRoot || !this.revision || !this.state) return;
    const relative = documentRelativePath(this.sourceRoot, editor.document);
    if (!relative) return;
    const openIds = new Set(this.state.unresolvedThreads.filter((thread) => thread.revisionId === this.revision!.id).map((thread) => thread.id));
    const threads = [...this.state.threads.values()].filter(
      (thread) => thread.revisionId === this.revision!.id && thread.root.anchor.document === relative,
    );
    const groups = new Map<string, DecorationGroup>();
    for (const thread of threads) {
      const range = rangeForThread(editor.document, thread);
      const key = `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
      const existing = groups.get(key);
      if (existing) {
        existing.threads.push(thread);
        existing.open ||= openIds.has(thread.id);
      } else {
        groups.set(key, { range, threads: [thread], open: openIds.has(thread.id) });
      }
    }
    const options = [...groups.values()].map((group): vscode.DecorationOptions => ({
      range: group.range,
      hoverMessage: hoverForThreads(group.threads),
      renderOptions: {
        after: {
          contentText: `  ${group.threads.length} comment${group.threads.length === 1 ? "" : "s"}`,
          color: new vscode.ThemeColor("editorCodeLens.foreground"),
          fontStyle: "italic",
        },
      },
    }));
    editor.setDecorations(this.openType, options.filter((_, index) => [...groups.values()][index].open));
    editor.setDecorations(this.resolvedType, options.filter((_, index) => ![...groups.values()][index].open));
  }

  dispose(): void {
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
