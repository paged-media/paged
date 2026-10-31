# ADR 711 — The PowerPoint parity program; export keeps untouched slides byte for byte

- **Status:** Accepted 2026-10-24. Amends [ADR 704](704-pptx-export-regenerates-slides.md)
  (identity per slide, not only per deck) and [ADR 703](703-slide-data-storage.md) (item
  metadata).
- **Scope:** `pptx-export`, `slide-native`, `slide-resolve`, `slide-js`,
  `packages/slide-bundle` (`deck-export.ts`, `activate.ts`, manifest)

## Context

paged.slide imports PowerPoint decks well, but export (ADR 704) was only partly built. It copied
the original package and rewrote only the slide list, hidden flags and notes. A slide whose content
changed was written as the deck had it, with a warning. Slides made in the editor were dropped.
Text hyperlinks were read and then lost, and shape click actions were not read at all.

The parity program brings paged.slide to what PowerPoint does, in waves: export, show, masters
and themes, live content, animations, files. Its first wave is "nothing is lost on export". That
wave needs four decisions: where export reads the document from, how an edited slide is
written, how a slide made in the editor is written, and what happens to links.

## Decision

- **The program.** Slide ADRs 712–721 are reserved for its later waves (two-level masters, live
  theme, timeline model, and others).
- **Export reads the document through the host's documents door.** The bundle sends the
  document's `.paged` serialization (`host.documents.exportPaged`, which the manifest now asks
  for) along with the slide plan. The plan gives each page's id, its source slide part, its
  layout, its hidden flag and its notes. `pptx-export` reads the native model with the engine's
  own codec (`paged-store`), so `pptx-export` is the second crate built on the engine's model
  crates, after `slide-native`. It also rebuilds what import made of the original deck with
  `slide-native`, as the baseline to compare against. The engine opens an imported deck to the
  same model and serializes it back unchanged (checked on four fixtures), so comparing against
  the baseline finds exactly what the user edited.
