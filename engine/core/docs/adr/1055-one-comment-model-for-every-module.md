# ADR 1055 — One comment model for every module, compatible with Adobe and Microsoft review

- **Status:** Accepted 2026-11-01; built: the engine model, the host Comments panel and canvas pins, the slide, Excel and
  Word readers and writers (slide ADR 711, sheet ADR 528, doc ADR 622), PDF comment annotations in and out (import
  2026-11-02), IDML notes as `note` rows, and the `comments@1` door (extensions ADR 1101). Open: a sheet thread started
  from the panel on a cell, Word mentions, document threads in IDML (reported as lost), and re-emitting a PDF thread's
  kept annotation on export. Extends [ADR 1020](1020-range-comments-with-threads.md) (range
  comments with threads) and [ADR 172](172-editorial-notes.md) (InDesign notes). Part of the
  capability layering of PM-0014 and PM-0017.
- **Scope:** `paged-model` (`review.rs`), `paged-mutate`, `paged-wire`, `paged-canvas` (the
  `comments` collection), `idml-import` / `idml-export`, `paged-export-pdf`; for the readers and
  writers per format: doc (`docx-*`, ADR 613), slide (`pptx-*`), sheet (`sheet-xlsx`), publish
  (`pdf-import`); the host's Comments panel (apps/editor) and the public door `comments@1`
  (plugin-sdk).

## Context

Review comments exist five times, in different shapes:

| Where | Model | Limit |
|---|---|---|
| Engine, ADR 172 | an InDesign note: a point in the text | no threads |
| Engine, ADR 1020 | a thread over a text range of a story (`Story.comments`, `CharacterRun.comments`) | anchored to text only |
| slide, ADR 711 (amendment) | the plugin's own model, panel and markers, kept in a container part | not in the document, not undoable, invisible to export and the CLI |
| sheet, ADR 526 | Excel notes edited by XML splice; threaded comments preserved, never editable | a cell address is the only anchor |
| PDF | export wrote `Link` annotations only; import read none (both built 2026-11-02, below) | no review round trip with Acrobat |

A comment on a shape, a slide, a cell, a page, a raster region or a vector object has no home in
the engine. The host's Comments panel is a stub. Word, Excel, PowerPoint, InDesign and Acrobat
all have comments, and each carries more than the engine's `Comment` (author identity, mentions,
status, tasks, reactions, a modification time).

## Decision

### One model, at document level

`Document.comments` holds every thread. ADR 1020's per-run ids remain the mechanism that makes a
**text** anchor follow its text through edits; every other anchor is a field of the thread.

```
Thread { id, anchor, kind, comments: [Comment], status, source }
Comment { id, author: PersonRef, created, modified, body, mentions, reactions, task }
Anchor = TextRange { story, … }          // ADR 1020, by the runs that name the thread
       | TextPoint { story, offset }      // an InDesign note, a Word comment at a caret
       | Item { item, at: Option<Point> } // a shape, frame or group; a point in item space
       | Page { page, at: Point }         // a page or artboard point (slide position, PDF sticky)
       | Region { item, rect }            // a raster area, PDF markup rectangles
       | Cell { item, address }           // an opaque module address the owner resolves (below)
```

- **Kind.** `comment` is a threaded comment (Word, PowerPoint modern, Excel threaded, Acrobat
  replies). `note` is a single, unthreaded annotation (Excel legacy note, InDesign note, PDF sticky
  note). A note can be converted to a thread, and the other way when it has no replies.
- **People.** A document **people list** holds each author once: name, initials, `userId`,
  `providerId`. Comments refer to it. Word's `people.xml`, Excel's `persons` and PowerPoint's
  `authors.xml` map onto it; a PDF's `/T` string maps to a person without ids.
- **Body.** Paragraphs of runs with bold, italic, underline and links, as the formats carry them,
  and **mentions** (a person and the span of text that names them). Plain text stays the least
  common form: it is the body with no marks.
- **Times.** Created and modified, to the millisecond, UTC with the offset the file gave.
- **Status.** `open`, `resolved`, `closed` for a thread; for a PDF, the review state of an
  annotation (`Accepted`, `Rejected`, `Cancelled`, `Completed`, `None`) as a separate field.
- **Task** (optional, per comment): assignee (person), due date, priority, title. PowerPoint modern
  comments and Excel threaded comments carry them.
- **Reactions** (optional): a person and an emoji.
- **Resolving a thread** resolves it for all of its comments, as Word's Resolve does (ADR 1020).

