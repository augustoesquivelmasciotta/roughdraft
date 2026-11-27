import { describe, expect, it } from "vitest";
import { applyPendingReviewDecisionsToCriticMarkdown } from "../src/critic-markup";

// Approve on an agent reply (ported from kudzuweb/roughdraftplus #9) is the
// quick path to this fork's Resolve: on "I'm done" the thread the approved
// reply belongs to is resolved, and nothing else in the document changes.

const stacked = [
  "# Notes",
  "",
  'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}.',
  "",
  'Also {==this one==}{>>Too long<<}{id="c3" by="user" at="2024-01-15T10:32:00.000Z"}{>>Cut it in half.<<}{id="c4" by="AI" at="2024-01-15T10:33:00.000Z" re="c3"}.',
  "",
  "Untouched   paragraph with  odd spacing.",
  "",
].join("\n");

describe("applyPendingReviewDecisionsToCriticMarkdown", () => {
  it("resolves the thread of an approved agent reply and nothing else", () => {
    const saved = applyPendingReviewDecisionsToCriticMarkdown(stacked, {
      approvedCommentIds: ["c2"],
    });

    expect(saved).toContain(
      '{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z" status="resolved"}',
    );
    expect(saved).toContain("I can add one from the intro.");
    expect(saved).toContain(
      '{>>Too long<<}{id="c3" by="user" at="2024-01-15T10:32:00.000Z"}',
    );
    expect(saved).toContain("Untouched   paragraph with  odd spacing.");
  });

  it("leaves the document untouched when nothing applies", () => {
    expect(
      applyPendingReviewDecisionsToCriticMarkdown(stacked, {
        approvedCommentIds: [],
      }),
    ).toBe(stacked);
    expect(
      applyPendingReviewDecisionsToCriticMarkdown(stacked, {
        approvedCommentIds: ["missing"],
      }),
    ).toBe(stacked);
  });

  it("resolves a thread once when two of its replies are approved", () => {
    const twoReplies = stacked.replace(
      're="c1"}.',
      're="c1"}{>>Or the appendix.<<}{id="c5" by="AI" at="2024-01-15T10:34:00.000Z" re="c1"}.',
    );
    const saved = applyPendingReviewDecisionsToCriticMarkdown(twoReplies, {
      approvedCommentIds: ["c2", "c5"],
    });

    expect(saved.match(/status="resolved"/g)).toHaveLength(1);
    expect(saved).toContain("Or the appendix.");
  });
});

// Ported from kudzuweb/roughdraftplus #12 (PR #57): accepting, rejecting or
// editing a suggestion mark in the rail waits for "I'm done" too, and leaves
// plain prose with no thread behind.
describe("pending suggestion decisions applied to a Markdown string", () => {
  const insertion =
    'Keep {++clear wording++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"} here.\n';
  const substitution =
    'Use {~~old phrase~>new phrase~~}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"} here.\n';
  const apply = (
    markdown: string,
    changeDecisions: Parameters<
      typeof applyPendingReviewDecisionsToCriticMarkdown
    >[1]["changeDecisions"],
  ) =>
    applyPendingReviewDecisionsToCriticMarkdown(markdown, { changeDecisions });

  it("accepts an insertion into plain prose", () => {
    expect(apply(insertion, [{ changeId: "s1", action: "accept" }])).toBe(
      "Keep clear wording here.\n",
    );
  });

  it("rejects an insertion, dropping its text", () => {
    expect(apply(insertion, [{ changeId: "s1", action: "reject" }])).toBe(
      "Keep here.\n",
    );
  });

  it("edits an insertion into the reviewer's text as plain prose", () => {
    expect(
      apply(insertion, [
        { changeId: "s1", action: "edit", text: "crisp wording" },
      ]),
    ).toBe("Keep crisp wording here.\n");
  });

  it("accepts a substitution, leaving the new text", () => {
    expect(apply(substitution, [{ changeId: "s1", action: "accept" }])).toBe(
      "Use new phrase here.\n",
    );
  });

  it("rejects a substitution, restoring the old text", () => {
    expect(apply(substitution, [{ changeId: "s1", action: "reject" }])).toBe(
      "Use old phrase here.\n",
    );
  });

  it("edits a substitution into the reviewer's text", () => {
    expect(
      apply(substitution, [
        { changeId: "s1", action: "edit", text: "newer phrase" },
      ]),
    ).toBe("Use newer phrase here.\n");
  });

  it("keeps the mark's edge whitespace around edited text", () => {
    expect(
      apply(
        'Keep{++ clear wording ++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}here.\n',
        [{ changeId: "s1", action: "edit", text: "crisp" }],
      ),
    ).toBe("Keep crisp here.\n");
  });

  it("drops the suggestion's reply thread along with the mark", () => {
    const withReply =
      'Keep {++clear wording++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}{>>Looks right?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" re="s1"}{>>Yes.<<}{id="c2" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"} here.\n';

    expect(apply(withReply, [{ changeId: "s1", action: "accept" }])).toBe(
      "Keep clear wording here.\n",
    );
  });

  it("applies approvals and suggestion decisions in one pass and ignores ids that are not present", () => {
    const input = `${[
      'Keep {++clear wording++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"} here.',
      "",
      'And {==this==}{>>Why?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z"}{>>Because.<<}{id="c2" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"}.',
      "",
      "Untouched   spacing.",
    ].join("\n")}\n`;

    expect(
      applyPendingReviewDecisionsToCriticMarkdown(input, {
        approvedCommentIds: ["c2", "missing"],
        changeDecisions: [
          { changeId: "s1", action: "accept" },
          { changeId: "s9", action: "reject" },
        ],
      }),
    ).toBe(
      `${[
        "Keep clear wording here.",
        "",
        'And {==this==}{>>Why?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" status="resolved"}{>>Because.<<}{id="c2" by="AI" at="2024-01-15T10:32:00.000Z" re="c1"}.',
        "",
        "Untouched   spacing.",
      ].join("\n")}\n`,
    );
    expect(apply(input, [{ changeId: "s9", action: "accept" }])).toBe(input);
  });
});
