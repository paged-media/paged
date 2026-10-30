# ADR 723 — Effects parity and pictures: bevels, pattern tiles, every picture format

- **Status:** Accepted 2026-10-30.
- **Scope:** `platform/shared/ooxml` (`drawingml::effect::three_d`, `shape_effects`,
  `drawingml::pattern`, `resolved::ThreeD`, `write::three_d`), `platform/shared/dml-native`
  (the bevel, `three_d_of`, `pattern`, `Mapper::pattern_tile`), `pptx-import`, `slide-resolve`,
  `slide-native`, `pptx-export`, `pptx-core::transcode`; the bundle's Format Painter
  (`format-painter.ts`, `content-commands.ts`). Carries plan Part B W4 "effects parity" and
  "every picture format". Amends ADR 717's pictures amendment and builds on ADR 722.

## Context

ADR 722 put every DrawingML effect the engine holds through one mapper: the outer and inner
shadow, glow, soft edge, blur, fill overlay and reflection already reach the engine's effect
stack (engine ADR 1008). Three things did not:

- **3-D.** `a:scene3d` and `a:sp3d` were not read at all, so a bevelled shape (PowerPoint's
  Shape Effects ▸ Bevel, and the third effect style of the Office 2007–2010 themes) was drawn
  flat, without a word in the report.
- **Pattern fills.** The engine on main has no pattern paint. Engine ADR 1041 (pattern
  swatches) exists only on an unmerged branch, so a pattern was drawn as the mix of its two
  colours.
- **Pictures.** Export wrote WebP, TGA, ICO, QOI, PSD and the other formats PowerPoint does not
  open as a PNG the host renders of the frame. The headless canvas renders nothing for a WebP,
  TGA or ICO frame (an engine decode gap; the editor's canvas draws them through the same
  path), so those three exports failed.

## Decision

- **3-D is read beside the effect list.** `drawingml::effect::three_d` reads `a:scene3d`
  (camera preset and whether it is turned, light rig and direction) and `a:sp3d` (top and bottom
  bevels with their width, height and preset, extrusion, contour, material).
  `drawingml::shape_effects` returns the effect list and the 3-D look of a shape's properties.
  `Effects::three_d_only` records that the properties held a 3-D look but no list, so the list
  is still inherited. In `slide-resolve` each part falls back to the theme's effect style on
  its own, as PowerPoint does: the list from the `a:effectRef` style unless the shape has its
  own, and the 3-D look likewise. `resolved::ThreeD` is the look in points; a flat look (no
  bevel, extrusion or contour) resolves to none.
- **A top bevel seen from the front is the engine's bevel.** `dml-native` lowers `a:bevelT` to
  `BevelEmbossParams` with the following settings:
  - Inner bevel, direction Up.
  - Size: the bevel's width.
  - Depth: its height over its width.
  - Technique: smooth for the rounded presets, hard chisel for the straight-sided ones, soft
    chisel for the stepped ones.
  - Altitude 30°.
  - The light's angle is the rig's direction plus 45°. PowerPoint's rig, lit from the top,
    draws the highlight on the top and left edges.
  - Highlight 75 %, shadow 40 %. The lighting was scored by SSIM on the `bevels` fixture
    against 120°/135° and 25–50 %.

  The following are reported:
  - a turned or perspective camera (the shape is drawn seen from the front);
  - a bottom bevel or extrusion seen at an angle;
  - a contour.

  Seen from the front, PowerPoint draws neither a bottom bevel nor an extrusion, so neither is
  a loss. On export, a bevel the editor did not change keeps the shape's own `a:scene3d` and
  `a:sp3d`, including its preset. A changed bevel is written as a flat `a:scene3d` (added only
  where the shape has none) and an `a:sp3d` from `three_d_of`. A removed one drops `a:sp3d`.
- **Shadow perspective stays reported.** The engine's drop shadow has no scale or skew, so a
  PowerPoint perspective shadow (`sx`, `sy`, `kx`, `ky`) is drawn undistorted and reported. An
  unchanged shadow keeps its XML, so export loses nothing.
- **A pattern is a picture of its tiles until pattern paint lands.** The cells are not
  invented. The `patterns` fixture holds all 54 preset patterns, and
  `scripts/ppt-pattern-probe.py` reads each one's 8 × 8 cell out of PowerPoint's own PDF
  (PowerPoint writes a tiling pattern whose 64 × 64 image is scaled to 8 pt).
  `paged_ooxml::drawingml::pattern::CELLS` holds them. The same PDF shows the geometry:
  - one point per cell bit, on an 8 pt grid anchored at the slide's top-left;
  - the pattern does not turn with the shape.

  `pattern_coverage` is now exact for every preset. PowerPoint's own `pct20` covers 8 of 64
  bits and `pct90` 62, not the nominal shares.

  `dml_native::pattern::tile` draws the cells over the shape's slide box, snapped to the grid,
  at 2 px per pt (capped at 2048 px). `slide-native` places the result as the polygon's image
  as follows:
  - an indexed PNG, background and foreground with their alphas;
  - mapped into the item's inner space through the inverse of its transform, so it stays
    upright;
  - clipped by the outline;
  - with the fill set to None.

  The deck keeps its `a:pattFill`. Export writes it back unchanged, because the fill fields did
  not change. The report says "drawn as a picture of its tiles (no pattern paint on main);
  written back as it was". doc and sheet keep the colour mix: they place no picture inside a
  shape. When engine pattern paint (ADR 1041) is on main, `CELLS` become its tiles in
  `dml-native` and the picture goes.
