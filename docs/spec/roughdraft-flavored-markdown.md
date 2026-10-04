# Roughdraft Flavored Markdown 0.2

Status: Draft

Roughdraft Flavored Markdown is regular Markdown plus a portable review layer based on CriticMarkup. Its purpose is to let people and coding agents exchange comments, threaded replies, and pending changes inside the Markdown file itself.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

## Scope

This specification defines the review markup that Roughdraft reads and writes. It does not define a replacement for Markdown, a hosted document format, a sync protocol, or a project database.

A conforming document is a Markdown document that may contain Roughdraft review spans. Markdown parsing SHOULD follow CommonMark with GitHub Flavored Markdown extensions. Implementations MAY preserve YAML frontmatter as document metadata. Roughdraft review state lives in the same Markdown file, either as inline review anchors or as final YAML endmatter.

## Canonical Markers

Roughdraft uses these CriticMarkup-compatible markers:

```markdown
{>>comment<<}
{++inserted text++}
{--deleted text--}
{~~old text~>new text~~}
{==highlighted text==}
```

An implementation MUST treat the opening and closing marker pairs as review delimiters outside inline code and fenced code blocks.

Implementations MUST treat review markers inside inline code spans and fenced code blocks as literal example text. They MUST NOT create comments, suggestions, or highlights from those code contexts.

## Comments

A comment is written as:

```ebnf
comment = "{>>" comment-text "<<}" [ metadata ]
```

Comment text is plain inline Markdown content. Comment text MUST NOT contain the literal closing delimiter `<<}` unless the implementation defines an escaping extension. Writers that do not implement escaping MUST reject comment or reply text containing raw CriticMarkup close delimiters instead of emitting ambiguous review markup.

A comment MAY appear by itself when the feedback applies to the surrounding paragraph or document:

