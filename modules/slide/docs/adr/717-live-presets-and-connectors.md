# ADR 717 — Live presets and connectors

- **Status:** Accepted 2026-10-25. Part of the parity program ([ADR 711](711-powerpoint-parity-program.md)),
  wave W4. Amends [ADR 711](711-powerpoint-parity-program.md) (item labels) and
  [ADR 704](704-pptx-export-regenerates-slides.md) (a resized preset).
- **Scope:** `platform/shared/dml-geom` (was `slide-geom`), `pptx-core`, `pptx-import`,
  `slide-resolve`, `slide-native` (`live`), `pptx-export`, `slide-js` (`live`),
  `packages/slide-bundle` (`live-presets.ts`, `adjust-handles.tsx`, `shapes.ts`,
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
