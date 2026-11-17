import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface ReviewRoundSnapshot {
  documentPath: string;
  content: string;
  startedAt: string;
}

/**
 * The document as it was when the current review round started: when it was
 * first opened in a review, or right after the last `review.completed`,
 * whichever is later. Kept in memory and as a copy under the server's state
 * dir, so a server restart keeps it.
 */
export class ReviewRoundStore {
  private snapshots = new Map<string, ReviewRoundSnapshot>();

  constructor(private readonly dir: string) {}

  /** The snapshot, taking `currentContent` as the round start when none exists. */
  ensure(documentPath: string, currentContent: string): ReviewRoundSnapshot {
    const existing = this.get(documentPath);
    if (existing) return existing;
    return this.reset(documentPath, currentContent);
  }

  get(documentPath: string): ReviewRoundSnapshot | null {
    const key = normalize(documentPath);
    const cached = this.snapshots.get(key);
    if (cached) return cached;

    const fromDisk = this.readFromDisk(key);
    if (fromDisk) this.snapshots.set(key, fromDisk);
    return fromDisk;
  }

  /** Starts a new round from `content`. */
  reset(documentPath: string, content: string): ReviewRoundSnapshot {
    const key = normalize(documentPath);
    const snapshot: ReviewRoundSnapshot = {
      documentPath: key,
      content,
      startedAt: new Date().toISOString(),
    };
    this.snapshots.set(key, snapshot);
    this.writeToDisk(key, snapshot);
    return snapshot;
  }

  private fileFor(key: string): string {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    return path.join(this.dir, `${hash.slice(0, 32)}.json`);
  }

  private readFromDisk(key: string): ReviewRoundSnapshot | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(key), "utf-8"));
      if (
        parsed &&
        typeof parsed.content === "string" &&
        typeof parsed.startedAt === "string"
      ) {
        return {
          documentPath: key,
          content: parsed.content,
          startedAt: parsed.startedAt,
        };
      }
    } catch {
      // No copy, or an unreadable one: the next open starts a fresh round.
    }
    return null;
  }

  private writeToDisk(key: string, snapshot: ReviewRoundSnapshot): void {
    const target = this.fileFor(key);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(snapshot));
      fs.renameSync(temp, target);
    } catch {
      // The in-memory snapshot still works; only restart survival is lost.
      fs.rmSync(temp, { force: true });
    }
  }
}

function normalize(documentPath: string): string {
  return path.resolve(documentPath).normalize("NFC");
}
