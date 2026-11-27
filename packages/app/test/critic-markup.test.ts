import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import {
  type CriticComment,
  createCriticChange,
  createNextChangeId,
  createNextCommentId,
  criticMarkdownHasReviewRail,
  criticMarkdownToEditorState,
  criticMarkdownToRenderedHtml,
  editorStateToCriticMarkdown,
  getCommentDescendantIds,
} from "../src/critic-markup";
import { createEditorExtensions } from "../src/editor-extensions";

function readMarkdownFixture(name: string): string {
  return `${fs
    .readFileSync(
      path.join(process.cwd(), "test", "fixtures", "markdown", name),
      "utf8",
    )
    .trimEnd()}\n`;
}

describe("CriticMarkup comments", () => {
  it("preserves YAML frontmatter delimiters and raw table-like YAML text", () => {
    const input = [
      "---",
      "title: Frontmatter round trip",
      "summary: |",
      "  | column | value |",
      "  | --- | --- |",
      "  | path | docs/table.md |",
      "tags:",
      "  - roughdraft",
      "---",
      "",
      "# Body",
      "Opening this file in rich text should not rewrite frontmatter.",
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("detects review rail content without counting fenced examples", () => {
    expect(
      criticMarkdownHasReviewRail(
        [
          "```md",
          "This is {--deleted--} text.",
          "This is {++inserted++} text.",
          "This is {~~old~>new~~} substituted text.",
          "This is {>>a comment<<} in the margin.",
          "```",
        ].join("\n"),
      ),
    ).toBe(false);
    expect(
      criticMarkdownHasReviewRail(
        [
          "<details>",
          "<summary>Literal examples</summary>",
          "",
          '{==example==}{>>literal HTML comment example<<}{id="c60" by="AI" at="2026-05-24T18:50:00.000Z"}',
          "",
          "</details>",
          "",
        ].join("\n"),
      ),
    ).toBe(false);

    expect(
      criticMarkdownHasReviewRail(
        'This is {==anchored text==}{>>a threaded comment<<}{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}.\n',
      ),
    ).toBe(true);
    expect(criticMarkdownHasReviewRail("This is {++inserted++} text.\n")).toBe(
      true,
    );
  });

  it("round-trips a highlighted comment anchor", () => {
    const input =
      'This is {==highlighted==}{>>comment text<<}{id="cmt1" by="AI" at="2024-01-15T10:30:00.000Z"} text.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("cmt1")).toMatchObject({
      id: "cmt1",
      content: "comment text",
      authorType: "ai",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("renders YAML endmatter-backed root comments and replies", () => {
    const input = [
      "This is {==highlighted==}{>>comment text<<}{#c1} text.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: AI",
      '    at: "2024-01-15T10:30:00.000Z"',
      "  c2:",
      "    body: Reply text",
      "    by: user",
      '    at: "2024-01-15T10:31:00.000Z"',
      "    re: c1",
      "",
    ].join("\n");

    const { doc, comments, endmatter } = criticMarkdownToEditorState(input);

    expect(endmatter).toContain("comments:");
    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "comment text",
      authorType: "ai",
    });
    expect(comments.get("c2")).toMatchObject({
      id: "c2",
      content: "Reply text",
      parentCommentId: "c1",
    });
    const output = editorStateToCriticMarkdown(doc, comments);
    expect(output).toContain("{==highlighted==}{>>comment text<<}{#c1}");
    expect(output).toContain("body: Reply text");
    expect(output).toContain("re: c1");
  });

  it("does not treat horizontal rules and fenced YAML examples as review endmatter", () => {
    const input = [
      "# Markdown examples",
      "",
      "A normal horizontal rule follows.",
      "",
      "---",
      "",
      "```yaml",
      "comments:",
      "  c1:",
      "    body: This is documentation, not review metadata.",
      "suggestions:",
      "  s1:",
      "    by: AI",
      "```",
      "",
    ].join("\n");

    const { doc, comments, endmatter } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(endmatter).toBeNull();
    expect(comments.size).toBe(0);
    expect(output).toBe(input);
    expect(output).toContain("```yaml");
    expect(output).toContain("comments:");
    expect(output).toContain("suggestions:");
    expect(output).toContain("This is documentation, not review metadata.");
  });

  it("does not treat ordinary final comments sections as review endmatter", () => {
    const input = [
      "# Release notes",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: docs",
      '    at: "not review metadata"',
      "",
    ].join("\n");

    const { doc, comments, endmatter } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(endmatter).toBeNull();
    expect(comments.size).toBe(0);
    expect(output).toContain("comments:");
    expect(output).toContain("not review metadata");
  });

  it("writes YAML metadata for new suggestions in endmatter-backed documents", () => {
    const input = [
      "Replace {++draft++}{#s1}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:00:00.000Z"',
      "",
    ].join("\n");
    const parsed = criticMarkdownToEditorState(input);
    const nextDoc = structuredClone(parsed.doc);
    const paragraph = nextDoc.content?.[0];

    paragraph?.content?.push(
      { type: "text", text: " Add " },
      {
        type: "text",
        text: "specifics",
        marks: [
          {
            type: "criticChange",
            attrs: createCriticChange("addition", {
              changeId: "s2",
              createdAt: "2026-05-24T11:00:00.000Z",
              authorType: "user",
              authorId: "user",
            }),
          },
        ],
      },
      { type: "text", text: "." },
    );

    const output = editorStateToCriticMarkdown(nextDoc, parsed.comments);

    expect(output).toContain("{++specifics++}{#s2}");
    expect(output).toContain("suggestions:");
    expect(output).toContain("s1:");
    expect(output).toContain("s2:");
    expect(output).toContain("at: 2026-05-24T11:00:00.000Z");
  });

  it("removes deleted comments and replies from YAML endmatter", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "  c2:",
      "    body: I can soften this.",
      "    by: AI",
      '    at: "2026-05-24T10:46:00.000Z"',
      "    re: c1",
      "  c3:",
      "    body: Stale reply.",
      "    by: AI",
      '    at: "2026-05-24T10:47:00.000Z"',
      "    re: c1",
      "",
    ].join("\n");
    const { doc, comments } = criticMarkdownToEditorState(input);
    const nextComments = new Map(comments);

    nextComments.delete("c2");
    nextComments.delete("c3");

    const output = editorStateToCriticMarkdown(doc, nextComments);

    expect(output).toContain("comments:");
    expect(output).toContain("c1:");
    expect(output).not.toContain("c2:");
    expect(output).not.toContain("c3:");
    expect(output).not.toContain("I can soften this.");
    expect(output).not.toContain("Stale reply.");
  });

  it("preserves unknown top-level YAML endmatter keys on save", () => {
    const input = [
      "Please revisit {==this claim==}{>>Needs a source.<<}{#c1}.",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "workflow:",
      "  owner: editorial",
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toContain("workflow:");
    expect(output).toContain("owner: editorial");
  });

  it("renders YAML endmatter-backed unanchored comments", () => {
    const input = [
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
      "",
      "---",
      "comments:",
      "  c3:",
      "    by: user",
      '    at: "2026-05-24T17:00:00.000Z"',
      "",
    ].join("\n");

    expect(criticMarkdownHasReviewRail(input)).toBe(true);

    const { html, comments } = criticMarkdownToRenderedHtml(input);
    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      content:
        "Consider whether this belongs in the executive summary instead.",
      authorType: "user",
      createdAt: "2026-05-24T17:00:00.000Z",
    });
    expect(html).toContain('data-comment-ids="[&quot;c3&quot;]"');
    expect(html).toContain('data-comment-anchorless="true"');
    expect(html).not.toContain("{&gt;&gt;Consider whether");
    expect(output).toContain(
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
    );
    expect(output).not.toContain("{==\u2060==}");
  });

  it("renders and preserves YAML endmatter-backed document-level comments", () => {
    const input = [
      "# Draft",
      "",
      "---",
      "comments:",
      "  c1:",
      "    body: Please address the risk section.",
      "    by: user",
      '    at: "2026-05-24T12:00:00.000Z"',
      "",
    ].join("\n");

    expect(criticMarkdownHasReviewRail(input)).toBe(true);

    const parsed = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(parsed.doc, parsed.comments);

    expect(parsed.comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Please address the risk section.",
      authorType: "user",
      createdAt: "2026-05-24T12:00:00.000Z",
      parentCommentId: null,
      scope: "document",
    });
    expect(output).toContain("comments:");
    expect(output).toContain("  c1:");
    expect(output).toContain("    body: Please address the risk section.");
    expect(output).not.toContain("{#c1}");
  });

  it("reserves YAML endmatter-backed unanchored comment ids for new replies", () => {
    const input = [
      "Please revisit {==this claim==}{>>This needs a source.<<}{#c1}.",
      "",
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
      "",
      "---",
      "comments:",
      "  c1:",
      "    by: Nora",
      '    at: "2026-05-24T10:45:00.000Z"',
      "  c2:",
      "    body: I can soften the claim if we do not have a citation.",
      "    by: AI",
      '    at: "2026-05-24T10:46:00.000Z"',
      "    re: c1",
      "  c3:",
      "    by: user",
      '    at: "2026-05-24T17:00:00.000Z"',
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:48:00.000Z"',
      "",
    ].join("\n");

    const { comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      content:
        "Consider whether this belongs in the executive summary instead.",
      parentCommentId: null,
    });
    expect(createNextCommentId(comments.values())).toBe("c4");
  });

  it("repairs stale YAML reply metadata when an inline root comment id was reused", () => {
    const input = [
      "Add {++one concrete customer example++}{#s1}.",
      "",
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
      "",
      "---",
      "comments:",
      "  c3:",
      "    by: user",
      '    at: "2026-05-24T17:38:55.763Z"',
      "    body: reply to suggestion",
      "    re: s1",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2026-05-24T10:48:00.000Z"',
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      content:
        "Consider whether this belongs in the executive summary instead.",
      parentCommentId: null,
    });
    expect(output).toContain(
      "This paragraph has an unanchored note.{>>Consider whether this belongs in the executive summary instead.<<}{#c3}",
    );
    expect(output).not.toContain("body: reply to suggestion");
    expect(output).not.toContain("re: s1");
    expect(createNextCommentId(comments.values())).toBe("c4");
  });

  it("renders YAML endmatter-backed suggestions", () => {
    const input = [
      "Add {++one concrete example++}{#s1}.",
      "",
      "---",
      "suggestions:",
      "  s1:",
      "    by: AI",
      '    at: "2024-01-15T10:30:00.000Z"',
      "",
    ].join("\n");

    const { changes } = criticMarkdownToRenderedHtml(input);

    expect(changes.get("s1")).toMatchObject({
      changeId: "s1",
      authorType: "ai",
      createdAt: "2024-01-15T10:30:00.000Z",
    });
  });

  it("preserves formatting nested inside a comment anchor", () => {
    const input =
      'The {==**important**==}{>>Review this phrasing<<}{id="cmt2" by="user@example.com" at="2024-01-15T10:31:00.000Z"} section stays bold.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves inline code nested inside a comment anchor", () => {
    const input =
      'Check {==`roughdraft open`==}{>>Make sure this command is visible<<}{id="cmt-code" by="user" at="2024-01-15T10:31:00.000Z"} before sharing.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);
    const paragraph = doc.content?.[0];
    const codeNode = paragraph?.content?.[1];

    expect(codeNode).toMatchObject({
      type: "text",
      text: "roughdraft open",
      marks: expect.arrayContaining([
        expect.objectContaining({
          type: "commentRef",
          attrs: expect.objectContaining({ commentIds: ["cmt-code"] }),
        }),
        expect.objectContaining({ type: "code" }),
      ]),
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("creates one comment anchor when a selection spans inline code", () => {
    const input =
      "Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening works.\n";
    const { doc } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      const text = editor.state.doc.textBetween(
        0,
        editor.state.doc.content.size,
        "\n",
      );
      const start = text.indexOf("its own server state under");
      const end = text.indexOf(" by default") + " by default".length;

      editor.commands.setTextSelection({ from: start + 1, to: end + 1 });
      editor.commands.setCommentRef({ commentIds: ["c1"] });

      expect(
        editorStateToCriticMarkdown(
          editor.getJSON(),
          new Map([
            [
              "c1",
              {
                id: "c1",
                content: "test",
                createdAt: "2026-04-25T21:54:47.475Z",
              },
            ],
          ]),
        ),
      ).toBe(
        'Each dev wrapper keeps {==its own server state under `~/.roughdraft/dev/<wrapper-name>` by default==}{>>test<<}{id="c1" by="user" at="2026-04-25T21:54:47.475Z"}, so opening works.\n',
      );
    } finally {
      editor.destroy();
    }
  });

  it("keeps the anchor attached when nearby text changes", () => {
    const input =
      'Before {==target==}{>>Check this<<}{id="cmt3" by="AI" at="2024-01-15T10:32:00.000Z"} after.\n';
    const { doc, comments } = criticMarkdownToEditorState(input);
    const nextDoc = structuredClone(doc);
    const firstParagraph = nextDoc.content?.[0];
    const firstTextNode = firstParagraph?.content?.[0];

    if (firstTextNode?.type !== "text") {
      throw new Error("Expected leading text node in parsed paragraph");
    }

    firstTextNode.text = "Before nearby ";

    expect(editorStateToCriticMarkdown(nextDoc, comments)).toBe(
      'Before nearby {==target==}{>>Check this<<}{id="cmt3" by="AI" at="2024-01-15T10:32:00.000Z"} after.\n',
    );
  });

  it("round-trips comments inside list items and headings", () => {
    const input = `## Sprint Notes

* First item
* {==Second item==}{>>Needs review<<}{id="cmt4" by="AI" at="2024-01-15T10:33:00.000Z"}
`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    // Untouched blocks keep their original markdown, including `*` bullets.
    expect(output).toBe(input);
    expect(comments.get("cmt4")).toMatchObject({ content: "Needs review" });
  });

  it("does not import a trailing blank line into fenced code blocks", () => {
    const input = `\`\`\`text
Use Roughdraft when I want to open, review, comment on, or compare markdown files.

Start it with \`roughdraft start\` if needed.
Open files or folders with \`roughdraft open "/absolute/path/to/file.md"\`.
After I finish reviewing in Roughdraft, continue by reading the markdown files from disk and making the requested changes there.
Use CriticMarkup for inline review feedback in markdown.
\`\`\`
`;

    const { doc } = criticMarkdownToEditorState(input);
    const codeBlock = doc.content?.[0];
    const textNode = codeBlock?.content?.[0];

    expect(codeBlock?.type).toBe("codeBlock");
    expect(textNode).toMatchObject({
      type: "text",
      text: `Use Roughdraft when I want to open, review, comment on, or compare markdown files.

Start it with \`roughdraft start\` if needed.
Open files or folders with \`roughdraft open "/absolute/path/to/file.md"\`.
After I finish reviewing in Roughdraft, continue by reading the markdown files from disk and making the requested changes there.
Use CriticMarkup for inline review feedback in markdown.`,
    });
    expect(editorStateToCriticMarkdown(doc, new Map())).toBe(input);
  });

  it("creates a comment anchor when a selection is inside a fenced code block", () => {
    const input = `\`\`\`ts
const command = "roughdraft open";
\`\`\`
`;
    const { doc } = criticMarkdownToEditorState(input);
    const editor = new Editor({
      extensions: createEditorExtensions(""),
      content: doc,
    });

    try {
      const text = editor.state.doc.textBetween(
        0,
        editor.state.doc.content.size,
        "\n",
      );
      const start = text.indexOf("roughdraft open");
      const end = start + "roughdraft open".length;

      editor.commands.setTextSelection({ from: start + 1, to: end + 1 });
      const added = editor.commands.setCommentRef({ commentIds: ["c1"] });

      expect(added).toBe(true);
      expect(editor.getJSON().content?.[0]).toMatchObject({
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [
          {
            type: "text",
            text: 'const command = "',
          },
          {
            type: "text",
            text: "roughdraft open",
            marks: [
              {
                type: "commentRef",
                attrs: { commentIds: ["c1"] },
              },
            ],
          },
          {
            type: "text",
            text: '";',
          },
        ],
      });
      expect(
        editorStateToCriticMarkdown(
          editor.getJSON(),
          new Map([
            [
              "c1",
              {
                id: "c1",
                content: "test",
                createdAt: "2026-04-25T22:14:08.827Z",
              },
            ],
          ]),
        ),
      ).toBe(`\`\`\`ts
const command = "{==roughdraft open==}{>>test<<}{id="c1" by="user" at="2026-04-25T22:14:08.827Z"}";
\`\`\`
`);
    } finally {
      editor.destroy();
    }
  });

  it("round-trips comment anchors inside fenced code blocks", () => {
    const input = `\`\`\`ts
const command = "{==roughdraft open==}{>>test<<}{id="c1" by="user" at="2026-04-25T22:14:08.827Z"}";
\`\`\`
`;

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(doc.content?.[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [
        {
          type: "text",
          text: 'const command = "',
        },
        {
          type: "text",
          text: "roughdraft open",
          marks: [
            {
              type: "commentRef",
              attrs: { commentIds: ["c1"] },
            },
          ],
        },
        {
          type: "text",
          text: '";',
        },
      ],
    });
    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "test",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips an anchored reply thread", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c2")).toMatchObject({
      id: "c2",
      parentCommentId: "c1",
      authorType: "ai",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips nested replies in preorder", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}{>>I can add one from the intro.<<}{id="c2" by="AI" at="2024-01-15T10:31:00.000Z" re="c1"}{>>Use the market report too.<<}{id="c3" by="user" at="2024-01-15T10:32:00.000Z" re="c2"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c3")).toMatchObject({
      id: "c3",
      parentCommentId: "c2",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("migrates legacy metadata to attribute metadata on save", () => {
    const input =
      "Please revisit {==this sentence==}{>>Needs a source<<}{@id:c1;by:user;at:2024-01-15T10:30:00.000Z@}.\n";

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Needs a source",
      authorType: "user",
      authorId: "user",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2024-01-15T10:30:00.000Z"}.\n',
    );
  });

  it("round-trips escaped attribute metadata values", () => {
    const input =
      'Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user\\\\\\"name" at="2024-01-15T10:30:00.000Z"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      authorId: 'user\\"name',
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it.each([
    "criticmarkup-basic.md",
    "criticmarkup-code-fences.md",
    "frontmatter-table-yaml.md",
    "mixed-roundtrip.md",
  ])("round-trips markdown fixture %s", (fixtureName) => {
    const input = readMarkdownFixture(fixtureName);
    const { doc, comments, frontmatter } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments, { frontmatter })).toBe(
      input,
    );
  });

  it("keeps unanchored CriticMarkup examples literal in code spans and fenced code", () => {
    const input = readMarkdownFixture("criticmarkup-code-fences.md");
    const { doc, comments, frontmatter } = criticMarkdownToEditorState(input);

    expect(comments.size).toBe(0);
    expect(editorStateToCriticMarkdown(doc, comments, { frontmatter })).toBe(
      input,
    );
  });

  it("allocates simple document-local ids", () => {
    expect(
      createNextCommentId([{ id: "c2" }, { id: "note-1" }, { id: "c7" }]),
    ).toBe("c8");
  });

  it("allocates simple document-local suggestion ids", () => {
    expect(
      createNextChangeId([
        { changeId: "s2" },
        { changeId: "suggestion-1" },
        { changeId: "s7" },
      ]),
    ).toBe("s8");
  });

  it("round-trips an insertion suggestion with metadata", () => {
    const input =
      'Add {++new text++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a deletion suggestion with metadata", () => {
    const input =
      'Remove {--old text--}{id="s2" by="AI" at="2024-01-15T10:31:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a substitution suggestion with metadata", () => {
    const input =
      'Use {~~old text~>new text~~}{id="s3" by="user@example.com" at="2024-01-15T10:32:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a substitution suggestion with an attached comment", () => {
    const input =
      'Use {~~old text~>new text~~}{id="s3" by="AI" at="2024-01-15T10:32:00.000Z"}{>>Confirm this with legal.<<}{id="c1" by="user" at="2024-01-15T10:33:00.000Z" re="s3"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      id: "c1",
      content: "Confirm this with legal.",
      parentCommentId: "s3",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("renders review markup to HTML with comments and changes", () => {
    const input =
      'Keep {==the launch date==}{>>Verify this.<<}{id="c1" by="user" at="2024-01-15T10:33:00.000Z"} and add {++the customer quote++}{id="s1" by="AI" at="2024-01-15T10:34:00.000Z"}.\n';

    const { html, comments, changes, frontmatter } =
      criticMarkdownToRenderedHtml(input);

    expect(frontmatter).toBeNull();
    expect(comments.get("c1")?.content).toBe("Verify this.");
    expect(changes.get("s1")).toMatchObject({
      changeId: "s1",
      kind: "addition",
      authorType: "ai",
    });
    expect(html).toContain('data-comment-ids="[&quot;c1&quot;]"');
    expect(html).toContain('data-critic-change-kind="addition"');
  });

  it("imports suggestions without metadata and serializes generated metadata", () => {
    const { doc, comments } = criticMarkdownToEditorState(
      "Add {++new text++} here.\n",
    );

    expect(editorStateToCriticMarkdown(doc, comments)).toMatch(
      /^Add \{\+\+new text\+\+\}\{id="s1" by="user" at="[^"]+"\} here\.\n$/,
    );
  });

  it("preserves Markdown formatting inside suggested changes", () => {
    const input =
      'Use {++**bold** and `code`++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves suggested changes next to comments", () => {
    const input =
      'Add {++new text++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} near {==this==}{>>Check it<<}{id="c1" by="AI" at="2024-01-15T10:31:00.000Z"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a comment whose parent points to a suggestion id", () => {
    const input =
      '{==New wording==}{>>Why this wording?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" re="s1"} follows {++new text++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}.\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      parentCommentId: "s1",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("round-trips a comment attached directly to a suggestion", () => {
    const input =
      '{++new text++}{id="s1" by="AI" at="2024-01-15T10:30:00.000Z"}{>>Why this wording?<<}{id="c1" by="user" at="2024-01-15T10:31:00.000Z" re="s1"}\n';

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      parentCommentId: "s1",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("preserves suggested changes in headings and list items", () => {
    const input = `## Use {++new title++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"}

* Keep {--old item--}{id="s2" by="user" at="2024-01-15T10:31:00.000Z"}
`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const output = editorStateToCriticMarkdown(doc, comments);

    expect(output).toContain(
      '## Use {++new title++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"}',
    );
    // Untouched blocks keep their original markdown, including `*` bullets.
    expect(output).toContain(
      '* Keep {--old item--}{id="s2" by="user" at="2024-01-15T10:31:00.000Z"}',
    );
  });

  it("accepts and rejects insertion suggestions", () => {
    const input =
      'Add {++new text++}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';
    const accepted = criticMarkdownToEditorState(input);
    const rejected = criticMarkdownToEditorState(input);
    const acceptEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: accepted.doc,
    });
    const rejectEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: rejected.doc,
    });

    try {
      acceptEditor.commands.acceptCriticChange("s1");
      rejectEditor.commands.rejectCriticChange("s1");

      expect(
        editorStateToCriticMarkdown(acceptEditor.getJSON(), accepted.comments),
      ).toBe("Add new text here.\n");
      expect(
        editorStateToCriticMarkdown(rejectEditor.getJSON(), rejected.comments),
      ).toBe("Add here.\n");
    } finally {
      acceptEditor.destroy();
      rejectEditor.destroy();
    }
  });

  it("accepts and rejects deletion suggestions", () => {
    const input =
      'Remove {--old text--}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';
    const accepted = criticMarkdownToEditorState(input);
    const rejected = criticMarkdownToEditorState(input);
    const acceptEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: accepted.doc,
    });
    const rejectEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: rejected.doc,
    });

    try {
      acceptEditor.commands.acceptCriticChange("s1");
      rejectEditor.commands.rejectCriticChange("s1");

      expect(
        editorStateToCriticMarkdown(acceptEditor.getJSON(), accepted.comments),
      ).toBe("Remove here.\n");
      expect(
        editorStateToCriticMarkdown(rejectEditor.getJSON(), rejected.comments),
      ).toBe("Remove old text here.\n");
    } finally {
      acceptEditor.destroy();
      rejectEditor.destroy();
    }
  });

  it("accepts and rejects substitution suggestions", () => {
    const input =
      'Use {~~old~>new~~}{id="s1" by="user" at="2024-01-15T10:30:00.000Z"} here.\n';
    const accepted = criticMarkdownToEditorState(input);
    const rejected = criticMarkdownToEditorState(input);
    const acceptEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: accepted.doc,
    });
    const rejectEditor = new Editor({
      extensions: createEditorExtensions(""),
      content: rejected.doc,
    });

    try {
      acceptEditor.commands.acceptCriticChange("s1");
      rejectEditor.commands.rejectCriticChange("s1");

      expect(
        editorStateToCriticMarkdown(acceptEditor.getJSON(), accepted.comments),
      ).toBe("Use new here.\n");
      expect(
        editorStateToCriticMarkdown(rejectEditor.getJSON(), rejected.comments),
      ).toBe("Use old here.\n");
    } finally {
      acceptEditor.destroy();
      rejectEditor.destroy();
    }
  });

  it("creates critic change attrs with document-local metadata", () => {
    expect(
      createCriticChange("addition", undefined, {
        existingChanges: [{ changeId: "s1" }],
      }),
    ).toMatchObject({
      kind: "addition",
      changeId: "s2",
      authorType: "user",
      authorId: "user",
    });
  });

  it("collects descendants in nested reply order", () => {
    const comments = new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Root",
          createdAt: "2024-01-15T10:30:00.000Z",
        },
      ],
      [
        "c2",
        {
          id: "c2",
          content: "Reply",
          createdAt: "2024-01-15T10:31:00.000Z",
          parentCommentId: "c1",
        },
      ],
      [
        "c3",
        {
          id: "c3",
          content: "Nested reply",
          createdAt: "2024-01-15T10:32:00.000Z",
          parentCommentId: "c2",
        },
      ],
      [
        "c4",
        {
          id: "c4",
          content: "Sibling reply",
          createdAt: "2024-01-15T10:33:00.000Z",
          parentCommentId: "c1",
        },
      ],
    ]);

    expect(getCommentDescendantIds("c1", comments)).toEqual(["c2", "c3", "c4"]);
  });
});

