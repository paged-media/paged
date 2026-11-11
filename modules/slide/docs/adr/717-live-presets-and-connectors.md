# ADR 717 — Live presets and connectors

- **Status:** Accepted 2026-10-25. Part of the parity program ([ADR 711](711-powerpoint-parity-program.md)),
  wave W4. Amends [ADR 711](711-powerpoint-parity-program.md) (item labels) and
  [ADR 704](704-pptx-export-regenerates-slides.md) (a resized preset).
- **Scope:** `platform/shared/dml-geom` (was `slide-geom`), `pptx-core`, `pptx-import`,
  `slide-resolve`, `slide-native` (`live`), `pptx-export`, `slide-js` (`live`),
  `packages/slide-bundle` (`live-presets.ts`, `adjust-handles.ts`, `shapes.ts`,
  `panels/shapes-panel.tsx`, the manifest).

## Context

An imported preset shape became a native path: its outline drawn once, at import. Resizing it
stretched that path, so a rounded rectangle's corners turned into ellipses, and export wrote the
stretched outline as custom geometry. PowerPoint keeps such shapes as presets with adjust
values. Its yellow handles change those values, and a connector glued to two shapes follows them
when they move. The editor had no adjust handles and no way to insert a preset.

## Decision

- **The DrawingML geometry is a shared crate.** `slide-geom` moves to `platform/shared/dml-geom`
  (PM-0014: the lowest layer every consumer reaches; doc's shapes in its W4 take it next). It
  keeps its name in the slide workspace through a `package = "dml-geom"` alias. The geometry
  model (`CustomGeometry`, `GeomPath`, `PathCmd`) and its reader move with it, and `pptx-core`
  re-exports them. The reader also reads `a:ahLst` (adjust handles) and `a:cxnLst` (connection
  sites). Its `live` module holds the arithmetic:
  - **Refit:** fit the outline a preset drew for its last box onto the anchors the element holds
    now (a per-axis scale and offset, least squares, 0.05 pt). The fit recovers a host's resize,
    whether it scaled the anchors or the transform. The preset is then drawn again for the new
    box, and the scale moves out of the transform into the box. Anchors that fit no scale were
    reshaped by hand, and the shape stops being that preset.
  - **Adjust handles:** the adjust values that put a handle where the pointer is, each kept in
    the handle's range. They are found numerically: sampling plus golden section, or Newton
    steps on PowerPoint's unbounded ranges. Ranges are evaluated with the box in EMU, as
    PowerPoint evaluates them (`ssd2` is a length).
  - **Connection sites** on the page.
  - **A connector routed between two sites:** a box from the start site to the end site,
    flipped. An elbow or a curve leaving a site that faces up or down turns the box a quarter.
    This is how PowerPoint writes it; the `connectors` fixture shows the same boxes.
- **Labels say what a live preset needs** (extends ADR 711's labels):
  - `box: [w, h]`: the box the shape's outline was drawn for, on every element of a keyed shape.
  - `preset.flip`: the `a:xfrm` flips.
  - `connector.st` / `connector.end`: `{id, idx, at}`, the glued shape's `cNvPr` id, its site,
    and where that site was on the page when the connector was last routed. Import works it out
    from the slide's own shapes (`slide-resolve`), so an unedited page asks for nothing.
  - On a shape made in the editor: `shape: "new:…"` (its elements move together) and
    `part: "detail"` on its stroke-only detail element.
- **Edits are followed in the edit's undo step.** After a committed edit (a change event with an
  `appliedSeq`), the bundle gathers the labelled elements of the pages the edit touched and hands
  them to the slide engine in one wasm call (`live` `follow`). The engine answers the writes:
  - a resized preset, drawn again with its detail element and text frame;
  - a connector whose glued site moved, routed again.

  The bundle writes them with `mutate(…, { amend })` (extensions ADR 337, engine ADR 1004), so one
  undo reverts the edit and the redraw together. Undo and redo carry no `appliedSeq`, and are left
  alone. The engine's resize of one path item writes its bounds and not its anchors. Follow reads
  that as a resize too: anchors still the preset for the old box, with bounds that moved. A write
  sets the path's bounds with its anchors. Without `document.mutate.amend@1` nothing follows, and
  export writes a resized preset as custom geometry, as before.
- **Adjust handles go through the existing overlay door.** The PM-0014 overlay-handles door
  (extensions 340) is not on main, so the handles are a `contribute.overlay` contribution (the
  manifest asks for `rendering: ["overlay"]`). The host draws it in document space above the
  selection chrome, and a handle takes the pointer before the canvas does. A drag previews the new
  outline (SVG path data from the engine) and on release writes the new adjust values to every
  element of the shape as one undo step. No contract change was needed, so contract C3 of the
  program is not used. When door 340 lands, the handles move to it.
- **Insert ▸ Shapes.** The Shapes panel shows all 187 presets by PowerPoint's categories, drawn by
  the engine. The command `media.paged.slide.command.insertShapes` (Insert ▸ Shapes…) opens it.
  The typed command `media.paged.slide.insertShape` (`prst`, `slide`, optional `x`, `y`, `w`, `h`)
  serves scripts and the CLI. Either way, the engine draws the preset as page items for the
  host's paste door (`pasteElements`), which keeps each contour's open flag. That is one undo
  step. A new shape takes PowerPoint's default Office look (Accent 1, its line a shade darker,
  1 pt) until the deck's theme swatches are in the document (W3).
