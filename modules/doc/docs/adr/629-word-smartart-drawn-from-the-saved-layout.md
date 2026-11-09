# ADR 629 — SmartArt is drawn from the layout Word saved; shapes take every Annex D preset and their line ends

- **Status:** Accepted 2026-11-08.
- **Scope:** `docx-core` (`DiagramDrawing`, `Run::diagrams`), `docx-import` (`diagram`,
  `objects::drawing_diagram`), `docx-lower` (`diagram`, `shape_geom`, `LoweredGroup`),
  `docx-skeleton` (`body::group_frame`), the doc manifest's wasm ceiling (ADR 627 amendment).
- **Builds on:** ADR 627 (shapes as anchored frames along their outline), 628 (charts as anchored
  groups); slide's reading of the same drawing part (`paged_ooxml::tree` maps `dsp:` onto
  PresentationML's shape tree).

## Context

A SmartArt diagram in a Word document is a `w:drawing` whose graphic is a `dgm:relIds` naming four
parts: the diagram's data (its nodes and text), layout definition, style and colours. Laying a
diagram out from those is SmartArt's layout engine, which no format specifies in full. Word
also saves the result: the data part's `dsp:dataModelExt/@relId` names a drawing part
(`word/diagrams/drawingN.xml`, a `dsp:drawing`) whose shape tree holds every shape of the last
layout with its geometry, look, text and the box the text is set in. Doc counted the drawing as
one it does not carry.

SmartArt's shapes use presets beyond the fourteen ADR 627 ported by hand (chevrons, home plates,
block arcs, circular arrows, …). `dml-geom` evaluates all 187 from ECMA-376 Annex D's definitions
(526 KB of XML in the binary), which did not fit the doc wasm before its ceiling was raised.

## Decision

- **Draw the saved layout.** `docx_import::diagram` follows `r:dm` to the data part, its
  `dataModelExt` to the drawing part (both among the document part's relationships), and reads the
  shape tree: each `dsp:sp` as a Word shape is read (the outline, `a:xfrm` rotation and flips, the
  look completed from `dsp:style`, ADR 627), placed in the diagram's box through its groups'
  `a:chOff` / `a:chExt` mappings, with its text (`a:p` runs: text, size, weight, colour or the
  style's `a:fontRef` colour, Latin face; alignment and line spacing), `a:bodyPr` insets and
  anchor, and `dsp:txXfrm` box. Nothing of the layout definition is evaluated.
- **A diagram without a drawing** (written by a tool that does not lay it out) stays a drawing
  that is not carried, and the open says so as for any other.
- **Lower and build as a chart.** `docx_lower::diagram` makes one anchored group per diagram (the
  chart's `LoweredGroup`, renamed from `LoweredChart`): each shape an outlined piece in its box
  with its look through `dml-native`, each text a text frame over its text box with the insets and
  Word's anchor as the frame's vertical justification, its paragraphs lowered as a chart label's
  (direct formatting, the theme's faces for `+mn-lt` / `+mj-lt`). `docx-skeleton` builds charts and
  diagrams with one `group_frame` (`docx_chartN`, `docx_diagramN`). A diagram in a table cell is not
  placed and is told, as a chart is.
- **Every Annex D preset.** `docx_lower::shape_geom` evaluates presets with `dml-geom` (slide's and
  sheet's evaluator) instead of its hand port of fourteen, which is removed: Word's shapes and
  SmartArt's take all 187 presets with their guides. A contour Annex D does not fill (a detail
  line) is drawn open. Literal custom geometry keeps its reader.
- **Line ends.** A shape whose outline is open (a line, a connector, an arc) draws its `a:headEnd`
  and `a:tailEnd`: `triangle`, `stealth`, `diamond` and `oval` filled in the line's colour, `arrow`
  stroked with the line, sized as Office sizes them (`sm`, `med`, `lg`: 2, 3 and 5 times the line's
  width, at least 0.75 pt), the tip on the line's end and pointing along it. Such a shape is an
  anchored Group of the shape and its heads (`docx_shapeN_0`, `docx_shapeN_hK`), placed as the
  shape. A closed outline takes none, as in Office; a kind not listed is told. The line is not
  shortened under its head.
- **Save.** Nothing is written: the drawing, the data, layout, style, colour and drawing parts stay
  as they were, byte for byte.

## Not done

- A diagram is not edited as a diagram (adding a node, retyping its text in the data model): it
  is drawn, and its parts round-trip.
- Rotated text boxes (`dsp:txXfrm/@rot`) are set unrotated.

## Size

Measured on this change (release, `wasm-doc`, wasm-opt), on the author's machine: 9,117,482 B,
from 8,529,596 B with charts (ADR 628); `dml-geom` with its definitions is about 564 KB of that,
the diagram reader and lowering about 12 KB, the line ends about 12 KB. That is under the 9 MiB
ceiling of ADR 627's amendment with 320 KB to spare. The editor's `dist/` budget goes to 74.25 MiB
for it (PM-0013, amendment 6).

## Evidence

- `docx-conformance` `smartart` (nextest): the diagram read from its drawing (four presets, the
  chevron placed and halved by its group, the three texts with their insets, anchor, line spacing
  and the style's font colour), the diagram without a drawing not carried; lowered to four filled
  outlines (the chevron's six corners from Annex D) and three text frames; the diagram's six parts
  byte-identical after an unedited and an edited save.
- `docx-lower` `shape_geom` tests: presets through `dml-geom` (the triangle's apex, the stadium,
  the ellipse, the cloud callout and the chevron), a name that is not a preset told.
- `docx-conformance` `shapes`: all eight cases drawn (the cloud callout too); the arrow's oval and
  large triangle in the line's colour, the triangle's tip on the line's end.
- `docx-lower` `shape_geom`: an open arrow and a triangle on a line's ends, none on a rectangle.
- `docx-skeleton` `body_native`: the diagram is an anchored Group of four outlined Rectangles and
  three TextFrames centred over their text boxes; the shapes fixture has seven outlined frames and
  the arrow as a Group of its line and two filled heads.
- `test/headless/smartart.spec.ts` (real engine): the shapes are painted in the theme's accents; an
  unedited export keeps the diagram's parts.

## Amendment (2026-11-09): the Word oracle

- **Word lays SmartArt out again on open.** Word 16 for macOS draws the `smartart` fixture's first
  diagram from its data and layout parts, not from the saved drawing (the fixture's drawing does
  not match its layout part), and draws the diagram without a drawing part as well (a basic
  process: three rounded boxes and two arrows). Re-saved by Word, the package carries Word's own
  drawing for both, and paged draws that file's diagrams as Word does: the same boxes, arrows,
  colours and text.
- **The line holds the diagram (fixed).** An inline diagram's paragraph takes auto leading
  (ADR 627 amendment 3); before, the diagram rose over the paragraph above it.
- **Open (as decided):** a diagram without a saved drawing is not drawn; Word draws it from its
  data and layout.
