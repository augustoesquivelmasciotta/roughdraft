# Roughdraft Flavored Markdown 0.2

Status: Draft

Roughdraft Flavored Markdown is regular Markdown plus a portable review layer based on CriticMarkup. Its purpose is to let people and coding agents exchange comments, threaded replies, and pending changes inside the Markdown file itself.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

## Scope

This specification defines the review markup that Roughdraft reads and writes. It does not define a replacement for Markdown, a hosted document format, a sync protocol, or a project database.

A conforming document is a Markdown document that may contain Roughdraft review spans. Markdown parsing SHOULD follow CommonMark with GitHub Flavored Markdown extensions. Strikethrough is the one deliberate departure: a doubled tilde (`~~struck~~`) renders as strikethrough and a single tilde (`~struck~`) does not, because GFM's single-tilde form turns ordinary prose such as `~57% (~100h)` into strikethrough and saves it back as `~~57% (~~100h)`. Implementations MAY preserve YAML frontmatter as document metadata. Roughdraft review state lives in the same Markdown file, either as inline review anchors or as final YAML endmatter.

## Canonical Markers

Roughdraft uses these CriticMarkup-compatible markers:

```markdown
{>>comment<<}
{++inserted text++}
{--deleted text--}
{~~old text~>new text~~}
{==highlighted text==}
```

An implementation MUST treat the opening and closing marker pairs as review delimiters outside inline code and fenced code blocks, and inside a fenced code block only for the one construct named below.

Implementations MUST treat review markers inside inline code spans as literal example text, and MUST NOT create comments, suggestions, or highlights from them.

Inside a fenced code block, one construct is live and every other marker is literal. An anchor immediately followed by one or more comment blocks MUST be parsed as a comment thread, so a document can carry review of the markers it is displaying. Every other marker inside a fenced code block MUST be treated as literal example text, among them a standalone comment, an insertion, a deletion, and a substitution. Implementations MUST NOT create a suggestion or a bare highlight from a fenced code block.

## Escaping Delimiters

Marker text has no delimiter of its own, so a review delimiter typed inside a comment, an anchor, or a suggestion would close or reopen the marker that holds it. A backslash immediately before a review delimiter escapes it: the delimiter is literal text and the backslash is not part of the text. The escapable sequences are the ten opening and closing markers `{==`, `==}`, `{>>`, `<<}`, `{++`, `++}`, `{--`, `--}`, `{~~` and `~~}`, the substitution arrow `~>`, and the backslash itself.

```markdown
Please revisit {==this claim==}{>>Write \{>>a note\<<} to reply.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.
```

A writer that escapes MUST escape every one of those sequences wherever it writes comment text, anchor text, or suggestion text, and MUST write a literal backslash in that text as `\\`. A reader MUST treat a backslash before one of those sequences as an escape, MUST NOT end a marker at an escaped closing delimiter, and MUST report the text with the escapes removed.

A backslash before anything else is ordinary text and a reader MUST leave it as written, so a document from a writer that did not escape keeps its backslashes. One case from such a document is ambiguous: text that ends with a backslash reads as escaping the delimiter that closes the marker, so the marker appears to run past its own end. A reader that does not find an unescaped closing delimiter for a marker SHOULD fall back to the first raw one rather than discarding the marker.

Marker text MUST NOT contain an unescaped opening delimiter, since an unescaped opener is another marker beginning. A reader MUST end its search for a closing delimiter there, and this is what keeps that fallback local: without it a marker whose text ends with a backslash runs on to a later marker's closing delimiter and swallows every marker in between.

Every escaped form above is also a CommonMark backslash escape, so a Markdown renderer that knows nothing of this specification shows the literal delimiter rather than the backslash. A reader MUST NOT leave the work to its Markdown parser on that account: it MUST remove these escapes itself wherever a backslash survives Markdown parsing. Two separate things put one there, and a reader that accounts for only the first will hand back text that is still escaped and escape it again on the next write:

- Markdown leaves a backslash as ordinary text in some constructs, among them a code span, a code block, an autolink and raw HTML.
- An implementation's own Markdown serialization may escape a backslash, as a quoted link or image title does, so the text carries that layer as well as this one and reading removes only the serializer's.

Escaping is an extension: an implementation MAY instead reject review text containing a raw delimiter, as [Comments](#comments) describes. A writer that rejects SHOULD do so only for text it writes between delimiters, since text bound for YAML endmatter carries no delimiter that could end a marker and would keep an escape as written.

## Comments

A comment is written as:

```ebnf
comment = "{>>" comment-text "<<}" [ metadata ]
```

Comment text is plain inline Markdown content. Comment text MUST NOT contain an unescaped literal closing delimiter `<<}`; see [Escaping Delimiters](#escaping-delimiters). Writers that do not implement escaping MUST reject comment or reply text containing raw CriticMarkup close delimiters instead of emitting ambiguous review markup.

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

### Disposable Anchors

A comment must anchor on some text, so when nothing in the document is a natural anchor a writer may add a sentence written only to carry the thread. The comment marks that sentence as filler with `anchor="disposable"`:

```markdown
{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z" anchor="disposable"}
```

When a comment carrying `anchor="disposable"` is removed and no comment remains on its anchor, an implementation MUST remove the anchor text with it. This applies to the whole set of comments removed together: clearing a flagged thread removes its replies and the anchor in one action. While any comment still references the anchor, the anchor text stays. Resolving a thread does not remove it. Removing a comment without the flag leaves its anchor text in place as plain prose. A writer SHOULD put the flag on the root comment of the thread, and MUST NOT put it on a comment whose anchor is real document text.

The flag is read only from a comment's inline attribute block. A comment written in the compact reference form, `{#c1}` with its metadata in the YAML endmatter, cannot carry it: an endmatter `anchor` entry is ignored and the anchor text stays.

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
| `anchor` | Comments | No | `disposable` marks the anchor text as filler written only to carry the thread, removed with the last comment on it. See [Disposable Anchors](#disposable-anchors). |
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

Comment text is inline content, so it cannot hold line breaks. CriticMarkup delimiters are written escaped (see [Escaping Delimiters](#escaping-delimiters)) and stay inline. When a root comment's text has a line break, writers MAY store the full text as the `body` of its endmatter entry and write a one-line excerpt inline:

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
- Escaped review delimiters in comment, anchor, and suggestion text.

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
