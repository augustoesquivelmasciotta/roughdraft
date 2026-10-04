import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  criticMarkdownToRenderedHtml,
  editorStateToCriticMarkdown,
} from "../src/critic-markup";
import {
  decodeRawMarkdownBlock,
  rawMarkdownBlockAttribute,
} from "../src/markdown";

// ADR 0003: every edit re-serializes the whole document, so content nobody
// touched must come back byte-for-byte. These tests protect that contract for
// realistic review documents (bug D) and for diffs that the review generator
// wraps in fences longer than three backticks (bug E).

function markdown(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function roundTrip(input: string): string {
  const { doc, comments } = criticMarkdownToEditorState(input);
  return editorStateToCriticMarkdown(doc, comments);
}

function findNodes(
  root: JSONContent,
  predicate: (node: JSONContent) => boolean,
): JSONContent[] {
  const found: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (predicate(node)) found.push(node);
    for (const child of node.content ?? []) visit(child);
  };
  visit(root);
  return found;
}

function nodeText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(nodeText).join("");
}

function renderedBody(input: string): HTMLElement {
  return new DOMParser().parseFromString(
    criticMarkdownToRenderedHtml(input).html,
    "text/html",
  ).body;
}

const verbatimBlockSelector = `pre, [${rawMarkdownBlockAttribute}]`;

// Text the reader sees verbatim: rendered code blocks, plus raw Markdown
// blocks (such as <details>) that the app keeps as untouched source.
function verbatimBlockTexts(body: HTMLElement): string[] {
  return [...body.querySelectorAll(verbatimBlockSelector)].map((element) =>
    element.matches("pre")
      ? (element.textContent ?? "")
      : decodeRawMarkdownBlock(
          element.getAttribute(rawMarkdownBlockAttribute) ?? "",
        ),
  );
}

function proseOutsideVerbatimBlocks(body: HTMLElement): string {
  const clone = body.cloneNode(true) as HTMLElement;
  for (const element of clone.querySelectorAll(verbatimBlockSelector)) {
    element.remove();
  }
  return clone.textContent ?? "";
}

const fenceRun = /`{3,}|~{3,}/;

const editedParagraph = "Ship the beta when the dashboards are green.";

const reviewDocument = markdown([
  "# Release review: sync engine",
  "",
  "This review covers the *sync engine* rewrite and the __rollout plan__ for the beta.",
  "",
  "## Checklist",
  "",
  "- Migrations are reversible",
  "- Feature flag defaults to off",
  "- Dashboards updated",
  "",
  "## Rollout steps",
  "",
  "- Enable the flag for internal users.",
  "",
  "  Watch the error rate for one hour before continuing.",
  "",
  "- Enable the flag for the beta cohort.",
  "",
  "## Commands",
  "",
  "```bash",
  "# Build the release artifacts",
  "",
  "pnpm build",
  "",
  "# Dry run first, then apply",
  "",
  "",
  "pnpm migrate --dry-run",
  "pnpm migrate",
  "```",
  "",
  "| Step | Owner | Status |",
  "| --- | --- | --- |",
  "| Build | Ana | Done |",
  "| Migrate | Luis | Pending |",
  "",
  "The migration steps follow the [runbook][runbook].",
  "",
  "---",
  "",
  'Please confirm the {==rollback window==}{>>Is 30 minutes enough for the largest tenant?<<}{id="c1" by="AI" at="2026-09-30T12:00:00.000Z"} before Friday.',
  "",
  "#### Open questions",
  "",
  "<!-- reviewer notes: keep this section short -->",
  "",
  "<details>",
  "<summary>Migration log</summary>",
  "",
  "Applied 12 migrations in 4.2s.",
  "",
  "</details>",
  "",
  editedParagraph,
  "",
  "[runbook]: https://example.com/runbook",
]);

