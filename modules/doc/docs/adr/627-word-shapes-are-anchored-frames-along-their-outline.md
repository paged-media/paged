# ADR 627 — Word's shapes without text are anchored frames drawn along their outline

- **Status:** Accepted 2026-11-08. Presets listed below and literal-point custom geometry; the rest told.
  Amended 2026-11-08: the doc wasm's ceiling is 9 MiB (see the amendment); the presets are
  evaluated by `dml-geom` since ADR 629, which removed the hand port. Amended 2026-11-09: no
  fixed upper bound on later raises (amendment 2).
- **Scope:** `docx-core` (`Shape`, `ShapeGeometry`), `docx-import` (`objects::drawing_shape`),
  `docx-lower` (`shape_geom`, `LoweredShape`), `docx-skeleton` (`body`), the engine's
  `AnchoredFrame` outline (engine ADR 1050, amendment 2026-11-08).
- **Builds on:** ADR 614 (floats and text boxes as anchored objects), 618 and 619 (the shared
  DrawingML reader and mapper, looks on anchored frames), 625 (the native body).

## Context

A `wps:wsp` without a text body (a rectangle, an ellipse, a line, a freeform) was counted as a
drawing that is not a picture and not shown. The capability register asked for them through
`dml-geom`, and the engine's live shapes (ADR 1047) for the result. Two things stand in the way:

1. A live shape (polygon sides, pie angles) is an item of a spread. A Word shape floats with its
   text and wraps it, which only an anchored object does, and `AnchoredFrame` held no outline
   (rectangle, text frame, group).
2. `dml-geom` evaluates the 187 presets from `presetShapeDefinitions.xml`, 526 KB that
   `include_str!` puts in the binary; the doc wasm has about 50 KB of room under its 8,388,608 B
   ceiling.

## Decision

- **The engine holds the outline.** An anchored frame has the free Rectangle's path fields
  (engine ADR 1050, amendment 2026-11-08); the anchored pass draws it along them. This is the
  only engine change, and it is additive.
- **Read.** `docx_import::objects::drawing_shape` reads a non-text `wps:wsp` through the tree reader
  already used for looks: the preset name and its `a:avLst` guides, or an `a:custGeom` whose
  points are literal numbers (`moveTo`, `lnTo`, `quadBezTo`, `cubicBezTo`, `close`; a guide
  reference or `arcTo` is `Unsupported`), `a:xfrm` rotation and flips, and the look through the
  shared DrawingML reader. A shape in Word's gallery states no fill or line: it leaves both to
  `wps:style`, whose `a:fillRef` and `a:lnRef` give the colour and the theme's line style
  (`idx` 1 to 3 are 0.5, 1 and 1.5 pt); they complete the look when `wps:spPr` is silent.
  A theme gradient fill style (`idx` 2 and 3) is drawn as the solid colour of the reference.
- **Outline.** `docx_lower::shape_geom` is a hand port, after Annex D, of the presets Word's gallery
  uses most: the rectangle family (`rect`, `roundRect`, the flow-chart process), `ellipse`,
  `triangle`, `rtTriangle`, `diamond`, `parallelogram`, `trapezoid`, `hexagon`, `octagon`,
  `rightArrow`, `leftArrow`, `line` and `straightConnector1`, with their `adj` guides, and the
  literal custom geometry scaled from each path's own space. `dml-geom` is not linked: its
  definitions do not fit the doc wasm. Flips and rotation turn the anchors about the box's centre.
  A preset not listed, a custom geometry with guides or an arc, and a shape in a table cell are
  not drawn and each is a warning on open ("NOT shown", naming the preset), as a text box in a cell is.