### Fidelity: each thread keeps its source

A thread carries `source`: for each format that wrote it, the original XML element or PDF
dictionary, and which comment ids it covers. The writers act on it as slide ADR 711 and doc ADR 613
already do:
- A thread that is unchanged is **re-emitted byte for byte**.
- A thread edited in paged is re-rendered from the model, keeping the source's markers and any
  fields the model does not carry (extension elements, `commentsExtensible` data, likes).
- A field a target format cannot carry (replies in IDML, tasks in Word) is a **reported loss**, never a
  silent drop. The export diagnostics name the thread.

### Operations

Each is one named undo step (ADR 1030), over the wire and in the script bridge:
`insertComment(anchor, body, author?)`, `replyComment`, `editComment`, `resolveComment`,
`reopenComment`, `moveCommentAnchor`, `deleteComment`, `setCommentTask`, `reactComment`,
`setPeople`. ADR 1020's operations are these with a text-range anchor. A thread whose anchor target
is deleted is not deleted with it: it becomes **orphaned** (kept, listed, and shown at its last
position) and the host offers to re-anchor or delete it. A range comment whose text is deleted
reads without a range, as ADR 1020 already says.

`documentCollection:comments` lists every thread with its anchor resolved to **geometry** (page,
rect) so a host can draw a pin or a balloon. For a `Cell` anchor the engine asks the owning
module for the geometry through a resolver contribution (below).

### The door, the host and the command line

- **`comments@1`** in plugin-sdk (public, with the harness fake): list, add, reply, resolve,
  edit, delete, subscribe to changes, and `contribute.commentAnchorResolver` for a module that owns
  an address space (sheet: cell and range → rect on the sheet frame).
- **One host Comments panel** replaces the stub: threads grouped by page or by anchor, filters
  (open, resolved, mine, mentions), reply, resolve, and a **pin** on the canvas for every non-text
  anchor. Text anchors keep the margin band (editor ADR 300, extensions ADR 349). Every module's
  edit context shows the panel; no module draws its own.
- **CLI and MCP:** `paged comments list | add | reply | resolve | export`, with JSON output in
  the model's shape.

### Format compatibility

Each reader and writer lives with the format's owner; all of them read and write this model.

| Format | Reads and writes | Owner |
|---|---|---|
| Word (`.docx`) | `comments.xml`, `commentsExtended` (`w15:done`, `paraIdParent`), `commentsIds` (`w16cid`), `commentsExtensible` (`w16cex` `dateUtc`), `people.xml` | doc |
| Excel (`.xlsx`) | legacy `comments` plus the VML note, **and** `threadedComments` plus `persons` with mentions; kept paired as Excel requires (a note for each thread) | sheet |
| PowerPoint (`.pptx`) | modern `modernComment_*` (p188) plus `authors.xml`; legacy `p:cmLst` read, written as modern | slide |
| OpenDocument | `office:annotation` (and its reply chain) | doc (`docx-odt`), sheet (`ods`) |
| InDesign (IDML) | `Note`; replies are folded into the note text, reported | engine (`idml-*`) |
| PDF / Acrobat | `/Text`, `/FreeText`, `/Highlight` (`/QuadPoints`), `/Popup`, replies by `/IRT`, `/State` with `/StateModel`, `/T`, `/M`; export option "comments as annotations" | `paged-export-pdf`, `pdf-import` |
| Illustrator (`.ai`) | through its PDF stream | publish |
| Photoshop (`.psd`) | the annotation resource, if the corpus has one | `paged-psd`, later |

## Migration

1. **doc.** ADR 1020's `Comment` becomes the new `Comment`; `Story.comments` stays the text-anchor
   index, `Document.comments` the thread store. Existing `.paged` documents read unchanged
   (an old comment is a `TextRange` thread whose person has no ids).
2. **slide.** `comments/comments.json` is read on open, converted to threads, and dropped on the
   next save; the plugin's panel and overlay markers go; `pptx-export` writes from the model.
   Slide ADR 711's amendment is superseded for the model and kept for the file format details.
3. **sheet.** Notes and threads become `Cell` threads on the sheet frame; the resolver turns
   addresses into rects; threaded comments become editable; the notes and threads stay paired.
4. **engine and publish.** IDML notes become `note` threads; PDF annotations in and out.
5. **image, draw, web, data.** They gain comments through the host panel with no module code.
   image supplies `Region` geometry for a raster area.

## Consequences

- A feature made engine-native appears in every module's output and export at once; the five
  per-module models, the slide plugin's panel and its container part go away.
