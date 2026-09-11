import path from "node:path";
import * as vscode from "vscode";
import { ReviewManifest } from "./protocol/types";
import { reviewPathKey, sameReviewPath } from './reviewPaths';

export interface RegisteredReview {
  reviewRoot: string;
  manifest: ReviewManifest;
}

export class ReviewItem extends vscode.TreeItem {
  constructor(readonly review: RegisteredReview, readonly active: boolean, sourceRoot: string) {
    super(review.manifest.title, vscode.TreeItemCollapsibleState.None);
    const relative = path.relative(sourceRoot, review.reviewRoot);
    const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    this.description = `${active ? "Active · " : ""}${inside ? relative : review.reviewRoot}`;
    this.tooltip = new vscode.MarkdownString(
      `**${review.manifest.title}**${active ? " · Active" : ""}\n\nPackage: \`${review.reviewRoot}\`\n\nReview ID: \`${review.manifest.reviewId}\``,
    );
    this.iconPath = new vscode.ThemeIcon(active ? "pass-filled" : "archive");
    this.contextValue = active ? "markdownReviewActive" : "markdownReviewInactive";
    this.command = {
      command: "openMarkdownReview.switchReview",
      title: "Make review active",
      arguments: [this],
    };
  }
}

export type ReviewArgument = ReviewItem | RegisteredReview | string | undefined;

export class ReviewsProvider implements vscode.TreeDataProvider<ReviewItem> {
  private readonly changed = new vscode.EventEmitter<ReviewItem | undefined | void>();
  private reviews: RegisteredReview[] = [];
  private activeRoot?: string;
  private sourceRoot = "";
  readonly onDidChangeTreeData = this.changed.event;

  setReviews(reviews: RegisteredReview[], activeRoot: string | undefined, sourceRoot: string): void {
    this.reviews = [...new Map(reviews.map(review => [reviewPathKey(review.reviewRoot), review])).values()];
    this.activeRoot = activeRoot;
    this.sourceRoot = sourceRoot;
    this.changed.fire();
  }

  getReviews(): readonly RegisteredReview[] {
    return this.reviews;
  }

  reviewFromArgument(argument: ReviewArgument): RegisteredReview | undefined {
    if (!argument) return undefined;
    if (typeof argument === "string") return this.reviews.find((item) => sameReviewPath(item.reviewRoot, argument) || item.manifest.reviewId === argument);
    if (argument instanceof ReviewItem) return argument.review;
    return argument;
  }

  getTreeItem(element: ReviewItem): ReviewItem {
    return element;
  }

  getChildren(): ReviewItem[] {
    return this.reviews.map((review) => new ReviewItem(review, sameReviewPath(review.reviewRoot, this.activeRoot), this.sourceRoot));
  }
}
