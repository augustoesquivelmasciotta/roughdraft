import { describe, expect, it } from "vitest";
import {
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "./index";

// RFM 0.2 lets one file mix metadata formats: these root comments use inline
// attribute blocks, while their replies live only in the final YAML endmatter.
const inlineRootsWithEndmatterReplies = [
  'First paragraph has {==an anchored claim==}{>>Needs a citation.<<}{id="c1" by="user" at="2026-10-01T10:00:00.000Z"}.',
  "",
  'Second paragraph has {==another claim==}{>>Is this still accurate?<<}{id="c2" by="user" at="2026-10-01T10:05:00.000Z"}.',
  "",
  "---",
  "comments:",
  "  c3:",
  "    body: I added a citation from the 2025 report.",
  "    by: AI",
  '    at: "2026-10-01T11:00:00.000Z"',
  "    re: c1",
  "  c4:",
  "    body: Yes, confirmed with the team.",
  "    by: user",
  '    at: "2026-10-01T11:05:00.000Z"',
  "    re: c2",
  "",
].join("\n");

describe("mixed metadata: inline attribute roots with YAML endmatter replies", () => {
  it("validates the endmatter replies against the inline root ids", () => {
    const result = validateRoughdraftMarkdown(inlineRootsWithEndmatterReplies);

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain("missing-reply-target");
    // Two inline roots plus two endmatter replies. A count of 2 means the
    // endmatter was skipped, which would make the checks above pass vacuously.
    expect(result.summary.comments).toBe(4);
  });

  it("indexes the endmatter replies under their inline root comments", () => {
    const index = extractRoughdraftReviewIndex(inlineRootsWithEndmatterReplies);

    expect(index.summary.replies).toBe(2);
    expect(
      index.items
        .filter((item) => item.kind === "reply")
        .map(({ id, parentId }) => ({ id, parentId })),
    ).toEqual([
      { id: "c3", parentId: "c1" },
      { id: "c4", parentId: "c2" },
    ]);
  });
});
