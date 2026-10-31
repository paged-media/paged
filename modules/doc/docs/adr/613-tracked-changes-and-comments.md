# ADR 613 — Tracked changes and comments

- **Status:** Accepted 2026-10-29.
- **Builds on:** engine ADRs 1040 (change tracking: `recordChange`, `acceptChange`,
  `rejectChange`, `documentTrackChanges`, the markup views) and 1020 (range comments:
  `insertComment`, `replyComment`, `resolveComment`, `deleteComment`), and the story read's
  review fields (`RunContent.change` / `formatChange` / `comments`,
  `ParagraphContent.markChange` / `propsChange`, `StoryContent.comments`).
- **Amends:** [ADR 602](602-save-back-is-a-byte-splice.md) (its 2026-10-24 amendment: a
  tracked run is no longer only "locked"), [ADR 610](610-save-back-across-sessions-and-new-parts.md)
  (new parts: the three comment parts).
- **Scope:** `docx-core` (`review.rs`: `RunChange`, `FormatChange`, `ParaPropsChange`,
  `ParagraphReview`, `Comment`; `Run::{change, format_change, comments}`,
  `Paragraph::review`, `DocxDocument::{comments, track_revisions}`), `docx-import`
  (`comments.rs`; the tracked inline walk), `docx-lower` (`LoweredChange`,
  `LoweredFormatChange`, `LoweredPropsChange`, `LoweredComment`, `LoweredDoc::track_changes`),
  `doc-host-model` (the review step of the pour), `docx-export` (`review.rs`; the overlay's
  review fields), `docx-js` (`save_edited_structure`), `scripts/word-review-probe.sh`,
  `docx-conformance/fixtures/review.word.json`.

## Context

W0 showed a document's tracked insertions as plain text, left its deletions out and said so in
a diagnostic; comments were not read at all. A Word user reviewing a document in paged needs
the markup itself: who changed what, the deleted text in place, the threads beside the text,
and Word must read back what paged accepts, rejects, records and answers.

## Decision

### Reading

**Every tracked run is shown, with its change.** `w:ins` and `w:moveTo` runs carry an
insertion, `w:del` and `w:moveFrom` runs a deletion whose text is their `w:delText`; a run's
`w:rPrChange` is a format change with the look before; a paragraph's `w:pPr/w:rPr/w:ins|w:del`
is its mark's change and its `w:pPrChange` a property change with the properties before. A
paragraph whose mark is deleted stays a paragraph (W0 dropped an empty one). Each change keeps
Word's `w:id`, `w:author` and `w:date`; the engine id is `docx-r<w:id>`. A move reads as an
insertion and a deletion (a diagnostic says so) and is saved as Word's move while unchanged.

**Comments are threads over runs.** `comments.xml` gives each comment's author, initials,
date and text (paragraphs separated by `\n`); `commentsExtended.xml` threads a reply to its
first comment (`w15:paraIdParent`, a reply's reply to the same first comment) and resolves a
thread (`w15:done`); `commentsIds.xml` gives the durable id. A thread's range is the runs between
its first comment's `w:commentRangeStart` and `w:commentRangeEnd`, in the body or between
paragraphs; a reply's range is its thread's. The engine id is `docx-c<w:id>`.

**`w:trackRevisions`** in `settings.xml` is `LoweredDoc.track_changes`.

### The pour

The lowering gives each change the engine's kind (`insert`, `delete`, `format`, `paraProps`,
`insertMark`, `deleteMark`); a format change's look before is a synthesized character style,
a property change's a synthesized paragraph style, so rejecting either puts back what Word had.
The pour records them LAST, in a step of their own after the text, the looks and the carets
(`recordChange` over char ranges; a mark and a property change by paragraph index; a cell's by
its cell address), then inserts each thread's first comment over its range and its replies
(`insertComment`, `replyComment`), and finally turns `documentTrackChanges` on when Word
tracked changes, so the pour itself is never recorded. An engine without these mutations
refuses the review step and keeps the text.

### Save-back

The run patcher (ADR 602) cannot address a run inside `w:ins` / `w:del`. So a body paragraph
whose review markup changed (a change recorded, accepted or rejected in paged; a thread
added, answered, removed), or that holds review markup and was edited, is **written whole**
before the run patcher runs (`docx-export/src/review.rs`):