```markdown
Add one concrete launch example here.{>>This should come from the customer story.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

## Anchored Comments

An anchored comment is a highlight immediately followed by one or more comment blocks:

```ebnf
anchored-comment = highlight 1*comment
highlight        = "{==" anchor-text "==}"
```

Example:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

The highlighted text is the visible anchor. Implementations SHOULD attach all immediately following comment blocks to the same anchor until another token interrupts the sequence.

A standalone highlight is valid CriticMarkup. Roughdraft 0.1 reserves it as review syntax, but standalone highlights are not required to produce a review-thread item unless an implementation explicitly supports highlight-only annotations.

## Suggestions

Suggestions represent pending edits. Implementations MUST NOT silently collapse suggestions into normal prose while reading or writing Roughdraft Flavored Markdown.

### Insertion

```ebnf
addition = "{++" new-text "++}" [ metadata ] *comment
```

```markdown
Add {++one concrete example++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

### Deletion

```ebnf
deletion = "{--" old-text "--}" [ metadata ] *comment
```

```markdown
Remove {--vague phrasing--}{#s2}.

---
suggestions:
  s2:
    by: user
    at: "2026-04-28T12:06:00.000Z"
```

### Substitution

```ebnf
substitution = "{~~" old-text "~>" new-text "~~}" [ metadata ] *comment
```

```markdown
Use {~~rough~>specific~~}{#s3} wording.

---
suggestions:
  s3:
    by: AI
    at: "2026-04-28T12:07:00.000Z"
```

Trailing comment blocks after a suggestion attach discussion to that suggestion:

```markdown
Add {++one concrete example++}{#s1}.

---
comments:
  c2:
    body: Use the launch story.
    by: user
    at: "2026-04-28T12:08:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

## Metadata

Roughdraft's preferred metadata format is a compact inline reference backed by final YAML endmatter:

```ebnf
reference = "{#" id "}"
id        = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Root comment bodies and suggestion text stay inline so their anchors remain portable. Replies live entirely in endmatter because their `re` field already points at a parent id:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

Suggested-change metadata lives under `suggestions:`:

```markdown
Add {++one concrete example++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

For compatibility, readers also accept the older inline attribute block written immediately after a comment or suggestion:

```ebnf
metadata  = "{" 1*attribute "}"
attribute = name "=" quoted-value
name      = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

Attribute values are double-quoted strings. Inside a quoted value, `\"` represents a literal quote and `\\` represents a literal backslash.

Known metadata attributes:

| Attribute | Applies to | Required when writing | Meaning |
| --- | --- | --- | --- |
| `id` | Comments and suggestions | Yes | Stable document-local identifier. |
| `by` | Comments and suggestions | Yes | Author or agent label. `AI` identifies an agent author. |
| `at` | Comments and suggestions | Yes | ISO 8601 timestamp. |
| `re` | Comments | No | Parent comment or suggestion id for threaded replies. |
| `status` | Comments and suggestions | No | Review state. Roughdraft currently writes `resolved` when an item has been addressed. |
| `resolved` | Comments and suggestions | No | Optional short resolution summary for an item whose `status` is `resolved`. |

Example:

```markdown
{>>Needs a source.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Implementations SHOULD generate simple document-local ids. Roughdraft uses `c1`, `c2`, and so on for comments and `s1`, `s2`, and so on for suggestions. Ids MUST be unique within a document: a new id MUST NOT reuse any id that appears in inline metadata (attribute blocks, `{#id}` references, legacy blocks), as a YAML endmatter key (including entries no inline marker references), or in the `deleted` list. A comment highlighted in several places MUST be written once; writers MAY keep only its first highlight. Readers that find the same id on two different comments SHOULD keep both and give the later one a new id on write.

Implementations MUST preserve unknown valid attributes or YAML keys when possible, but they MUST NOT require unknown metadata for correct review rendering.

For compatibility, readers MAY accept legacy comment metadata of the form `{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}`. Writers SHOULD emit compact references plus YAML endmatter for new review data.

### Mixed Metadata Formats

One document MAY mix the metadata formats above, for example root comments with inline attribute blocks and replies that live only in YAML endmatter. A final YAML block is review endmatter when it has a `comments`, `suggestions` or `deleted` key and at least one of: a `{#id}` reference in the body, a document-level comment (`body`, `by` and `at`, no `re`), a reply entry (`body`, `by`, `re` and an ISO 8601 `at`), or a `deleted` record. Writers SHOULD keep each item in the format it was read in and SHOULD NOT rewrite content nobody changed.

### Long Or Multi-Line Comment Text

Comment text is inline content, so it cannot hold line breaks or CriticMarkup delimiters. When a root comment's text has either, writers MAY store the full text as the `body` of its endmatter entry and write a one-line excerpt inline:

```markdown
See {==the launch plan==}{>>Pasted article: launch risks …<<}{#c4}.

---
comments:
  c4:
    body: |-
      Pasted article: launch risks

      - Supplier delays
      - Regulatory review
    by: user
    at: "2026-10-01T10:00:00.000Z"
```

Readers SHOULD use the endmatter `body` of an entry without `re` as the full text of the inline comment that references it, and MUST NOT treat it as a separate document-level comment.

### Resolved And Deleted Items

Resolving an item writes `status="resolved"` (or `status: resolved` in endmatter) and, optionally, a short `resolved` summary. Reopening removes both.

Deleting a comment MAY leave a record in an optional top-level `deleted` list, so reviewers can see later what was removed:

```yaml
deleted:
  - id: c3
    by: user
    at: "2026-10-01T10:05:00.000Z"
    deletedAt: "2026-10-02T09:00:00.000Z"
    re: c1
    anchor: the launch plan
    body: Original text of the deleted comment
```

`id`, `deletedAt` and `body` are required in a record; `by`, `at`, `re` (the parent of a deleted reply) and `anchor` (the highlighted text of a deleted root) are optional. Readers MUST NOT show deleted records as comments, and their ids stay reserved.

## Threads

Threading is represented by `re`.

```markdown
Review {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

A reply whose `re` points to a missing id SHOULD be treated as a top-level comment. A comment MUST NOT be its own parent.

## Parsing And Round Trips

Implementations SHOULD parse Roughdraft review markers as inline review annotations without rewriting unrelated Markdown.

Round trips SHOULD preserve:

- Every block nobody edited, byte for byte, including blank lines and list markers.
- YAML frontmatter delimiters and content.
- Local links and image paths.
- Tables and task lists.
- Inline code and fenced code blocks, including the fence length and character (a fence of four or more backticks is closed only by a fence at least as long).
- Raw review marker text inside code contexts.
- Metadata values, including escaped quotes and backslashes.

When importing a valid comment or suggestion without metadata, an implementation MAY synthesize missing `id`, `by`, and `at` values on write.

## Review Interchange JSON

The Markdown file is the normative storage format. For APIs, tests, and integrations, implementations MAY expose a review index JSON document that follows [`roughdraft-flavored-markdown.schema.json`](./roughdraft-flavored-markdown.schema.json).

The review index intentionally does not replace a Markdown AST. It indexes Roughdraft review annotations while leaving block parsing to the Markdown implementation.

Example:

```json
{
  "format": "roughdraft-flavored-markdown",
  "version": "0.1",
  "source": {
    "markdown": "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.\\n\\n---\\ncomments:\\n  c1:\\n    by: user\\n    at: \"2026-04-28T12:00:00.000Z\"\\n"
  },
  "comments": [
    {
      "id": "c1",
      "body": "Needs a source.",
      "by": "user",
      "at": "2026-04-28T12:00:00.000Z",
      "anchor": {
        "text": "this sentence"
      }
    }
  ],
  "suggestions": []
}
```

Conformance fixtures live in [`fixtures/`](./fixtures/). A parser that claims Roughdraft Flavored Markdown 0.1 support SHOULD pass those examples or document any intentional differences.
