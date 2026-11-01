# ADR 614 — Floating objects and content controls

- **Status:** Floating objects accepted 2026-10-29 (wave W4a); amendment 1 accepted 2026-10-30
  (wave W4, engine ADRs 1025 and 1050). Content controls: pending.
- **Scope:** `docx-core` (`objects.rs`: `TextBox`, `Language`, `Borders`, `TableLook`,
  `CellLook`, `NestedTable`, `HeightRule`; `Float::wrap_polygon`), `docx-import`
  (`objects.rs`), `docx-lower` (`objects.rs`, `ir_objects.rs`: `LoweredAnchor`,
  `LoweredPageItem`, `LoweredCellLook`, `LoweredTableLayout`), `docx-skeleton` (`items.rs`),
  `docx-export` (`textbox.rs`), `doc-host-model` (anchored floats, cell looks, the table
  paragraph's style), `doc-bundle` (`page-items.ts`).
- **Builds on:** engine ADRs 139 / 143 / 151 (text wrap on page items, anchored objects with
  custom positions), 176 (nested tables), 103 (hyphenation by applied language); doc ADRs 602,
  603, 606, 610, 611.

## Context

The import read Word's floating drawings (`wp:anchor`: position, wrap, distances) and placed
every one inline with a warning; it counted text boxes (`wps:txbx`, `v:textbox`) and dropped
them; it dropped tables nested in cells, with their text; it read no table borders or shading,
no `w:lang`, and ignored `w:trHeight/@w:hRule`. The engine audit for wave W4 found the engine
holds most of what these need. This wave maps Word onto what the engine already has, with no
engine change.

What the plugin can reach is what the wire can make. Checked against the wire
(`paged-wire`, protocol of 2026-10-29):

| Needed | On the wire |
| --- | --- |
| A positioned anchored picture | `insertAnchoredFrame` (a graphic frame) + `setElementProperty` `anchored*` through a batch handle — yes |
| Text wrap on an anchored object | no: `AnchoredFrame` has no `text_wrap`; `frameTextWrap*` resolves page items only |
| Text wrap on a page item | `frameTextWrap*` — yes; and the skeleton can write it (ADR 606) |
| An anchored TEXT frame (a text box that follows its paragraph) | no: `insertAnchoredFrame` always makes a rectangle |
| A table inside a cell | no: `insertTable` takes a story, `TextCellAddr` names top-level tables only |
| Cell edges and fill | `cell*EdgeStroke*`, `cellFillColor` — yes |
| A row held at an exact height (`AutoGrow`, `MaximumHeight`) | no: `setRowHeight` sets the floor only |
| A table indent | no: the table stands at its column's edge |
| A table's alignment | yes: the table is a character of its own paragraph, whose justification places it |
| The applied language | `characterLanguage` — yes |
| Where a story offset lands after layout (which page) | no read answers it; generated pages exist only once requested |

## Decision: floats

**Where the lowering knows the page, a float is a PAGE ITEM; elsewhere it is an ANCHORED
OBJECT of its paragraph.** The plugin cannot learn after layout which page Word's anchor
paragraph lands on (no read maps an offset to a page, and the editor generates pages as they
scroll into view), so a page item is only possible where the page is known at import:

- a float or text box anchored in the **first paragraph of a story** (a section that starts a
  page): it stands on that story's authored page (`docx_p{k}`), its paragraph at the frame's
  top;
- every float and text box of a **header or footer**: it stands on each master that shows the
  part, and so on every page Word prints it on.

`docx_lower::objects::plan_page_items` plans them (ids `docx_o{n}`, a text box's story
`docx_o{n}_s`); the standalone skeleton writes the frames (a graphic frame holding the
picture, or a text frame with an empty story, its insets, its fill and outline), Word's text
wrap, and the z-order (`behindDoc` under the page's text frame). The bundle pours the text
boxes' stories. An embedded placement makes the first page's items in its batch.

Page items wrap the text (engine ADRs 139/151):

| Word wrap | Engine wrap |
| --- | --- |
| `wrapSquare` | `BoundingBoxTextWrap`, `distL/T/R/B` as offsets, `wrapText` as the side |
| `wrapTopAndBottom` | `JumpObjectTextWrap` |
| `wrapTight`, `wrapThrough` | `ContourTextWrap` on the graphic frame (`wp:wrapPolygon` is carried in the IR) |
| `wrapNone`, `behindDoc` | none; behind the page's text frame when `behindDoc` |

Anchored objects (everywhere else) take Word's position through
`docx_lower::objects::anchor_for`:

| Word | Engine | Why |
| --- | --- | --- |
| top and bottom (any reference) | `AbovePosition`, aligned in the column (left / centre / right; a horizontal offset rounds to the nearest of the three) with `distB` as the space after | The text resumes below the picture as in Word, so the paragraph takes Word's room; the band starts at the anchor line, not at Word's vertical offset |
| square / tight / through with less than 36 pt of text room beside it | as top and bottom | Word sets no line in such a gap |
| square / tight / through | `Anchored` (custom) at Word's position | The picture stands where Word draws it and follows its paragraph; the engine's anchored objects take no wrap yet, so text runs under it until they do |
| in front of / behind the text | `Anchored` at Word's position | Word does not displace text either; exact but for z-order |

The references: `page` → `PageEdge`, `margin` → `TextFrame` (the story frame is the margin
box), `column` → `ColumnEdge`, `character` → `AnchorLocation`, `paragraph` / `line` →
`TopOfLeading` (a paragraph-relative float is anchored at its paragraph's start, so the line
is the first); `leftMargin`, `rightMargin`, `topMargin`, `bottomMargin`, `inside` / `outside`
margins → `PageEdge` with Word's position in the band computed by the lowering; `align`
left/centre/right (top/centre/bottom) → the alignment and the matching anchor corner;
`posOffset` → the near corner plus the offset; `pctPos*` → the offset as the share of the
reference; `simplePos` → `PageEdge` both ways.

**Page-relative with wrap: page item where possible, else anchored.** A page item is exact
(position and wrap) on the page it stands on; it does not move when edits push its anchor
paragraph to another page, which Word's float would. An anchored object always follows its
paragraph but cannot wrap yet. Where the page is known the page item is closer to Word for
what a reader sees and for pagination (the wrap takes its room); elsewhere only the anchored
object can stand on the right page at all.

## Decision: text boxes

Read from `wps:txbx/w:txbxContent` (the `mc:Choice`; the `mc:Fallback`'s VML copy is not read
again) and from legacy `v:textbox` (`v:shape`, `v:rect`), with their extent, position, wrap,
insets (`wps:bodyPr` / `v:textbox/@inset`) and look (`wps:spPr` through the shared DrawingML
reader, doc ADR 618). Each gets its ordinal among the part's `w:txbxContent`s outside an
`mc:Fallback`, in document order. A table or content control inside a box is flattened into
its paragraphs, held.

Placed as page items where the page is known (above). Elsewhere a text box needs an anchored
text frame, which the wire cannot make: it is not shown, a warning says so, and it round-trips
untouched.

**Save-back:** the bundle reads each text box's story back (`structure.textBoxes`); an edited
box is spliced into its `w:txbxContent` with the body's machinery (doc ADR 611's way for
headers): its content is cut out of the part, wrapped as a small part whose root holds
paragraphs as `w:body` does, diffed and patched there, and put back. The `mc:Fallback`'s VML
copy takes the same edit when its paragraphs say what the box said, else the ledger names it.
A box holding a table or content control refuses edits. An unedited save is byte-identical.

## Decision: tables

- **Nested tables** are read whole into `TableCell::nested_tables` (for the native lowering
  once the wire can make a table in a cell) and shown, where they stand, as their cells'
  paragraphs in reading order, held: the patcher never addresses them (they are not the
  cell's `<w:p>` children), so the cell's own paragraphs keep their ordinals and a nested
  table round-trips untouched. A warning counts them.
- **Borders and shading:** each cell's four edges as Word resolves them — the cell's
  `w:tcBorders` side, else the table's `w:tblBorders` over its table style chain's (the default
  table style when it names none): the outer side at the table's edge, `insideH` / `insideV`
  between cells; a vertically merged cell takes the last merged cell's bottom. Every edge is
  set (weight 0 for none), so a borderless Word table no longer shows the engine's 1 pt
  default. The fill is the cell's `w:shd`, else the table's, else its style's. Table styles'
  conditional regions are not applied (an info diagnostic).
- **`w:jc`** centre / right: a synthesized paragraph style with that justification on the
  table's own paragraph, applied after its cells.
- **`w:trHeight/@w:hRule`:** `auto` ignores the height; `atLeast` and `exact` set the row's
  floor (exact rows grow with their text: no fixed height on the wire, an info diagnostic).
- **Carried for the engine work** (`LoweredTable::layout`): `w:tblLayout`, `w:tblW`, `w:tcW`,
  `w:tblInd`, `w:cantSplit`, the exact rows.

## Decision: language

`w:lang` is read per run, style and document defaults (`val`, `eastAsia`, `bidi`); the Latin
tag becomes the character property `characterLanguage` in InDesign's names, which the engine's
hyphenation resolves (`en-*` → `English: USA` / `UK` / `Canadian`, `de-*` → `de_DE_2006` /
`de_CH_2006`, `fr`, `es`, `it`, `nl`, `pt` likewise; a language without patterns keeps its own
name so it is not hyphenated as English; `x-none` → `[No Language]`). `rFonts`
`eastAsia` / `cs` and the East Asian and complex-script languages are read, not lowered.

## Consequences and residuals (engine work)

- `AnchoredFrame.text_wrap` (and behind-text z-order, `allowOverlap`): square, tight and
  through floats past a story's first paragraph would wrap; top-and-bottom ones could keep
  Word's vertical offset.
- An anchored text frame on the wire (`insertAnchoredFrame` with a text kind minting a story):
  every text box would be placed; the lowering already carries its position and paragraphs.
- `insertTable` into a cell (a `TextCellAddr` that names a nested table): native nested tables.
- A row's `AutoGrow` / `MaximumHeight` on the wire: exact rows. A table indent in the engine's
  table placement: `w:tblInd`.
- A custom contour from `wp:wrapPolygon`.
- Pictures in table cells stay unsupported (their warning is unchanged).

## Evidence

- `docx-conformance/tests/it/objects.rs` on `objects_*_docx()`; Word's answers
  `fixtures/objects-*.word.json` (`scripts/word-objects-probe.sh`).
- `docx-conformance/tests/it/floats.rs` (the earlier float fixture, now placed).
- `doc-host-model/test/objects.spec.ts`; `doc-bundle/test/headless/objects.spec.ts`.

## Amendment 1 (2026-10-30): the engine work

Engine ADR 1050 (anchored objects that wrap, anchored text frames, tables and objects in table
cells) and engine ADR 1025 (Word tables: rows split across pages, autofit, indent, exact rows)
closed the residuals above, and the lowering uses them:

- **Floats.** Every float that is not a page item is an anchored object at Word's position
  (`Anchored`), with its layout (`LoweredImage::layout`, `insertAnchoredFrame { layout }`):
  square → bounding box, tight / through → contour on `wp:wrapPolygon`, top and bottom →
  jump object (a square, tight or through float with less than 36 pt of room beside it jumps
  the text too), `behindDoc` → behind the text, `allowOverlap="0"` → kept clear of the
  story's other floats. The band above the line (`AbovePosition`) is no longer used: the
  engine places a wrapping float before its paragraph's lines, so a top-and-bottom float keeps
  Word's vertical offset and the text resumes below it.
- **Text boxes** that are not page items are anchored text frames of their paragraph
  (`LoweredParagraph::text_boxes`): one batch inserts the frame (`kind: "text"`, its insets,
  wrap and z-order), sets its anchoring and look, and pours its paragraphs into its story
  through the frame's handle. Edits to their text are not saved back yet (the boxes
  round-trip unchanged; a diagnostic says so). Boxes in table cells are still not shown.
- **Nested tables** are native tables in their cells. The import keeps one empty held
  paragraph where a nested table stands (it no longer pours the table's text into the cell);
  the pour makes the table on that paragraph (`insertTable { cell, paragraph }`) and fills
  its cells through its handle. Edits inside a nested table are not saved back yet; the
  cell's own paragraphs keep their patcher ordinals and an unedited save is byte-identical.
- **Pictures in cells** are anchored frames in the cell's paragraphs
  (`insertAnchoredFrame { cell }`): inline ones characters of their lines (the row grows),
  floats standing against the cell.
- **Tables** are laid out by Word's rules (`insertTable { word }`, from
  `LoweredTable::layout`): `tblLayout` fixed or autofit, `tblW` and `tcW` (points or
  percentages), `tblInd`, `cantSplit`; rows with `hRule="exact"` are held at their height
  (`setRowHeight { autoGrow: false }`). A table with a row taller than its page is a native
  table whose rows split as Word's do; the earlier fallback that poured it as plain
  paragraphs (`flow_table`, a table with a row taller than its page) is gone.

## Content controls

Pending (wave W4b): a light inline control run kind (checkbox glyph, dropdown and date value,
plain-text range) with `w:sdtPr` read and written back, edited through a popover.
