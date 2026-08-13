import * as vscode from "vscode";
import { ReviewState, ReviewSuggestion, ReviewThread } from "./protocol/types";

function compact(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export class ThreadItem extends vscode.TreeItem {
  readonly thread: ReviewThread;

  constructor(thread: ReviewThread) {
    super(
      compact(thread.root.body.text),
      thread.replies.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.thread = thread;
    const actor = thread.root.actor.displayName ?? thread.root.actor.id;
    const anchor = thread.root.anchor;
    this.description = `${actor} · ${anchor.document}:${anchor.range.start.line + 1}`;
    this.tooltip = new vscode.MarkdownString(
      `**${actor}** on \`${anchor.document}:${anchor.range.start.line + 1}\`\n\n${thread.root.body.text}`,
    );
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.contextValue = "reviewThread";
    this.command = {
      command: "openMarkdownReview.openThread",
      title: "Open review thread",
      arguments: [this],
    };
  }
}

class ReplyItem extends vscode.TreeItem {
  constructor(readonly thread: ReviewThread, replyIndex: number) {
    const reply = thread.replies[replyIndex];
    super(compact(reply.body.text), vscode.TreeItemCollapsibleState.None);
    this.description = reply.actor.displayName ?? reply.actor.id;
    this.tooltip = new vscode.MarkdownString(reply.body.text);
    this.iconPath = new vscode.ThemeIcon("reply");
    this.contextValue = "reviewReply";
    this.command = {
      command: "openMarkdownReview.openThread",
      title: "Open review thread",
      arguments: [this],
    };
  }
}

export class SuggestionItem extends vscode.TreeItem {
  constructor(readonly suggestion: ReviewSuggestion) {
    const operation = suggestion.created.operation;
    super(`${operation.kind}: ${compact(suggestion.created.anchor.quote.exact, 56)}`, vscode.TreeItemCollapsibleState.None);
    this.description = `${suggestion.status} · ${suggestion.created.anchor.document}:${suggestion.created.anchor.range.start.line + 1}`;
    const replacement = operation.kind === "delete" ? "(delete)" : operation.replacement;
    this.tooltip = new vscode.MarkdownString(`**${operation.kind}** \`${suggestion.created.anchor.quote.exact}\` → \`${replacement}\`\n\n${suggestion.created.rationale.text}`);
    this.iconPath = new vscode.ThemeIcon(suggestion.status === "accepted" ? "diff-added" : suggestion.status === "conflicted" ? "warning" : "diff-modified");
    this.contextValue = suggestion.status === "accepted" ? "reviewSuggestionAccepted" : "reviewSuggestionOpen";
    this.command = {
      command: "openMarkdownReview.openReview",
      title: "Open rendered review",
    };
  }
}

export type ThreadArgument = ThreadItem | { thread: ReviewThread } | ReviewThread | string | undefined;
export type SuggestionArgument = SuggestionItem | { suggestion: ReviewSuggestion } | ReviewSuggestion | string | undefined;

export class ThreadsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  private state?: ReviewState;
  readonly onDidChangeTreeData = this.changed.event;

  setState(state: ReviewState | undefined): void {
    this.state = state;
    this.changed.fire();
  }

  getState(): ReviewState | undefined {
    return this.state;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!this.state) return [];
    if (element instanceof ThreadItem) {
      return element.thread.replies.map((_, index) => new ReplyItem(element.thread, index));
    }
    return [
      ...this.state.unresolvedThreads.map((thread) => new ThreadItem(thread)),
      ...this.state.openSuggestions.map((suggestion) => new SuggestionItem(suggestion)),
      ...[...this.state.suggestions.values()].filter((suggestion) => suggestion.status === "accepted" && (!this.state?.latestRevisionId || suggestion.revisionId === this.state.latestRevisionId)).map((suggestion) => new SuggestionItem(suggestion)),
    ];
  }

  threadFromArgument(argument: ThreadArgument): ReviewThread | undefined {
    if (!argument) return undefined;
    if (typeof argument === "string") return this.state?.threads.get(argument);
    if ("thread" in argument) return argument.thread;
    if ("root" in argument && "replies" in argument) return argument;
    return undefined;
  }

  suggestionFromArgument(argument: SuggestionArgument): ReviewSuggestion | undefined {
    if (!argument) return undefined;
    if (typeof argument === "string") return this.state?.suggestions.get(argument);
    if ("suggestion" in argument) return argument.suggestion;
    if ("created" in argument && "status" in argument) return argument;
    return undefined;
  }
}