- A comment survives a trip through formats it does not belong to (a Word comment exported to PDF
  shows in Acrobat as a thread; a PowerPoint comment survives `.paged` → `.pptx`).
- A new engine type and ops ride a protocol bump (`paged-wire`), and the wire and the introspect
  catalog are regenerated.
- The model is larger than any one format needs. A format that cannot carry a field reports it.
- plugin-sdk gains a public door; its version moves as the contract rule says.

## Built so far

Rides protocol v78 (added before its first consumer sync; governance rule 4).

- `paged-model` (`comments.rs`): `Person`, `CommentAnchor` (`Item`, `Page`, `Region`, `Cell`),
  `CommentThread`, `ThreadKind`, `SourceBlob`, `ReviewState`, `CommentTask`, `Mention`,
  `Reaction`; `Comment` gains `modified`, `person`, `mentions`, `task`, `reactions`,
  `review_state`. `Document` (paged-scene) holds `comment_threads` and `people`, absent from the
  native encoding when empty, so older documents read unchanged.
- `paged-mutate` (`apply/threads.rs`): `InsertCommentThread`, `ReplyCommentThread`,
  `SetCommentAnchor`, `SetPerson`, and the inverse-only `RestoreCommentThreads`, which carries
  both lists as they were. ADR 1020's `ResolveComment`, `EditComment` and `DeleteComment` find a
  comment in the stories first and in the thread store second; ids are minted past both stores.
  A reply to a resolved thread reopens it; a note takes no replies.
- `paged-wire`: the mutations `insertCommentThread` (`threadKind`, because `kind` is the tag),
  `setCommentAnchor`, `setPerson`; `replyComment` into a document thread lowers to
  `ReplyCommentThread`. The schema, the introspect catalog and the CLI surface are regenerated.
- `paged-canvas`: the `comments` collection lists thread comments after the text comments, with
  `threadId`, `anchor`, `threadKind`, `person`, `modified` and `orphaned` on every row.
- A comment keeps the **source** its format wrote (`CommentSpec.source`, `SourceBlob`): the thread
  stores it per comment id, the collection returns it, and deleting a reply drops its entry.
- Each document-thread row reports the **page** it stands at and the **point** on it (`page`, `at`):
  a page point as given, an item at its top-left plus the anchor's own point, a page id used as a
  module address at the page's origin; a thread whose target is gone reports neither.
- **slide** is on it: a deck's comments become threads on their page or shape (`shape:<id>`), the
  original `SlideComment` is the source, export rebuilds the per-page lists from the rows, the
  plugin's panel and markers are gone, and an older deck's container part is read into the
  document once. A text comment has no slide to go on and is not written to the `.pptx`.
- A thread **orphans** when what it is anchored to is deleted: it is kept with its anchor, and the
  `comments` rows report `orphaned` (derived on read, so undoing the deletion needs no bookkeeping).
  `SetCommentAnchor` re-anchors it.
- **PDF / Acrobat:** `ExportPdfWireOptions.comments` (off by default; `paged export --comments`; the
  export dialog's "Comments as annotations") writes each thread as a Text annotation at its point
  (a page point as given; an item or text range at the top-left of its first frame), each reply as
  an annotation in reply to it (`/IRT`, `/RT /R`), and a resolved thread's `Completed` review
  state (`/StateModel /Review`, a hidden annotation), with author (`/T`), date (`/M`) and id (`/NM`).
  **Reading them back (2026-11-02):** `paged-pdf-annots` (`read_pdf_comments(bytes)`, over `hayro-syntax`'s
  object model, the reader the renderer and `pdf-import` already use) returns the threads and a loss list.
  `/Text` and `/FreeText` become a thread at the top-left of `/Rect`; `/Highlight`, `/Underline`, `/StrikeOut` and
  `/Squiggly` a region over the bounding box of `/QuadPoints` (the markup kind stays in the source); `/Popup` is
  skipped (its parent has the text); an annotation with `/IRT` (and `/RT /R` or none) is a reply, ordered by `/M`
  when all have one, else by position; `/State` with `/StateModel /Review` sets the review state (`Completed` on
  the root resolves the thread, the latest state of a model wins); `/T` is the author, `/CreationDate` (else `/M`)
  the date, `/M` the modification time (PDF dates become ISO 8601 with their zone), `/Contents` (else `/RC` as
  plain text) the text. Page space is the `/TrimBox` (else the crop box) with `/Rotate` applied and the box's
  origin subtracted. Every other annotation type (`/Link`, `/Widget`, `/Stamp`, `/Ink`, …), a `/RT /Group`
  member, a state model other than `Review` (`Marked` has no model field) and an annotation with no place are
  one aggregated loss line per type, never dropped silently. Each annotation (and the state annotations that
  name it) is kept as a self-contained dictionary in the comment's `source` (format `pdf-annot`: keys sorted,
  strings as hex, indirect values inlined, `/P`, `/Parent`, `/Popup`, `/IRT`, `/AP` and streams left out).
  Threads read are `comment` threads, also a lone sticky note. Wiring: `paged comments <file.pdf> [--json]`
  lists them and the losses; the PDF bundle's wasm (`pdf_comments`) hands the report to the importer, which
  writes `setPerson`, `insertCommentThread` and `replyComment` in one `batch` after the document is open
  (a text-markup region has no item in a fresh import and is placed as a point at its top-left, said in the
  log). No wire or catalog change was needed: `CommentSpec` already carries dates, review state and source.
  The round trip with `paged-export-pdf` (threads, authors, dates to the second, replies, resolved and review
  state, points within half a point) is a test of that crate; poppler draws the sticky note of an exported
  thread at the point the reader reports.
