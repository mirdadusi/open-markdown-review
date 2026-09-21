import path from "node:path";
import * as vscode from "vscode";
import { ReviewManifest } from "./protocol/types";
import { reviewPathKey, sameReviewPath } from './reviewPaths';

export interface RegisteredReview {
  reviewRoot: string;
  manifest: ReviewManifest;
  /** Local source workspace used only to present a useful relative package path. */
  sourceRoot?: string;
}

export class ReviewItem extends vscode.TreeItem {
  constructor(readonly review: RegisteredReview, readonly active: boolean, sourceRoot: string) {
    super(review.manifest.title, vscode.TreeItemCollapsibleState.None);
    sourceRoot = review.sourceRoot ?? sourceRoot;
    const relative = sourceRoot ? path.relative(sourceRoot, review.reviewRoot) : review.reviewRoot;
    const inside = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    this.description = `${active ? "Active · " : ""}${inside ? relative : review.reviewRoot}`;
    this.tooltip = new vscode.MarkdownString(
      `**${review.manifest.title}**${active ? " · Active" : ""}\n\nPackage: \`${review.reviewRoot}\`\n\nReview ID: \`${review.manifest.reviewId}\``,
    );
    this.id = `review:${reviewPathKey(review.reviewRoot)}`;
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
  private readonly reviewsBySource = new Map<string, { sourceRoot: string; reviews: RegisteredReview[] }>();
  private reviews: RegisteredReview[] = [];
  private activeRoot?: string;
  private sourceRoot = "";
  private publishedSignature = "";
  readonly onDidChangeTreeData = this.changed.event;

  setReviews(reviews: RegisteredReview[], activeRoot: string | undefined, sourceRoot: string): void {
    if (!sourceRoot) {
      this.reviewsBySource.clear();
      this.sourceRoot = "";
    } else {
      this.setSourceReviews(reviews, sourceRoot);
      this.sourceRoot = sourceRoot;
    }
    this.updateActiveRoot(activeRoot);
    this.publish();
  }

  /** Update one workspace without making reviews from other workspace roots disappear. */
  setWorkspaceReviews(reviews: RegisteredReview[], sourceRoot: string): void {
    this.setSourceReviews(reviews, sourceRoot);
    this.publish();
  }

  /** Atomically replace the multi-root workspace snapshot to avoid sidebar flicker. */
  setWorkspaceSnapshot(groups: readonly { sourceRoot: string; reviews: RegisteredReview[] }[], activeRoot: string | undefined): void {
    this.reviewsBySource.clear();
    for (const group of groups) this.setSourceReviews(group.reviews, group.sourceRoot);
    this.sourceRoot = groups.length === 1 ? groups[0].sourceRoot : "";
    this.activeRoot = activeRoot;
    this.publish();
  }

  retainWorkspaceRoots(sourceRoots: readonly string[]): void {
    const retained = new Set(sourceRoots.map((sourceRoot) => reviewPathKey(sourceRoot)));
    let changed = false;
    for (const key of this.reviewsBySource.keys()) {
      if (!retained.has(key)) {
        this.reviewsBySource.delete(key);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  removeReview(reviewRoot: string): void {
    let changed = false;
    for (const group of this.reviewsBySource.values()) {
      const retained = group.reviews.filter((review) => !sameReviewPath(review.reviewRoot, reviewRoot));
      if (retained.length !== group.reviews.length) {
        group.reviews = retained;
        changed = true;
      }
    }
    if (sameReviewPath(this.activeRoot, reviewRoot)) {
      this.activeRoot = undefined;
      changed = true;
    }
    if (changed) this.publish();
  }

  setActiveReview(activeRoot: string | undefined): void {
    if (sameReviewPath(this.activeRoot, activeRoot) || (!this.activeRoot && !activeRoot)) return;
    this.activeRoot = activeRoot;
    this.publish();
  }

  private updateActiveRoot(activeRoot: string | undefined): void {
    this.activeRoot = activeRoot;
  }

  private setSourceReviews(reviews: RegisteredReview[], sourceRoot: string): void {
    const unique = new Map<string, RegisteredReview>();
    for (const review of reviews) {
      const key = reviewPathKey(review.reviewRoot);
      if (!unique.has(key)) unique.set(key, { ...review, sourceRoot });
    }
    this.reviewsBySource.set(reviewPathKey(sourceRoot), { sourceRoot, reviews: [...unique.values()] });
  }

  private publish(): void {
    const combined = new Map<string, RegisteredReview>();
    for (const group of [...this.reviewsBySource.values()].sort((left, right) => left.sourceRoot.localeCompare(right.sourceRoot))) {
      for (const review of group.reviews) {
        const key = reviewPathKey(review.reviewRoot);
        if (!combined.has(key)) combined.set(key, review);
      }
    }
    this.reviews = [...combined.values()].sort((left, right) => left.manifest.title.localeCompare(right.manifest.title) || left.reviewRoot.localeCompare(right.reviewRoot));
    const signature = JSON.stringify({
      active: this.activeRoot ? reviewPathKey(this.activeRoot) : undefined,
      reviews: this.reviews.map((review) => [reviewPathKey(review.reviewRoot), review.manifest.reviewId, review.manifest.title, review.sourceRoot]),
    });
    if (signature === this.publishedSignature) return;
    this.publishedSignature = signature;
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
