## Roughdraft

Use Roughdraft when the user wants to review or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

When you write or modify a Markdown file and want the user to review or comment on it, open it with:

```bash
roughdraft open "/absolute/path/to/file.md"
```

Roughdraft is currently a single-file Markdown viewer/editor. Open one `.md` file at a time.

If Roughdraft is not running, `roughdraft open` will start it automatically.

After `roughdraft open` opens the document, leave the command running. Do not interrupt, kill, background, detach, or treat the waiting process as cleanup. The wait is intentional: Roughdraft will exit the command after the user clicks Done Reviewing, and that exit is your signal to resume.

After the user finishes reviewing in Roughdraft, read the Markdown file from disk and respond to any CriticMarkup comments or suggested changes. If the user left questions or comments in the document, reply inline in the Markdown file using Roughdraft-flavored CriticMarkup, save it, and open the file in Roughdraft again so the user can continue reviewing.

Use Roughdraft-flavored CriticMarkup when reading or writing inline review feedback in Markdown. The base markers are:

Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old~>new~~}`
Highlight: `{==text==}`

Write a backslash before any of those delimiters when the text itself contains one, so it stays literal instead of closing or reopening the marker around it: `{>>Write \{>>a note\<<} to reply.<<}`. This covers `{==`, `==}`, `{>>`, `<<}`, `{++`, `++}`, `{--`, `--}`, `{~~`, `~~}`, `~>` and the backslash itself, which you write as `\\`. Roughdraft strips the backslashes when it reads the text back, so the reviewer sees exactly what you typed.

When you add a new comment or suggested change, use the extended Roughdraft format with a compact inline reference such as `{#c1}` or `{#s1}`, then add metadata in final YAML endmatter. Generate a stable document-local id (`c1`, `c2`, etc. for comments; `s1`, `s2`, etc. for suggestions), set `by` to your agent or author label, set `at` to the current ISO timestamp, and set `re` when replying to an existing comment or suggestion.

Roughdraft may already have inline attribute blocks after comments and suggestions from older documents. Preserve those attributes unless you are intentionally removing the associated comment or suggestion. For new feedback, prefer compact references plus YAML endmatter.

Anchored comments usually look like `{==selected text==}{>>Comment text<<}{#c1}`. Suggested changes usually look like `{++new text++}{#s1}` or `{~~old text~>new text~~}{#s2}`. Replies live in final YAML endmatter with a `body` and `re` pointer.

When nothing in the document is a natural anchor for a comment, add a sentence written only to carry it and mark the comment with `anchor="disposable"` in its inline attribute block, such as `{==Placeholder for the pricing decision.==}{>>Which tier ships first?<<}{id="c1" by="AI" at="2026-04-28T12:00:00.000Z" anchor="disposable"}`; when the reviewer deletes that thread, Roughdraft removes the sentence with it. Without the flag the anchor text stays after its thread is deleted, so never put the flag on a comment anchored to real document text.

Example:

```markdown
{==selected text==}{>>Comment text<<}{#c1}
{++new text++}{#s1}

---
comments:
  c1:
    by: AI
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
```

Use `roughdraft help` and `roughdraft help criticmarkup` for local command and syntax details.