- **Byte identity per slide.** A slide part, its relationships and its notes are rewritten only
  when something about that slide changed. Untouched slides, `presentation.xml` (while the slide
  list stays the deck's own) and every other part keep their original bytes. An unedited
  document still exports the original file.
- **An edited slide is its original XML, edited where it changed.** Import labels every element of
  a slide's shape with the shape's key (`<slide part>#<cNvPr ids from the tree down>`, `…#bg` for
  the background), its placeholder, its preset (`prst`, `adj`) and its click action. These labels
  move with duplicates. For each shape, export compares the document's items with the baseline's:
  - **Same items:** the shape's XML is kept verbatim, including anything paged does not model.
  - **Edited:** only the edited parts are rewritten:
    - Placement becomes `a:xfrm` in the parent's space; groups compose, and a group's members
      follow its new child space.
    - A reshaped outline becomes `a:custGeom`. A resized preset stays a preset.
    - Fill and line are rewritten.
    - Text is rewritten paragraph by paragraph. A paragraph that is unchanged keeps its XML. A
      changed one is written as differences from its inherited defaults: the list level from
      `Body Ln`; alignment, indents, spacing and bullets; size, typeface, weight, slant,
      underline, strike, caps and tracking; colour as `a:schemeClr` while the swatch still holds
      the theme colour, else `a:srgbClr`; hyperlinks. The defaults come from the resolver itself,
      run on a probe slide that holds the same shape with one bare run per list level. So what
      export leaves out reads back as what import draws.
    - Pictures get a new crop (`a:srcRect`) or a new image part.
    - Table cells get new text; column widths and row heights are rewritten.
  - **Made in the editor:** the shape is written whole (`p:sp`, `p:pic`, `p:cxnSp`, `p:grpSp`).
  - **Deleted:** the shape is dropped.
  - **Never drawn** (hidden shapes, OLE objects, content parts): the shape keeps its place.
- **A slide made in the editor** becomes a new slide part on its layout. Its placeholders are
  written as `p:ph` with the layout's type and index. Their placement and text are differences
  from what the empty placeholder would inherit, worked out by the same baseline-and-probe
  comparison. Anything else on the page is written as new shapes.
- **Links.** A text run's `a:hlinkClick` becomes the engine's text hyperlink: a `Hyperlink` with
  a URL or page destination. A show action (next slide, end show, …) becomes a `ppaction://`
  URL destination. Export writes these back as `a:hlinkClick` with relationships. A link to a
  slide points at the part that slide is written as. The engine has no page-item hyperlink
  source, so a shape's click action is kept in its item metadata and written back with the shape.
  A link to a slide the document deleted is removed, together with its relationship, and the
  export reports it. A dangling relationship would make PowerPoint repair the file.
- **Never corrupt.** Each written slide must parse as XML. A shape or slide that cannot be
  written faithfully is written as the deck had it, or left out in the case of a new slide. Each
  case is listed in the export's `notExported`, which the bundle shows as the export's
  diagnostics. Today that covers changes to effects, edits inside charts and SmartArt, added or
  merged table rows and columns, skewed placements, and font styles other than bold and italic.
- A host without the documents door gets the earlier behaviour: slides are written as the deck
  had them, and pages whose content fingerprint changed are reported.

## Consequences

- Any slide edit the native model can express is written, and nothing else in the deck changes.
- Export has a defined place for every later wave: transitions, timing, masters and live presets
  get writers of their own next to these.
- Export re-imports and re-resolves the original deck, and resolves one probe slide per edited
  slide. That costs about what an import costs.
- The engine's model crates are now read by two crates of this module. The `.paged` model part is
  read with the engine's own codec, so a format change is a compile error here, not a silent
  misread.
- Editing a swatch's colour (palette edits) does not mark the shapes that use it as edited.
- Engine needs that later waves may raise: a page-item hyperlink source (planned with engine
  ADR 1026's wire bump), so shape actions live in the engine rather than in labels.

## Amendment (2026-10-25): comments are read, shown and written

Wave 1 asks for PowerPoint's threaded comments to survive a round trip. The engine's notes
(engine ADR 172) are anchored in text, plain and single-level; a slide comment sits on the slide
or on a shape and has replies and a status. So comments are kept by this plugin, not the engine.

- **Read.** `pptx-import` reads modern threaded comments (`ppt/comments/modernComment_*.xml`
  through the slide's `…/2018/10/relationships/comments` relationship, authors from
  `ppt/authors.xml`, namespace p188): text, author, created, status, replies, a position
  (`p188:pos`, EMU) or a shape anchor (`ac:deMkLst` / `ac:spMk`). Legacy comments
  (`p:cmLst`, `commentAuthors.xml`, `p:pos` in 1/8 pt) are read into the same model. Both units
  were confirmed against PowerPoint 16, which converted a legacy comment at (800, 400) into a
  modern one at (1270000, 635000): 100 × 50 pt either way. Text is plain, one paragraph per
  line; run formatting and @mentions are not modelled. The comment's own XML is kept beside it
  in Rust (never in the JSON) for re-emission.
- **Kept.** The import report carries each slide's comments. The bundle stores them in the
  container part `comments/comments.json`, keyed by the page each slide opened as (ADR 703's
  deck-level parts): they follow a slide wherever it moves, a duplicated slide starts without
  any, and edits to them are not on the undo stack.
- **Shown.** A Comments panel lists the active slide's threads (replies, Resolve / Reopen,
  Delete, a reply box, a new-comment box, "Show resolved"). Each open thread is marked on the
  slide with its author's initials on the host's retained overlay layer (`host.overlay.layer`);
  a thread without a position stacks in the slide's top-left corner, and resolved threads are
  not marked, as in PowerPoint. Typed commands add, reply to, resolve and delete comments for
  scripts; New comment from the palette raises the panel.
- **Written.** The export plan gives each page its comment list (`SlidePlan.comments`); without
  one (a document opened before comments were kept) the deck's comments are written as they
  were. A list equal to the source slide's, as far as the model goes, keeps the slide's bytes,
  and an unedited deck still exports its original file. Otherwise the slide's comments are
  written as one modern part (`modernComment_<sldId hex>_<hash>.xml`), with its slide
  relationship, the `p188:commentRel` entry in the slide's `p:extLst`, the content-type
  override, and `ppt/authors.xml` extended or created (new authors get `userId` = name and
  `providerId="None"`; a GUID is derived for an id that is not one). An unchanged comment is
  written from its own XML while its slide keeps its id; an edited one keeps its markers while
  its anchor shape is the same, and is otherwise re-anchored to the shape. Legacy comments on a
  slide whose comments changed become modern ones and their legacy relationship is dropped. An
  empty list removes the relationship, the extension and the part. A duplicate never shares its
  source's part, a slide made in the editor gets its own, and comment parts no written slide
  refers to are removed.
- PowerPoint 16 opened and re-saved every deck the tests write (edits, deletions, a duplicate,
  a legacy conversion, a first comment in a deck without any, a comment on a new slide) without
  a repair prompt, and kept the comments; it drops the milliseconds of `created` on save.
- Not modelled: likes, assignment, due date, priority and title. They survive only while their
  comment is unchanged. Range comments and threads in the engine (engine ADR 1020) would let a
  later wave move slide comments into the document model.

## Amendment (2026-10-29): theme colours and the theme part

[ADR 713](713-live-theme.md): a theme colour is a swatch whose id is its key (slot and
transforms), written as `a:schemeClr` with its transforms whatever its current value, not only
"while the swatch still holds the theme colour". The theme the document shows (its slot swatches,
the root styles' fonts) is written into the masters' theme parts when it is not the deck's, so an
edit to a slot swatch is exported as a theme edit.
