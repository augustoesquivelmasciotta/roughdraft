import { describe, expect, it } from "vitest";
import {
  appendRoughdraftDocumentComment,
  appendRoughdraftReply,
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "./index";

// Reproduces a bug seen in real files: new comment ids reused ids that were
// already present in the document. Review ids are document-local and must be
// unique across the whole file: inline metadata, every YAML endmatter key
// (even one that no inline marker references), and the ids recorded under the
// optional `deleted:` endmatter list.

const message = "New feedback from the agent.";
const at = "2026-10-02T09:00:00.000Z";

const addNewComment = {
  appendRoughdraftDocumentComment: (markdown: string) =>
    appendRoughdraftDocumentComment(markdown, { message, author: "AI", at }),
  "appendRoughdraftReply to c1": (markdown: string) =>
    appendRoughdraftReply(markdown, {
      parentId: "c1",
      message,
      author: "AI",
      at,
    }),
};

const filesWithIdsInUse: Array<
  [usedBy: string, idsInUse: string[], markdown: string]
> = [
  [
    "a YAML endmatter entry that no inline marker references",
    ["c1", "c2"],
    [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-01T10:00:00.000Z"',
      "  c2:",
      "    by: user",
      '    at: "2026-10-01T10:05:00.000Z"',
      "",
    ].join("\n"),
  ],
  [
    "a deleted comment recorded in the YAML endmatter",
    ["c1", "c2"],
    [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-01T10:00:00.000Z"',
      "deleted:",
      "  - id: c2",
      "    by: user",
      '    at: "2026-10-01T10:05:00.000Z"',
      '    deletedAt: "2026-10-01T11:00:00.000Z"',
      '    body: "Original text of the deleted comment"',
      "",
    ].join("\n"),
  ],
  [
    "inline attribute metadata",
    ["c1", "c2"],
    [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      'Also check {==this figure==}{>>Older inline note.<<}{id="c2" by="user" at="2026-10-01T10:05:00.000Z"}.',
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: user",
      '    at: "2026-10-01T10:00:00.000Z"',
      "",
    ].join("\n"),
  ],
];

function idOfNewComment(markdown: string): string {
  const item = extractRoughdraftReviewIndex(markdown).items.find(
    (candidate) => candidate.text === message,
  );
  if (!item) {
    throw new Error("The new comment is missing from the review index.");
  }

  return item.id;
}

function diagnosticCodes(markdown: string): string[] {
  return validateRoughdraftMarkdown(markdown).diagnostics.map(
    (diagnostic) => diagnostic.code,
  );
}

describe.each(Object.entries(addNewComment))("%s", (_helper, addComment) => {
  it.each(
    filesWithIdsInUse,
  )("picks an id not already used by %s", (_usedBy, idsInUse, markdown) => {
    const updated = addComment(markdown);

    expect(idsInUse).not.toContain(idOfNewComment(updated));
    expect(diagnosticCodes(updated)).not.toContain("duplicate-id");
  });
});