- **Place.** `lower_shape` anchors the shape as a text box is (a float at Word's position with
  Word's wrap, an inline shape a character of its line), and `body.rs` makes an anchored Rectangle
  frame carrying the anchors, with the look painted by the same `paint_frame` as a picture's.
  An embedded placement (the batch builder) takes no shapes yet and pours the TypeScript way.
- **Save.** Nothing is written: the drawing stays in the file as it was, byte for byte.

## Not done

- Line ends (arrow heads) are not drawn; the lowering says how many shapes have them (drawn since
  ADR 629).
- A shape's text wrap is its box (a triangle wraps text as its bounding box); rotation turns the
  outline, not the wrap.
- IDML export writes the frame's box; moving or resizing a shape on the canvas moves its box and
  the outline stays in the box's own coordinates (it does not scale).
- Presets not listed, shapes in groups (`wpg:wgp`) and in table cells.

## Size

The doc wasm (release, `wasm-doc` profile, wasm-opt) measured on this change: 8,338,053 B with the
embedded fonts (ADR 626) and 8,377,028 B with the shapes on the author's machine; CI's `doc / rust`
build of main reports 8,379,940 B, which leaves 8,668 B under the manifest's 8,388,608 B ceiling
(the shapes cost about 39 KB, the fonts about 12 KB). That is too little for a chart reader and its
drawing (`dml-chart`'s reader alone is over a thousand lines) or for the SmartArt drawing part's
reader: both need a second wasm artifact (the manifest's `wasm[]` takes several, each with its own
ceiling) or a decision on the ceiling. Neither is part of this record.

## Evidence

- `docx-lower` `shape_geom` tests: triangle apex by `adj`, rounded corners by the short side,
  ellipse anchors, a flipped and a turned line, an undrawn preset named, a custom path scaled and
  left open when `fill="none"`.
- `docx-conformance` `shapes` (nextest): the seven cases read, `wps:style` completing the look,
  the outlines lowered, the preset it does not draw told, an unedited save byte-identical.
- `docx-skeleton` `body_native`: the whole body stays native and each shape is an anchored
  Rectangle with its anchors, fill, stroke and wrap.
- `paged-renderer` `anchored_effects`: an outlined anchored frame leaves the box's corner paper.
- `test/headless/shapes.spec.ts` (real engine): the triangle fills half of its box, the freeform
  less than its box, the rounded rectangle and the rectangle are painted.

## Amendment (2026-11-08): a 9 MiB ceiling for the doc wasm

The owner decided to raise the ceiling of `docx_js_bg.wasm` for charts and SmartArt rather than
ship a second wasm artifact, by as much as they need plus headroom and at most to 10 MiB. The
manifest's `maxBytes` goes from 8,388,608 B to 9,437,184 B (9 MiB), one raise shared with the
equations' reader (engine ADR 1090), which landed the same value first. Charts (ADR 628) measure
8,529,596 B on the author's machine (CI's number is in ADR 628); the rest is the headroom for the
SmartArt drawing part. With SmartArt and `dml-geom` (ADR 629) the editor's `dist/` budget goes to
74.25 MiB (PM-0013, amendment 6).

## Amendment 2 (2026-11-09): no fixed upper bound

The owner removed the 10 MiB bound of the first amendment. The manifest's `maxBytes` stays the
ceiling the build enforces (9,437,184 B today), and a feature that needs more raises it in its own
commit by what it measures plus headroom, recorded in the ADR that needs it. What still bounds it
is the plugin wasm limit of `scripts/build-wasm.sh` (100 MB) and the editor's `dist/` budget
(PM-0013).


## Amendment 3 (2026-11-09): the Word oracle

The `shapes` fixture (`dump-fixture <out> shapes`) was saved as PDF by Word 16 for macOS and drawn
by the doc bundle on the real engine. The fixture's styles part has no `w:pPrDefault`; Word then
spaces paragraphs 10 pt apart (23.5 pt from line to line at 11 pt Calibri, 13.5 pt with an explicit
`w:spacing w:after="0"`), so the comparison was made on a copy with that default written out.

- **Matches:** every preset's outline (rectangle, ellipse, the triangle's adjust, the line, the
  rounded rectangle turned a quarter, the freeform, the cloud callout, the line with an oval head
  and a large triangle tail), the theme-styled ellipse's fill and outline, and the floating shapes'
  positions and square wrap.
- **Fixed: an inline shape's line.** Word makes a line holding an inline shape (or chart, SmartArt
  or text box) as tall as the object; the lowering kept such a paragraph at Word's fixed pitch, so
  the object rose over the lines above. It now takes auto leading as a picture's paragraph does
  (`docx-lower`, the same rule as engine ADR 1090 amendment 3).
- **Open: an object after the paragraph's last character** is anchored one character earlier
  (`anchor_at`: the engine cannot address the paragraph's end), so the last character stands after
  the object (paged draws "Shape rec", the object, "t" where Word draws "Shape rect" and the
  object). Counted in the import's losses.
- **Open: no `w:pPrDefault`.** Word's 10 pt space after for a styles part without paragraph
  defaults is not applied (paged reads the absent default as 0). Word itself always writes the
  element; other writers may not.