- its `<w:p>` start tag and `<w:pPr>` stay, the differ's paragraph edit merged in; the mark's
  change and `w:pPrChange` are rewritten: an unchanged property change keeps its element, one
  recorded in paged records the source paragraph's properties;
- every run keeps the `<w:rPr>` of the Word run its text came from (characters aligned as the
  differ aligns them), with only what changed rewritten; a run in a change is wrapped in
  `w:ins` / `w:del` (a deletion's text as `w:delText`); an unchanged `w:rPrChange` stays, one
  recorded in paged records the look before;
- comment ranges and references are written where the read-back runs' comments start and end
  (a thread's replies beside its first comment); bookmarks stay at their place in the text;
- revision ids are new (past the highest in the part); comment ids stay, a comment made in paged
  takes the next free one; an author is required by Word, so a change without one is `Unknown`.

**Paragraph marks change the paragraph count.** A tracked Enter comes back as one more
read-back paragraph (its mark inserted, with an id Word did not have); a rejected insertion or
an accepted deletion of a mark as one fewer. `review::prepare` lines the read-back paragraphs up
with the blocks before the overlay: a split is folded back into its block and written as two
`<w:p>` (the first with the inserted mark); a join gives the joined block's slot its unchanged
content, writes the joined paragraph into the first block and removes the second's `<w:p>`
after the run patcher (a marker attribute that never reaches a file). When the counts admit
several joins, the one whose texts line up best is taken; when nothing lines up, the review
markup is not saved and the save names it.

**Refused, never guessed.** A paragraph holding what this writer does not write — a field, a
note reference, a picture, a hyperlink, a content control, a move, a page or column break — is
left as it was and named in the save's ledger ("tracked changes not saved: block N …").

**The comment parts** are written only when the read-back threads differ from the import's.
`comments.xml` keeps every comment the document still references (the body, headers, footers,
notes) in its order: unchanged comments byte for byte, edited ones re-rendered, new ones
appended with fresh `w14:paraId`s; a removed comment goes with its markers.
`commentsExtended.xml` and `commentsIds.xml` are rewritten from the same list (thread, done,
durable id). A part, its relationship and its content type are made when missing; a missing
`w14`/`w15`/`w16cid` declaration is added to the root.

**A zero-edit save stays byte-identical**, per part.

## Evidence

- `docx-conformance/tests/it/review.rs` — reading (changes, marks, property and format
  changes, threads with their ranges, `trackRevisions`), the zero-edit identity, accept and
  reject, a format and a property change resolved, changes recorded in paged, a tracked split
  and join, a reply, a resolved and a removed thread, a first comment making the three parts, a
  refused paragraph. Every saved package is well-formed and re-imports with the expected markup.
- `docx-conformance/tests/it/w0_losses.rs` — the W0 tests restated: tracked runs keep their
  sources; an edit beside a tracked run still lands on its own `<w:r>`.
- `scripts/word-review-probe.sh`, `docx-conformance/fixtures/review.word.json` — Microsoft Word
  16.114 opens every package the review tests save (accept, reject, format accepted and
  rejected, changes recorded in paged, a tracked split and join, a reply with a resolved
  thread, a removed thread, a first comment that makes the comment parts) without a prompt,
  and reads back their revisions and comments. Word stops on the test fixture's own move (a
  `w:moveFrom` and `w:moveTo` side by side in one paragraph, `tracked-moves.docx`), which is
  input written by hand, not a save; the probe's other documents carry the move as a deletion
  and an insertion (`tracked_changes_no_moves_docx`).

## Consequences

- Review markup inside table cells is read and recorded (cell-addressed `recordChange`), but a
  cell's accept or reject is not saved: the cell read-back carries no review fields, and a cell
  edit that reaches a tracked run is refused as before.
- A paragraph whose review markup changed is rewritten whole; what the writer refuses keeps its
  bytes, so its accept/reject reaches the document only after the paragraph is edited in Word.
- Moves are never rewritten; accepting or rejecting one in paged is refused on save.
- `settings.xml` is not written: a document keeps Word's `w:trackRevisions` setting whatever
  paged's tracking state is.
- Comments in headers, footers and notes are kept, not read.