- **Command line:** `paged read collection <doc> comments` lists every thread; `paged invoke <doc>
  <op> '<json>'` writes them, with `<op>` one of `insertCommentThread`, `replyComment`,
  `resolveComment`, `editComment`, `deleteComment`, `setCommentAnchor`, `setPerson` and the JSON its
  arguments (for example `paged invoke doc.paged insertCommentThread '{"anchor":{"kind":"page",
  "page":"u1","at":[40,50]},"comment":{"author":"Ann","text":"Check"}}'`); `paged export
  --comments` puts them in a PDF. A separate verb for document threads would add nothing these do not; `paged
  comments <file.pdf>` exists because a PDF's annotations are not a document yet.
- **Canvas pins** (editor): a pin with the author's initials at each non-text thread's place on its
  page, faint when resolved; a click focuses the thread and opens the Comments panel on it. Text
  comments keep the margin band.
- **`comments@1` was deferred here and is built:** [extensions ADR 1101](../../../../platform/extensions/docs/adr/1101-the-comments-door.md)
  (2026-11-01) records the door over the same reads and writes. What follows was true when this section was written.
- **`comments@1` is deferred.** Every operation and read it would wrap is reachable today through
  `document.collection("comments")` and `document.mutate` with the generated wire types, which is
  what paged.slide and the host panel use. The door becomes worth its contract and harness cost when
  a module needs to *contribute* to comments (sheet resolving `Sheet1!B3` to the cell's rectangle),
  not before.
- **IDML notes** (measured on InDesign 2025, 20.0.1): a `<Note>` has no `Self`, no thread and no
  reply API (the DOM note has `creationDate`, `modificationDate`, `userName`, `collapsed`,
  `storyOffset`, `label` only), and one inside a table cell stands in the cell's range like any
  other. The `comments` collection lists every story note after its range comments as a row of
  `threadKind: "note"`: `author` is `UserName`, `date`/`modified` the two dates, `start` = `end` the
  note's story offset (none in a table cell), `text` its paragraphs joined by `\n`. Editing stays
  with ADR 172's ops, which keep the preserved `<Note>` subtree. On export a comment on a text range
  is written as a note at the start of its range (`comment_export.rs`, in a copy of the scene):
  root text first, then each reply as a paragraph `Author: text`; InDesign reads it as one note of
  those paragraphs, with the root's author and dates. The loss list (`paged export --format idml`
  prints it as `lost in translation to IDML: ...`) names every thread IDML cannot carry, with its id,
  anchor kind and reason: a document thread (item, page, region, cell) is dropped, a folded reply
  and a resolved state are reported, and a range comment whose text is gone is dropped.
- Not yet: the format readers and writers for Word (people, mentions) and Excel (threaded comments,
  editable); writing a PDF thread's kept annotation back on export (it is read and kept, 2026-11-02); a
  document thread as an IDML note on its item's story (they are reported, not carried).

## Verification

- Round trips against the oracles: Word, Excel and PowerPoint 16 open what paged writes with no
  repair prompt and keep threads, replies, status, authors and mentions; Acrobat shows the
  annotations and states; InDesign opens the IDML with its notes.
- Goldens for unchanged threads (byte identity) and for edited ones (re-render keeps markers).
- The SDK harness covers `comments@1`; the CLI verbs have goldens.
