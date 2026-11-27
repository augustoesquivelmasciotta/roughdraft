import fs from "node:fs";
import path from "node:path";
import type {
  ReviewCompletedEvent,
  ReviewDoneReason,
} from "./review-events.js";

type ReviewStatus =
  | {
      ok: true;
      at: string;
      event: "review.completed";
      // Same decision `roughdraft open --loop` reports, taken from the one
      // event, so a reader of this file and the CLI never disagree.
      done: boolean;
      doneReason: ReviewDoneReason | null;
    }
  | { ok: false; stage: string; cause: string; at: string };

/** `revisiones/foo.md` -> `revisiones/foo-status.json`. */
function reviewStatusPath(documentPath: string): string {
  const parsed = path.parse(documentPath);
  return path.join(parsed.dir, `${parsed.name}-status.json`);
}

// Why: a reader (a skill, the SP fork) polls this file and must never see a
// half-written one, so write a temp file and rename it over the target.
export function writeReviewStatus(
  documentPath: string,
  status: ReviewStatus,
): void {
  const target = reviewStatusPath(documentPath);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(status)}\n`);
    fs.renameSync(temp, target);
  } catch {
    // The status file is best effort: failing to write it must not break
    // the review flow it reports on.
    fs.rmSync(temp, { force: true });
  }
}

export function reviewSuccessStatus(
  event: Pick<ReviewCompletedEvent, "done" | "doneReason">,
): ReviewStatus {
  return {
    ok: true,
    at: new Date().toISOString(),
    event: "review.completed",
    done: event.done,
    doneReason: event.doneReason,
  };
}

export function reviewFailureStatus(
  stage: string,
  error: unknown,
): ReviewStatus {
  const cause = (error instanceof Error ? error.message : String(error))
    .split("\n")[0]
    .slice(0, 300);
  return { ok: false, stage, cause, at: new Date().toISOString() };
}