function richTextRoundTrip(markdown: string): string {
  const { doc, comments, frontmatter } = criticMarkdownToEditorState(markdown);
  return editorStateToCriticMarkdown(doc, comments, { frontmatter });
}

describe("Markdown rich-text round-trip regressions", () => {
  it("preserves GFM strikethrough markup", () => {
    const input = "Keep ~~removed~~ and **bold** text.\n";

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves inline link titles", () => {
    const input = '[Roughdraft](./README.md "Local title")\n';

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves image titles", () => {
    const input = '![Alt text](./image.png "Image title")\n';

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves mailto autolinks as mailto URLs", () => {
    const input = "Visit <https://example.com/a?b=c> or <me@example.com>.\n";

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves source-only HTML comments", () => {
    const input = [
      "Before",
      "",
      "<!-- keep this source note -->",
      "",
      "After",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves raw details HTML blocks", () => {
    const input = [
      "<details>",
      "<summary>More</summary>",
      "",
      "Hidden **markdown** body.",
      "",
      "</details>",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves multi-line indented code blocks after lists", () => {
    const input = [
      "- Item before",
      "",
      "    code block",
      "    second line",
      "",
      "After",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });

  it("preserves table cells containing escaped pipes and inline code pipes", () => {
    const input = [
      "| Column | Value |",
      "| --- | --- |",
      "| Escaped | `a | b` and plain a \\| b |",
      "",
    ].join("\n");

    expect(richTextRoundTrip(input)).toBe(input);
  });
});

describe("CriticMarkup delimiter escaping", () => {
  // Every sequence that can reopen or close a review marker, plus the escape
  // character itself, in one payload.
  const typedText = String.raw`back\slash {==a==} {>>b<<} {++c++} {--d--} {~~e~>f~~} g~>h`;
  const escapedText = String.raw`back\\slash \{==a\==} \{>>b\<<} \{++c\++} \{--d\--} \{~~e\~>f\~~} g\~>h`;
  const commentMetadata = '{id="c1" by="user" at="2026-04-23T18:00:00.000Z"}';

  function findFirstLinkTitle(node: JSONContent): string | undefined {
    for (const mark of node.marks ?? []) {
      if (mark.type === "link" && typeof mark.attrs?.title === "string") {
        return mark.attrs.title;
      }
    }

    for (const child of node.content ?? []) {
      const title = findFirstLinkTitle(child);
      if (title !== undefined) return title;
    }

    return undefined;
  }

  // A save writes an untouched block back byte for byte, so these helpers
  // drop the parser's source snapshot to make the writer serialize the block
  // the way it does once the reviewer has edited it.
  function rewrite(doc: JSONContent, comments: Map<string, CriticComment>) {
    const { roughdraftSource: _source, ...fresh } = doc as JSONContent & {
      roughdraftSource?: unknown;
    };
    return editorStateToCriticMarkdown(fresh, comments);
  }

  function collectDocText(node: JSONContent): string {
    if (typeof node.text === "string") return node.text;
    return (node.content ?? []).map(collectDocText).join("");
  }

  it("reads an escaped comment body back as the text the reviewer typed", () => {
    const input = `Review {==this claim==}{>>${escapedText}<<}${commentMetadata}.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.size).toBe(1);
    expect(comments.get("c1")?.content).toBe(typedText);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("escapes a comment body so typed markup never becomes live markup", () => {
    const input = `Review {==this claim==}{>>Needs a source.<<}${commentMetadata}.\n`;
    const { doc, comments } = criticMarkdownToEditorState(input);
    const comment = comments.get("c1");
    if (!comment) throw new Error("Expected comment c1");
    comments.set("c1", { ...comment, content: typedText });

    const saved = editorStateToCriticMarkdown(doc, comments);
    expect(saved).toContain(`{>>${escapedText}<<}`);

    const reloaded = criticMarkdownToEditorState(saved);
    expect(reloaded.comments.size).toBe(1);
    expect(reloaded.comments.get("c1")?.content).toBe(typedText);
    expect(editorStateToCriticMarkdown(reloaded.doc, reloaded.comments)).toBe(
      saved,
    );
  });

  it("keeps a reply body literal without allocating a second thread", () => {
    const input = `${[
      `Review {==this claim==}{>>Needs a source.<<}${commentMetadata}`,
      `{>>${escapedText}<<}{id="c2" by="AI" at="2026-04-23T18:05:00.000Z" re="c1"}.`,
    ].join("")}\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.size).toBe(2);
    expect(comments.get("c2")).toMatchObject({
      content: typedText,
      parentCommentId: "c1",
    });
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps an insertion mark's text literal", () => {
    const input = `Add {++${escapedText}++}{id="s1" by="AI" at="2026-04-23T18:00:00.000Z"} here.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const { changes } = criticMarkdownToRenderedHtml(input);

    expect(collectDocText(doc)).toBe(`Add ${typedText} here.`);
    expect([...changes.keys()]).toEqual(["s1"]);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps a deletion mark's text literal", () => {
    const input = `Drop {--${escapedText}--}{id="s1" by="AI" at="2026-04-23T18:00:00.000Z"} here.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const { changes } = criticMarkdownToRenderedHtml(input);

    expect(collectDocText(doc)).toBe(`Drop ${typedText} here.`);
    expect([...changes.keys()]).toEqual(["s1"]);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps both halves of a substitution literal", () => {
    const input = `Use {~~${escapedText}~>${escapedText}~~}{id="s1" by="AI" at="2026-04-23T18:00:00.000Z"} instead.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    const { changes } = criticMarkdownToRenderedHtml(input);

    expect(collectDocText(doc)).toBe(`Use ${typedText}${typedText} instead.`);
    expect([...changes.keys()]).toEqual(["s1"]);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps a comment anchor's text literal", () => {
    const input = `Review {==${escapedText}==}{>>Needs a source.<<}${commentMetadata}.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(collectDocText(doc)).toBe(`Review ${typedText}.`);
    expect(comments.size).toBe(1);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps an anchored comment inside a fenced code block literal", () => {
    const input = [
      "```md",
      `{==${escapedText}==}{>>${escapedText}<<}${commentMetadata}`,
      "```",
      "",
    ].join("\n");

    const { doc, comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")?.content).toBe(typedText);
    expect(collectDocText(doc)).toBe(typedText);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
  });

  it("keeps a backslash that does not precede a delimiter", () => {
    // A body written before escaping existed keeps its raw backslashes on the
    // way in, and gains their escaped form on the way out.
    const body = String.raw`see C:\path and 50\% off`;
    const input = `Review {==this claim==}{>>${body}<<}${commentMetadata}.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    expect(comments.get("c1")?.content).toBe(body);
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);

    const saved = rewrite(doc, comments);
    expect(saved).toContain(String.raw`{>>see C:\\path and 50\\% off<<}`);

    const reloaded = criticMarkdownToEditorState(saved);
    expect(reloaded.comments.get("c1")?.content).toBe(body);
    expect(editorStateToCriticMarkdown(reloaded.doc, reloaded.comments)).toBe(
      saved,
    );
  });

  // A backslash escape is inert inside a code span and an autolink, so a reader
  // that leaves those to the Markdown lexer hands back text that is still
  // escaped and escapes it again on the next save. Four consecutive saves catch
  // that doubling, where one save cannot.
  describe("escape-inert Markdown contexts stay byte-stable", () => {
    const commentMetadata = '{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}';
    const changeMetadata = '{id="s1" by="AI" at="2026-04-28T12:00:00.000Z"}';
    // Written as they sit on disk: a Windows path and a marker, both escaped.
    const codeSpan = "a code span `C:\\\\dir` and `x\\{++y\\++}z`";
    const autolink = "an autolink <https://example.com/p\\{++q\\++}r>";
    const inertText = `${codeSpan}, ${autolink}`;

    const cases: Array<[string, string]> = [
      ["an anchor", `See {==${inertText}==}{>>Note<<}${commentMetadata}.\n`],
      [
        "a comment body",
        `See {==this==}{>>${inertText}<<}${commentMetadata}.\n`,
      ],
      ["a deletion", `Drop {--${inertText}--}${changeMetadata}.\n`],
      [
        "a fenced code block's anchor and comment body",
        [
          "```md",
          `{==${codeSpan}==}{>>${codeSpan}<<}${commentMetadata}`,
          "```",
          "",
        ].join("\n"),
      ],
    ];

    for (const [name, input] of cases) {
      it(`keeps escape-inert text in ${name} unchanged across four saves`, () => {
        const saves: string[] = [];
        let current = input;

        for (let round = 0; round < 4; round += 1) {
          const { doc, comments } = criticMarkdownToEditorState(current);
          current = editorStateToCriticMarkdown(doc, comments);
          saves.push(current);
        }

        expect(saves).toEqual([input, input, input, input]);
      });
    }

    // A quoted link or image title carries a second escaping layer, added by
    // `createTurndownService` rather than by Markdown, so reading peels the
    // serializer's layer and leaves this format's. Inside marker text one
    // logical backslash is therefore four on disk, and two outside.
    const titledLink = '[text](https://example.com "a\\\\\\\\title")';
    const singlyEscapedLink = '[text](https://example.com "a\\\\title")';

    const titleCases: Array<[string, string]> = [
      ["an anchor", `See {==${titledLink}==}{>>Note<<}${commentMetadata}.\n`],
      [
        "a comment body",
        `See {==this==}{>>${singlyEscapedLink}<<}${commentMetadata}.\n`,
      ],
      ["an insertion", `Add {++${titledLink}++}${changeMetadata}.\n`],
      ["a deletion", `Drop {--${titledLink}--}${changeMetadata}.\n`],
      [
        "a substitution's old text",
        `Use {~~${titledLink}~>new~~}${changeMetadata}.\n`,
      ],
      [
        "a substitution's new text",
        `Use {~~old~>${titledLink}~~}${changeMetadata}.\n`,
      ],
      ["no marker at all", `See ${singlyEscapedLink} here.\n`],
    ];

    for (const [name, input] of titleCases) {
      it(`keeps a link title in ${name} unchanged across four saves`, () => {
        const saves: string[] = [];
        let current = input;

        for (let round = 0; round < 4; round += 1) {
          const { doc, comments } = criticMarkdownToEditorState(current);
          current = editorStateToCriticMarkdown(doc, comments);
          saves.push(current);
        }

        expect(saves).toEqual([input, input, input, input]);
      });
    }

    it("hands a link title back as the one backslash it stands for", () => {
      const input = `See {==${titledLink}==}{>>Note<<}${commentMetadata}.\n`;

      const { doc } = criticMarkdownToEditorState(input);

      expect(findFirstLinkTitle(doc)).toBe("a\\title");
    });

    // packages/rfm/src/index.test.ts pins the same bytes against the other
    // reader, so the two cannot drift apart on one document.
    it("hands escape-inert text back with its escapes removed", () => {
      const input = `See {==${inertText}==}{>>${inertText}<<}${commentMetadata}.\n`;

      const { doc, comments } = criticMarkdownToEditorState(input);

      const typedText =
        "a code span `C:\\dir` and `x{++y++}z`, " +
        "an autolink <https://example.com/p{++q++}r>";
      expect(comments.get("c1")?.content).toBe(typedText);
      expect(collectDocText(doc)).toContain("C:\\dir");
      expect(collectDocText(doc)).toContain("x{++y++}z");
      expect(collectDocText(doc)).toContain("https://example.com/p{++q++}r");
    });
  });

  it("still reads a body that ends with a bare backslash", () => {
    // Written before escaping existed, so the backslash is ordinary text
    // rather than an escape of the delimiter that closes the comment.
    const input = `Review {==this claim==}{>>ends with a backslash\\<<}${commentMetadata}.\n`;

    const { doc, comments } = criticMarkdownToEditorState(input);
    expect(comments.get("c1")?.content).toBe("ends with a backslash\\");
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);

    const saved = rewrite(doc, comments);
    expect(saved).toContain(String.raw`{>>ends with a backslash\\<<}`);
    expect(criticMarkdownToEditorState(saved).comments.get("c1")?.content).toBe(
      "ends with a backslash\\",
    );
  });

  it("keeps a later comment when an earlier body ends with a backslash", () => {
    // The escape-aware scan reads that backslash as escaping the close, so
    // without a bound it runs on to the next comment's close and swallows the
    // comment in between.
    const legacyBody = "ends with a backslash\\";
    const input = [
      `See {==first==}{>>${legacyBody}<<}${commentMetadata}`,
      ' and {==second==}{>>second note<<}{id="c2" by="user" at="2026-04-28T12:01:00.000Z"}.\n',
    ].join("");

    const { doc, comments } = criticMarkdownToEditorState(input);
    expect([...comments.keys()]).toEqual(["c1", "c2"]);
    expect(comments.get("c1")?.content).toBe(legacyBody);
    expect(comments.get("c2")?.content).toBe("second note");

    // Untouched, the block keeps its bytes. Rewritten, the lone backslash
    // gains its escaped form once and nothing else moves.
    expect(editorStateToCriticMarkdown(doc, comments)).toBe(input);
    const saved = rewrite(doc, comments);
    expect(saved).toBe(
      input.replace(`{>>${legacyBody}<<}`, "{>>ends with a backslash\\\\<<}"),
    );

    const reloaded = criticMarkdownToEditorState(saved);
    expect([...reloaded.comments.keys()]).toEqual(["c1", "c2"]);
    expect(editorStateToCriticMarkdown(reloaded.doc, reloaded.comments)).toBe(
      saved,
    );
  });

  it("leaves a document-level comment in endmatter unescaped", () => {
    const input = [
      "Body text.",
      "",
      "---",
      "comments:",
      "  c1:",
      `    body: ${typedText}`,
      "    by: user",
      '    at: "2026-04-28T12:00:00.000Z"',
      "",
    ].join("\n");

    const { comments } = criticMarkdownToEditorState(input);

    expect(comments.get("c1")).toMatchObject({
      content: typedText,
      scope: "document",
    });
  });
});