describe("bug D: saving preserves Markdown nobody touched", () => {
  it("round-trips a realistic review document byte-for-byte", () => {
    expect(roundTrip(reviewDocument)).toBe(reviewDocument);
  });

  it("changes only the edited paragraph's line when one word is edited", () => {
    const { doc, comments } = criticMarkdownToEditorState(reviewDocument);
    const editedDoc = structuredClone(doc);
    const [paragraph] = findNodes(
      editedDoc,
      (node) => node.type === "paragraph" && nodeText(node) === editedParagraph,
    );
    const textNode = paragraph?.content?.find(
      (node) => node.type === "text" && node.text?.includes("green"),
    );
    if (!textNode?.text) {
      throw new Error(`Expected a paragraph node for "${editedParagraph}"`);
    }

    textNode.text = textNode.text.replace("green", "stable");

    const expectedLines = reviewDocument
      .split("\n")
      .map((line) =>
        line === editedParagraph
          ? "Ship the beta when the dashboards are stable."
          : line,
      );
    expect(
      editorStateToCriticMarkdown(editedDoc, comments).split("\n"),
    ).toEqual(expectedLines);
  });

  // The same constructs in isolation, so a failure names the construct.
  it.each<[string, string[]]>([
    ["a blank line after a heading", ["# Release review", "", "Body text."]],
    [
      "a tight list",
      ["- Migrations are reversible", "- Feature flag defaults to off"],
    ],
    [
      "a loose list item with a continuation paragraph",
      [
        "- Enable the flag for internal users.",
        "",
        "  Watch the error rate for one hour.",
        "",
        "- Enable the flag for the beta cohort.",
      ],
    ],
    [
      "blank lines around # comment lines inside a bash fence",
      [
        "```bash",
        "# Build the release artifacts",
        "",
        "pnpm build",
        "",
        "# Dry run first",
        "",
        "",
        "pnpm migrate --dry-run",
        "```",
      ],
    ],
    ["a table", ["| Step | Owner |", "| --- | --- |", "| Build | Ana |"]],
    [
      "a --- thematic break between paragraphs",
      ["Before the break.", "", "---", "", "After the break."],
    ],
    ["*asterisk* and __underscore__ emphasis", ["Use *this* and __that__."]],
    [
      "a reference-style link and its definition",
      [
        "Follow the [runbook][runbook].",
        "",
        "[runbook]: https://example.com/runbook",
      ],
    ],
    ["an #### H4 heading", ["#### Open questions"]],
    [
      "an HTML comment",
      ["Before.", "", "<!-- reviewer notes -->", "", "After."],
    ],
    [
      "a <details> block",
      [
        "<details>",
        "<summary>Migration log</summary>",
        "",
        "Applied 12 migrations.",
        "",
        "</details>",
      ],
    ],
    [
      "an anchored comment with inline attribute metadata",
      [
        'Confirm the {==rollback window==}{>>Is 30 minutes enough?<<}{id="c1" by="AI" at="2026-09-30T12:00:00.000Z"} today.',
      ],
    ],
  ])("keeps %s unchanged on save", (_construct, lines) => {
    const input = markdown(lines);

    expect(roundTrip(input)).toBe(input);
  });
});

// The " ```" context lines would close a three-backtick fence early, and the
// "</details>" lines must not end a surrounding <details> block.
const topLevelDiffLines = [
  "--- a/docs/setup.md",
  "+++ b/docs/setup.md",
  "@@ -3,10 +3,11 @@",
  " Install the CLI:",
  " ",
  "-```sh",
  "+```bash",
  " npm install -g roughdraft",
  " ```",
  " ",
  " <details>",
  " <summary>Troubleshooting</summary>",
  "-Restart the server.",
  "+Stop the server, then start it again.",
  " </details>",
  "+Top-level diff ends here.",
];

const nestedDiffLines = [
  "--- a/docs/faq.md",
  "+++ b/docs/faq.md",
  "@@ -1,7 +1,8 @@",
  " <details>",
  " <summary>Why Markdown?</summary>",
  " ",
  " ```text",
  " Plain text survives every tool.",
  " ```",
  " </details>",
  "+Nested diff ends here.",
];

const fenceDocument = markdown([
  "The generator wraps diffs that contain fences in a longer fence.",
  "",
  "````diff",
  ...topLevelDiffLines,
  "````",
  "",
  "<details>",
  "<summary>Nested diff</summary>",
  "",
  "````diff",
  ...nestedDiffLines,
  "````",
  "",
  "</details>",
  "",
  "~~~markdown",
  "```bash",
  "pnpm build",
  "```",
  "~~~",
  "",
  "Closing paragraph.",
]);

