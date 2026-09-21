import * as vscode from 'vscode';
import { ReviewItem, ReviewsProvider } from './reviewsView';
import { ThreadsProvider } from './threadsView';
import { ProfessionalHost } from './professional/extensionHost';
import { reviewPathKey } from './reviewPaths';

/** One sidebar over both readers; no migration or second copy of review evidence. */
export class ReviewSidebar implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly legacy: ReviewsProvider, private readonly packages: ProfessionalHost, private readonly threads?: ThreadsProvider) {
    this.subscriptions = [legacy.onDidChangeTreeData(() => this.changed.fire()), packages.onDidChangeTreeData(() => this.changed.fire())];
    if (threads) this.subscriptions.push(threads.onDidChangeTreeData(() => this.changed.fire()));
  }
  getTreeItem(item: vscode.TreeItem) { return item; }
  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (this.threads) return this.packages.active ? item ? [] : this.packages.getActiveChildren() : this.threads.getChildren(item);
    if (item) return [];
    const modern = this.packages.getChildren(), roots = new Set(modern.map(p => reviewPathKey(p.entry.root)));
    const legacy = this.legacy.getChildren().filter(p => !roots.has(reviewPathKey(p.review.reviewRoot))).map(p => this.packages.active && p.active ? new ReviewItem(p.review, false, '') : p);
    return [...modern, ...legacy].sort((left, right) => {
      const leftLabel = typeof left.label === 'string' ? left.label : left.label?.label ?? '';
      const rightLabel = typeof right.label === 'string' ? right.label : right.label?.label ?? '';
      const byLabel = leftLabel.localeCompare(rightLabel);
      return byLabel || String(left.id ?? '').localeCompare(String(right.id ?? ''));
    });
  }
  dispose() { for (const subscription of this.subscriptions) subscription.dispose(); this.changed.dispose(); }
}
