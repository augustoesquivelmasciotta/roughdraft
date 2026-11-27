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