- **Export.** A live preset is an element whose anchors are still its preset for its labelled box.
  Export writes it as `a:prstGeom` with the label's `a:avLst`, and places it by its box, which its
  outline need not fill (a callout's tip, an arc). A connector keeps its `a:stCxn` / `a:endCxn`
  verbatim. A shape that did not change keeps its bytes.

## Consequences

- A resized rounded rectangle keeps its corner radius, an adjust drag reads back in PowerPoint,
  and connectors follow their shapes. All three were checked against the `connectors` fixture,
  which PowerPoint authored. On its slide 2, PowerPoint moved a shape and resized the rectangle.
  Our edit of slide 1 exports the same `a:xfrm` for the moved shape, the three re-routed
  connectors and the resized rectangle. PowerPoint opens the exported decks without a repair
  prompt.
- Follow costs one tree read, one geometry read, a path read per labelled path on the touched
  pages and one wasm call per page, after every edit on a deck.
- Not yet: a shape's text frame resized on its own does not resize its outline. A connector
  moved by hand stays glued (PowerPoint detaches it). There is no connector tool, no reconnecting,
  and no rerouting choice beyond the start site's direction. Elbow and curved connectors with
  more than one bend keep their adjust values when re-routed. Groups are not followed as targets.

## Amendment (2026-10-28): pictures, the format painter and SmartArt text

The rest of W4's live content that needs no engine change. Video and audio (engine ADR 1027),
effects parity (engine 1007/1008) and motion-path handles are not part of it.

- **Pictures in every format the engine reads.** `pptx-core::media` sniffs a picture's format
  by the signatures `paged-sniff` uses and reads its pixel size from the header. The slide
  crates may not build on the engine's raster crates, so the sniffing is written again here
  rather than shared. Insert ▸ Pictures… (`media.paged.slide.command.insertPicture`) places any of them on
  the active slide as a picture frame, at 96 pixels an inch and scaled down to fit the slide,
  in one undo step (`insertFrame`, `bindCreated` and `replaceImageBytes` through
  `mutateWithBytes`). Export writes PNG, JPEG, GIF, BMP and TIFF as they are, with a `Default`
  content type for each extension. **Every other format is written as a PNG of the frame**,
  because PowerPoint does not open WebP, PSD, TGA, QOI, ICO, AVIF, JPEG XL, HDR, EXR, DNG or EPS
  parts. The slide wasm decodes no pixels, so the host renders the frame: export reports the
  pictures it needs (`rastersNeeded`, an element id and a resolution: the image's own pixel
  density, at most 4096 px on the long side), the bundle renders them with
  `host.render.element` (`render.snapshot@2`) and the deck is written again with them. The
  PNG holds the frame's visible part, so no `a:srcRect` is written for it.
  ADR 723 narrows this: WebP, TGA, ICO and QOI are decoded by the exporter and written as
  PNGs of their own pixels; the host renders only the formats that need the engine's decoders.
- **SVG and icons.** An SVG stays vector in the document: the engine draws placed SVG as paths
  (engine ADR 190). Export writes it as PowerPoint does: an `a:blip` holding a PNG fallback,
  with an `asvg:svgBlip` extension (`{96DAC541-7B7A-43D3-8B79-37D633B846F1}`) naming the SVG
  part. The fallback is rendered by the host at 192 dpi. Import reads `asvg:svgBlip` (the
  shared `paged_ooxml` blip reader gains `Blip::svg`) and draws the SVG, not its fallback.
  Insert ▸ Icons… (`insertIcon`) takes SVG files only. There is no online icon library.
- **The format painter.** Copy formatting (`copyFormat`) takes the first selected shape's fill,
  line, transparency and effects (every `frameFill*`, `frameStroke*`, `frameGradient*` and
  effect path the engine reports) and its text's character and paragraph formatting (font,
  size, style, colour, underline, strikethrough, tracking, case, position, leading, alignment,
  indents, spacing), read from the first character. While text is selected, it takes the
  selected text's formatting instead. Paste formatting (`pasteFormat`) writes them in one
  batch, so one undo step, to every selected shape: the look goes on its outline, and the text
  formatting goes over its whole story. A slide shape is the elements that share its label key,
  so selecting its text frame paints its outline too. With text selected, the formatting goes
  to that text (`host.text.format`). The keys are Ctrl+Shift+C and Ctrl+Shift+V with their
  Cmd twins, scoped to the deck's document context. Geometry and size stay the target's.