- **WebP, TGA, ICO and QOI are written as PNGs of their own pixels.** `pptx-core::transcode`
  decodes them: WebP through `image-webp` (the engine's own pure-Rust decoder), TGA (every
  type, plain and run-length), ICO (the largest, deepest entry; a PNG entry as it is, a bitmap
  entry with its AND mask) and QOI. It writes a PNG (`png_rgba`, `png_indexed`, the one PNG
  writer of the slide crates). Export no longer asks the host for these, and the crop stays a
  crop (`a:srcRect`). PSD, AVIF, JPEG XL, HDR, OpenEXR, DNG and EPS need the engine's raster
  decoders, so they still go as the PNG the host renders of the frame.
- **The Format Painter.** Slide ▸ Format Painter (`formatPainter`) arms the painter with the
  selection's formatting, the same copy as Copy formatting. The next shape selected (clicked)
  takes it in one undo step, and the painter is off. Invoked twice within 500 ms (PowerPoint's
  double-click on the brush), it stays on until Esc (`formatPainterOff`, scoped to the deck)
  or the command again. There is no host door for a "next click", so the painter listens to
  selection changes, as the Animation Painter does. A click that comes before the copy is read
  waits for it. Copy formatting takes an effect that is switched off as off, without its
  settings: the engine switches an effect on when any of its fields is written, so copying a
  plain shape's look used to give the target a bevel and a feather.

## Consequences

- When a pattern-filled shape is resized as a live preset, its tile picture keeps the old
  box. A fill set in the editor is written as that fill, but the picture stays on the canvas
  until the content is cleared. Engine pattern paint removes both limits.
- A bevel's preset survives only while the bevel is unchanged. An edited one comes back as
  `circle`, `angle` or `softRound`, by technique.
- The slide wasm grows by the WebP decoder and the transcoders.
- The headless canvas still renders nothing for a WebP, TGA or ICO frame. That is the engine's
  to fix: export no longer depends on it.
- Undoing a paste of formatting does not fully restore the target's effects. The engine's
  inverse of `setElementProperty` on an effect setting that had no value before leaves the
  effect on, with its defaults. The paste itself is right and is one undo step. The fix
  belongs in the engine's mutation inverses.
- Whole-slide SSIM moves little for bevels: the bands are a few points wide, and the engine
  shades them with InDesign's flat bevel rather than PowerPoint's lit 3-D surface. Patterns
  move from a flat grey to PowerPoint's cells. The figures are in status.md.

## Evidence

- Fixtures written by PowerPoint 16.114.3: `slide-conformance/fixtures/patterns.*` (54
  presets; colours, alpha, rotation, an ellipse, text, a theme colour) and `bevels.*` (12 top
  bevel presets, wider and deeper bevels, top and bottom, a perspective camera; perspective
  shadows, glow, soft edge, inner shadow).
- `platform/shared/dml-native/tests/map.rs`
  (`a_flat_top_bevel_is_the_engines_inner_bevel_and_comes_back`,
  `a_turned_camera_and_a_contour_are_reported`,
  `a_pattern_becomes_a_tile_picture_on_the_slides_grid`);
  `platform/shared/ooxml/src/drawingml/write.rs` (`a_bevel_and_its_scene_read_back`),
  `drawingml/pattern.rs`.
- `pptx-export/tests/regenerate.rs`
  (`a_pattern_is_drawn_as_its_tiles_and_written_back_as_it_was`,
  `a_bevel_reads_as_the_engines_bevel_and_an_edit_writes_its_3d_look`);
  `pptx-export/tests/pictures.rs`
  (`a_webp_tga_ico_or_qoi_is_written_as_a_png_of_its_own_pixels`); `pptx-core/src/transcode.rs`.
- The bundle: `test/headless/pictures.spec.ts` (every format on the real engine),
  `test/format-painter-mode.spec.ts`, `test/panels/icons-panel.dom.test.tsx`; the editor
  journey `slide-effects`.
- PowerPoint 16.114.3 opens, without a repair prompt, and saves as PDF the decks these tests
  write: the patterns deck with a moved shape, a bevel edited and removed, and a picture in each
  format (PNG, JPEG, GIF, BMP, TIFF, WebP, TGA, QOI, ICO, PSD, SVG).
- SSIM against PowerPoint's PDF (`scripts/fidelity-local.py --fixtures`, the engine's CPU
  renderer): see status.md, "Verified".