describe("bug E: fences longer than three backticks, and tilde fences", () => {
  it("round-trips 4-backtick diff fences and a ~~~ fence byte-for-byte", () => {
    expect(roundTrip(fenceDocument)).toBe(fenceDocument);
  });

  it("renders the top-level 4-backtick diff as one <pre> holding the whole diff", () => {
    const diffBlock = [
      ...renderedBody(fenceDocument).querySelectorAll("pre"),
    ].find((pre) => pre.textContent?.includes(topLevelDiffLines[0]));

    expect(diffBlock?.textContent).toBe(topLevelDiffLines.join("\n"));
  });

  it("keeps the 4-backtick diff nested in <details> whole in one verbatim block", () => {
    const holders = verbatimBlockTexts(renderedBody(fenceDocument)).filter(
      (text) => text.includes(nestedDiffLines[0]),
    );

    expect(holders).toHaveLength(1);
    expect(holders[0]).toContain(nestedDiffLines.join("\n"));
  });

  it("leaves no stray fence lines in rendered prose or editor paragraphs", () => {
    const { doc } = criticMarkdownToEditorState(fenceDocument);
    const strayParagraphs = findNodes(doc, (node) => node.type === "paragraph")
      .map(nodeText)
      .filter((text) => fenceRun.test(text));

    expect
      .soft(proseOutsideVerbatimBlocks(renderedBody(fenceDocument)))
      .not.toMatch(fenceRun);
    expect
      .soft(strayParagraphs, "editor paragraphs with fence runs")
      .toEqual([]);
  });

  it("keeps a 4-backtick diff fence and its info string when the diff is edited", () => {
    const diffBody = [
      "--- a/docs/setup.md",
      "+++ b/docs/setup.md",
      "@@ -3,6 +3,6 @@",
      " Install the CLI:",
      " ",
      "-```sh",
      "+```bash",
      " npm install -g roughdraft",
      " ```",
    ].join("\n");
    const input = markdown([
      "The generator wrapped this diff in a longer fence.",
      "",
      "````diff",
      diffBody,
      "````",
    ]);
    const { doc, comments } = criticMarkdownToEditorState(input);
    const editedDoc = structuredClone(doc);
    const [codeBlock] = findNodes(
      editedDoc,
      (node) => node.type === "codeBlock" && node.attrs?.language === "diff",
    );
    if (!codeBlock) throw new Error("Expected a diff code block");
    expect(nodeText(codeBlock), "parsed diff body").toBe(diffBody);

    const editedText = `${diffBody}\n+Appended during review.`;
    codeBlock.content = [{ type: "text", text: editedText }];
    const saved = editorStateToCriticMarkdown(editedDoc, comments);
    const [reparsedBlock] = findNodes(
      criticMarkdownToEditorState(saved).doc,
      (node) => node.type === "codeBlock",
    );

    expect.soft(saved).toMatch(/^`{4,}diff$/m);
    expect
      .soft(reparsedBlock && nodeText(reparsedBlock), "re-read diff body")
      .toBe(editedText);
  });

  it.each<[string, string[]]>([
    [
      "at top level",
      [
        "````diff",
        " ```md",
        "-This is {--deleted--} text.",
        "+This is {++inserted++} text.",
        "+This is {~~old~>new~~} substituted text.",
        "+A margin note.{>>literal comment example<<}",
        " ```",
        "````",
      ],
    ],
    [
      "nested in <details>",
      [
        "<details>",
        "<summary>Patch with review markup</summary>",
        "",
        "````diff",
        " ```md",
        " </details>",
        " ",
        "+This is {++inserted++} text.",
        "+A margin note.{>>literal comment example<<}",
        " ```",
        "````",
        "",
        "</details>",
      ],
    ],
  ])("does not show the review rail for CriticMarkup only inside a 4-backtick diff fence %s", (_placement, lines) => {
    expect(criticMarkdownHasReviewRail(markdown(lines))).toBe(false);
  });
});