- **The SmartArt text pane.** A diagram still imports as the drawing PowerPoint laid out, and
  there is no layout engine. `pptx-import` reads each data part's text points (a depth-first
  walk of the `parOf` connections) and what each drawing shape shows (its `presOf` sources, in
  `destOrd` order, with their paragraph counts). The importer labels the frame with the
  outline (`smartart`), and each drawing shape whose paragraphs match its points with those
  points (`dgm`). The Text Pane panel (`media.paged.slide.panel.smartart`, Slide ▸ SmartArt
  text pane) lists the selected diagram's points by level. An edit replaces the point's
  paragraphs in every shape that shows it, in one undo step. The new text goes in after the
  first old character and the old text is then removed, so the text keeps its formatting. The
  typed commands `media.paged.slide.smartArtPoints` and `setSmartArtText` do the same from a
  script. Export writes a diagram whose shapes changed only in their text to new data and
  drawing parts (`dataN.xml`, `drawingN.xml`; a duplicated slide may share the old ones),
  points the slide's relationships at them and keeps the relationship ids. In the data part,
  the edited points' `dgm:t` and, in the drawing part, the shapes' `dsp:txBody` paragraphs get
  the new text with the first old paragraph's `a:pPr` and `a:rPr`. A point that was an empty
  placeholder loses `phldr`.

Consequences and limits:

- Points are edited, not added, removed or moved between levels. A point no drawing shape
  shows is listed read-only. In a shape that shows several points, each point keeps its
  paragraph count: extra lines are joined with a space, and missing ones stay empty. Runs
  inside an edited point are written with its first run's properties. A formatting change to
  diagram text, or any other change inside a diagram, is still reported as not exported.
- An SVG's fallback for a cropped frame is its visible part, cropped again by the blip's
  `a:srcRect` in readers that show only the fallback. Before the host renders it, an SVG's
  fallback is a transparent pixel. A host without `render.snapshot@2` cannot export a picture
  in a format PowerPoint does not open, and the export names it.
- The format painter paints shapes, not table cells, and does not copy geometry, text-frame
  insets or autofit. Export writes the painted fill, line and text as it writes any such
  edit: effect changes the exporter does not yet write stay reported.
- The slide wasm grew by 95 KB (5.24 → 5.33 MiB).

## Amendment (2026-11-09): the adjust handles on the host's handle door

The adjust handles leave `contribute.overlay`. They are a host handle set
(`host.overlay.handles("adjust")`, extensions ADR 339): the host draws them at a constant screen size
and hit-tests them, and its Selection and Direct Selection tools hand a drag on one to the bundle
(`onHostDrag`, extensions [ADR 1103](../../../../platform/extensions/docs/adr/1103-host-tools-drag-a-bundles-handles.md)).
The drag's outline preview is an overlay layer (`adjustPreview`, the engine's path as cubic preview
shapes). What a drag writes is unchanged: the engine's adjust values for every element of the
shape, in one `document.mutate` on release, so one undo step; a cancelled drag (Escape) writes
nothing. The handles take the host's round handle look, not PowerPoint's yellow. The bundle shows
them only when `overlay.handles.hostDrag@1` holds. The overlay contribution, its DOM pointer code
and its own screen metrics are deleted.

## Amendment (2026-11-09): SmartArt text turns with its shape

A SmartArt drawing shape states its text box (`dsp:txXfrm`) in the drawing's space, unturned,
like its own `a:xfrm`; PowerPoint turns that box about its centre by the shape's turn plus the
box's own `rot`. A quarter-turned chevron of the vertical chevron list keeps its text upright with
`rot="-5400000"`; the horizontal multi-level hierarchy's root, turned 270 degrees with a text box
that states no `rot`, turns its text with it. `slide-resolve` placed the box at its offset from the
shape's corner inside the turned shape and ignored its `rot`, so the chevrons' text stood turned
and out of place. Now `smartart_text_box` takes the box's centre back through the shape's turn
and flips into the shape's own box and keeps its extent, and its `rot` is the text frame's new
`turn` (degrees about the box's centre, on top of the `vert` rotation, which alone swaps the box's
sides); `slide-native` turns the frame by both.

