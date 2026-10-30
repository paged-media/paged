# ADR 1037 — Word's change tracking: changes carried by what they changed, recorded while typing, accepted and rejected

- **Status:** Accepted 2026-10-29.
- **Scope:** rides protocol v78 as a rider (every addition is optional on the wire and
  skipped in the model when unset). Amends [ADR 184](184-tracked-changes.md): InDesign's
  tracked deletions stay as that ADR keeps them, and Word's model of a change joins them.
  Part of engine wave E3 of the paged.doc Word-parity program; the plugin's `w:ins`,
  `w:del`, `w:rPrChange` and `w:pPrChange` reading and writing are paged.doc work (doc ADR
  613). Range comments are [ADR 1020](1020-range-comments-with-threads.md).
  - `paged-model`: module `review` — `Change`, `ChangeKind`, `FormatChange`,
    `ParaPropsChange`, `MarkupView`, the reserved author colours (`review_color_id`,
    resolved by `Graphic::resolve` without a swatch); `CharacterRun.revision`,
    `CharacterRun.format_change`, `Paragraph.mark_revision`, `Paragraph.props_change`;
    `DocumentPreference.track_changes`, `track_changes_author`, `markup_view` and the
    session-only `review_clock`.
  - `paged-mutate`: `apply/review.rs` — `RecordChange`, `AcceptChange`, `RejectChange`,
    the inverse-only `RestoreStoryReview`; tracked formatting (`tracked_format`) around
    `SetProperty` on a story range and `ApplyStyle`; property paths
    `DocumentTrackChanges`, `DocumentTrackChangesAuthor`, `DocumentMarkupView`.
  - `paged-canvas`: `review.rs` — the tracked-edit lane (`lower_tracked`), the
    `trackedChanges` rows of Word's changes, `set_review_clock`; text typed into a
    changed run does not inherit its change; a paragraph split moves the mark's change to
    the tail.
  - `paged-canvas-wasm`: the shell stamps the review clock from its own clock before each
    mutation.
  - `paged-renderer`: `pipeline/review.rs` — the markup view applied before a paragraph
    is set; `HideRule.review`.
  - `paged-wire`: `recordChange`, `acceptChange`, `rejectChange`; `ChangeSpec`,
    `ChangeSpecKind`; `TrackedChangeSummary.id` / `kind` / `end` / `paragraph`;
    `RunContent.change` / `formatChange`, `ParagraphContent.markChange` /
    `propsChange` (`ChangeContent`, `FormatChangeContent`, `PropsChangeContent`).
  - `paged-introspect`: the three document paths in the catalog.

## Context

A Word document under review holds insertions, deletions, formatting changes and paragraph
changes, each with an author and a date, and a reviewer accepts or rejects them one at a
time, by author, or all at once. While Track Changes is on, every edit is recorded instead of
applied. The engine kept only InDesign's deletions (ADR 184): a marker character standing for
text that is gone. Word's insertions read as plain text (W0 showed them with a diagnostic),
and there was no way to record an edit.

## Decision

**A change is carried by what it changed**, as Word's markup carries it.
- An inserted or deleted run names its `Change { id, kind, author, date }` in
  `CharacterRun.revision`. **A deleted run keeps its text**, as `w:delText` does; what shows is
  the markup view's business. Runs split and join with the change they carry, so a change's
  range follows its text through every edit with no offsets to keep.
- A formatting change keeps the run's properties before it (`FormatChange.before`, a run
  with no text and no review state); a paragraph change keeps the paragraph's
  (`ParaPropsChange.before`).
- An inserted or deleted paragraph MARK is `Paragraph.mark_revision`: the break that ends
  the paragraph. Splitting a paragraph gives the mark's change to the tail, whose break it
  is; the head ends with a new mark.
- Ids are unique in the document and numeric, as Word's `w:id`; the engine mints one past
  the largest when none is given.

**Recording.** `recordChange` marks story chars `[start, end)` (or one paragraph, for the
paragraph kinds) as changed. It is what an importer writes, and what tracked edits lower to.
A change without an id joins the change of the same kind and author on the characters
around it, so typing a word letter by letter is one change.

**The tracked-edit lane.** While `documentTrackChanges` is on, the canvas lowers a wire
`insertText` to one batch: the untracked insert, `recordChange insert` over the typed
characters and `insertMark` per typed break. A `deleteRange` becomes, from the range's end
back to its start, a real delete of what the same author inserted (Word removes your own
insertion), nothing for text already deleted, and `recordChange delete` or `deleteMark` for
everything else. A character or paragraph property or a style set on a story range is
applied and then recorded against the properties the runs and paragraphs had
(`tracked_format`); setting a property back to what it was removes the change. Each is one
undo step whose inverse restores the touched paragraphs exactly. The author is
`documentTrackChangesAuthor`; the engine reads no clock, so the date is the review clock the
host stamps before each mutation (the wasm shell does it from its own clock; a native host
calls `set_review_clock`), else none, as Word allows.

**Accept and reject.** `acceptChange` / `rejectChange` take one change by id (all its runs
and marks), every change by an author, or all, in one story or the document:
- an insertion accepted stays, rejected goes; a deletion accepted goes, rejected stays;
- a formatting change accepted keeps the new formatting, rejected puts the old back;
- a mark accepted as deleted, or rejected as inserted, joins its paragraph with the next
  (the paragraph keeps its own properties, as a text delete across the break does).
Without an id they resolve InDesign's tracked deletions too. **They are each other's
opposite**: over any tracked edits, rejecting everything gives back the document before them
and accepting everything gives the text the same edits make untracked (a proptest), and
either undoes to the tracked document exactly (`RestoreStoryReview`).

**The markup view** is a render option of the document (`documentMarkupView`, Word's
Display for Review): All Markup (the default) underlines an insertion and strikes a deletion
through, both in the author's colour (a stable hash of the name over eight reserved colours
that need no swatch), and shades commented text; Simple Markup and No Markup set the text as
if every change were accepted (deleted runs leave through the hide pass, as hidden text
does); Original sets it as if every change were rejected (inserted runs hidden, the
formatting before each formatting change).

**Reads.** The `trackedChanges` collection lists Word's changes beside InDesign's
deletions, one row per story and change id with its kind, range and text. The story content
read names each run's change and formatting change and each paragraph's mark and paragraph
change, which is what a content plugin writes back as `w:ins`, `w:del` and `w:*PrChange`.

## Consequences

- Changes inside table cells are recorded, accepted and rejected; the `trackedChanges`
  rows list the body's only.
- The markup view decides what is SET. In Simple and No Markup the hidden deletions take no
  room; a caret mapped through hidden text behaves as it does for hidden text (ADR 1018).
- Simple Markup draws no change bar, and a deleted paragraph mark still breaks the line in
  every view; Word joins the paragraphs in No Markup.
- A moved range (`w:moveFrom` / `w:moveTo`) is a deletion and an insertion.
- Text typed with tracking off into a changed run is nobody's change, as in Word.
