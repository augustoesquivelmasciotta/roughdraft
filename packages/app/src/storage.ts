export interface Page {
  id: string;
  title: string;
  content: string;
  version?: string;
}

export interface MarkdownFileChangeEvent {
  path: string;
  exists: boolean;
  version: string | null;
}

export class MarkdownFileConflictError extends Error {
  current: Page;

  constructor(current: Page) {
    super("Markdown file changed on disk");
    this.name = "MarkdownFileConflictError";
    this.current = current;
  }
}

export interface StoredAsset {
  markdownPath: string;
  previewUrl: string;
  mimeType: string;
}

export interface CompleteReviewResult {
  delivered: boolean;
}

export interface CompleteReviewOptions {
  overallComment?: string;
  // Aborted when the handoff gives up, so a late request is never delivered.
  signal?: AbortSignal;
}

// Why: a request queued behind a full browser connection pool never settles,
// and "I'm done" then showed "Sending" forever. Past this, the handoff fails
// visibly instead.
export const REVIEW_HANDOFF_TIMEOUT_MS = 10_000;

export interface ReviewWatchStatus {
  watching: boolean;
  watcherCount: number;
}

export interface BackendInfo {
  kind: "local-files" | "local-storage" | "remote";
  label: string;
  detail: string;
  projectPath?: string;
  sessionId?: string;
  originPath?: string;
}

export interface StorageBackend {
  info: BackendInfo;
  canManageProjects: boolean;
  getMarkdownFile(relativePath: string): Promise<Page>;
  saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
  ): Promise<Page | undefined>;
  watchMarkdownFile?(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void;
  completeReview?(
    relativePath: string,
    options?: CompleteReviewOptions,
  ): Promise<CompleteReviewResult>;
  getReviewWatchStatus?(relativePath: string): Promise<ReviewWatchStatus>;
  /**
   * Closes the Orca browser tab showing `pageUrl`. Orca tabs ignore
   * `window.close()`, so the page asks the local server to do it. Resolves
   * false when no single Orca tab shows the page.
   */
  closeOrcaTab?(pageUrl: string): Promise<boolean>;
  saveAsset(file: File): Promise<StoredAsset>;
  resolveFileUrl(path: string): string | null;
  openProject(path: string): Promise<void>;
}