Evidence: the `rotated-text` fixture (written by PowerPoint 16 from
`tooling/oracle/office/powerpoint/fixtures/rotated-text.*`: slides 2 to 4 are a vertical chevron
list, a horizontal multi-level hierarchy and a manual-operation list, laid out by PowerPoint from
its own layout definitions) and the words PowerPoint drew in its PDF (`rotated-text.words.json`):
`slide-resolve` `oracle_diagrams::smartart_text_turns_as_powerpoint_drew_it` finds every word
inside the text frame we resolve for it and standing as that frame turns (the root's turned, the
rest upright). Slide 1 holds turned WordArt (engine ADR 1091, amendment 2).

## Amendment (2026-11-11): the live preset is the engine's

The mechanism of this ADR moved into the engine: an Office preset is an engine live shape
(engine [ADR 1096](../../../../engine/core/docs/adr/1096-an-office-preset-stays-a-live-shape.md)).
`Polygon::preset` holds the program, its authored adjust values, the box it is drawn for (in
the element's own coordinates), the part an element draws (the filled paths, all of them, or
the stroke-only detail), the key the elements of one shape share and, on a connector, its glue
(the glued element's `Self` id and the site). `TextFrame::preset_text` names the key of the
shape a text frame belongs to. After a write that moves or resizes an element the engine refits
a live preset with its companions and routes every connector glued to it, in the same apply
and undo step; it reads and drags the adjust handles (`frameShapePreset`,
`frameShapePresetAdjust`, `frameShapePresetHandle`), and the host's live-shape overlay draws
them in every module. Office's line ends are the engine's too (engine ADR 1093, amendment 2):
`start_office_head` / `end_office_head` beside the nearest InDesign arrowhead.

What slide keeps:

- **Lowering.** `slide-native` sets the engine's fields as it lowers a shape: on each path of a
  preset shape its preset (the box `(0, 0)`–`(w, h)`; the flips stay in the item's transform,
  as before), on the shape's text frame its key, on a connector the glue mapped from the
  `cNvPr` ids of `a:stCxn` / `a:endCxn` onto the element the glued shape became (its outline,
  else its picture frame, else its text frame). A path whose anchors the engine's live
  arithmetic does not fit back onto its preset (the leader of the three-segment callouts)
  stays a plain path. `a:headEnd` / `a:tailEnd` become Office heads with their `w` and `len`
  (`dml_geom::heads::office_end`; `slide-resolve` keeps the shape's own line ends for it). The
  anchors, transforms and bounds a deck lowers to are unchanged: every fixture lowers to the
  same geometry as before.
- **The label** keeps what export needs that the engine does not hold (the shape key, the
  placeholder, the click action, a chart's frame and box, SmartArt); `preset`, `box`,
  `connector` and `part` are gone from it.
- **Export** writes a path whose anchors are still its preset (`paged_preset_geom::model`)
  as `a:prstGeom` with its adjust values, placed by its box; a reshaped one as `a:custGeom`,
  as before. A connector's `a:stCxn` / `a:endCxn` keep their bytes while the glue names the
  same shapes, name the new shape when it changed, and are dropped when the glued element is no
  longer on the page. Office heads are written back with their sizes.
- **Insert ▸ Shapes** (`live::new_shape`, the gallery, the Shapes panel) draws the new shape's
  elements as engine live presets sharing a key `new:…`.
- **The earlier labels are lifted once.** A document saved with them is lifted onto the
  engine's fields by `slide_native::migrate`: a path still drawing its preset for the
  labelled box takes the preset (its part found by which of the program's paths its anchors
  are), the glue's `cNvPr` ids map onto elements as at import, the shape's text frame takes
  its key, and the old keys leave the label. Export reads every document through the lift.
  When such a document opens in the editor, the bundle (`preset-migration.ts`) asks the slide
  engine for the lift of the document's `.paged` bytes and writes it in one batch: the
  engine's preset on each path (`frameShapePreset`), the shape key on its text frame
  (`frameShapePresetText`), so the text frame follows a resize at once, and the new labels.
  The host has no write outside the undo history, so the batch is one named undo step of its
  own ("Update shapes"); undoing it brings the old labels back, and export still lifts them.

Deleted: the bundle's follower (`live-presets.ts`) and adjust handles (`adjust-handles.ts`)
with their tests, `slide-native`'s `follow`, `handles` and `adjust`, the `follow`,
`handles` and `adjust` operations of the slide wasm, and `slide-resolve`'s record of where each
glued site was at import. The tests of a resized preset, a re-routed connector and an adjust
drag now drive the engine's mutations (`pptx-export` `tests/live.rs`, against the same
`connectors` fixture and PowerPoint's slide 2); the engine's own are in `paged-canvas`
`tests/it/presets.rs`.
