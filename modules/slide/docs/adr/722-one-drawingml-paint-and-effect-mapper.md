# ADR 722 — One DrawingML paint and effect reader, one mapper onto the engine

- **Status:** Accepted 2026-10-25.
- **Scope:** `platform/shared/ooxml` (`drawingml`, `units`), `platform/shared/dml-native` (new),
  `pptx-core`, `pptx-import/src/paint.rs`, `slide-resolve` (colour, paint, line, effects),
  `slide-native`, `pptx-export`; the units in `sheet-xlsx`, `docx-lower` and `docx-import`, and
  SpreadsheetML's `tint` in `sheet-format` and `sheet-chart`. This record carries plan Phase 11
  C10/C11 and WP10.1/10.2.

## Context

A `.pptx`, a `.docx` and a `.xlsx` paint shapes, pictures and charts with the same DrawingML
(`a:solidFill`, `a:gradFill`, `a:pattFill`, `a:blipFill`, `a:ln`, `a:effectLst`). paged.slide
read it into its own types and mapped the result onto the engine inside `slide-native`;
paged.doc dropped gradients and effects; paged.sheet kept its own gradient model and three
copies of Excel's `tint`. The EMU constant was declared four times.

slide carried only the outer shadow of an effect list. The inner shadow, glow and soft edge were
read and then dropped, and pattern fills were drawn as their foreground colour.

## Decision

- **One reader, in the shared OOXML crate.** `paged_ooxml::drawingml` reads the colour elements
  with their transform chains, every fill (including the picture effects of an `a:blip`, and the
  Office 2010 image effects), lines and effect lists over the element tree. Values keep the
  file's units. `drawingml::color::resolve` is the one transform chain (moved out of
  slide-resolve). It resolves against the caller's `SchemeColors`: the deck's colour map and
  theme, or a document's theme.
- **A neutral resolved IR.** `drawingml::resolved` turns what was read into what it draws.
  Lengths are in points, angles in degrees, percentages fractions and colours sRGB bytes with
  alpha. The IR has no engine types. It still describes what the engine cannot hold yet (a
  pattern, a reflection, a blur). `drawingml::write` writes it back as DrawingML.
- **`ooxml::units`** is the one table of EMU, twips, half-points, angles and percentages.
- **One mapper onto the engine, in `platform/shared/dml-native`.** It depends on `paged-model`
  (PM-0014) and lowers the IR as follows:
  - colour and gradient swatches;
  - gradient placement, using PowerPoint's projected span and farthest-corner reach;
  - alpha stops as a gradient feather (the engine's gradient swatches carry no alpha);
  - strokes, including preset and custom dashes as per-item dash patterns and the miter limit;
  - the outer shadow as the drop shadow;
  - the inner shadow, glow and soft edge as `FrameEffects`;
  - a preset shadow as a plain drop shadow;
  - a picture's `a:alphaModFix` as opacity.

  The engine cannot hold blur, reflection, fill overlay, shadow scale and skew, triple lines,
  patterns (drawn as the mix of their two colours) or picture adjustments yet. Each is reported
  once per kind in the module's diagnostics, never dropped silently. The Office 2010
  corrections and artistic effects are not losses: Office stores their result as the blip.
- **slide uses both.** `pptx-core` re-exports the shared types, and `slide-resolve`'s model
  re-exports the resolved IR. Each item now carries all of its effects. An effect style's
  `phClr` is the `a:effectRef` colour. `slide-native` lowers through the mapper and keeps no
  mapping of its own. `pptx-export` writes a changed drop shadow, effects or dash pattern back
  through the mapper's inverse (`effects_of`, `dash_of`) and `drawingml::write`.
- **sheet and doc share the arithmetic and units.** `sheet-format` and `sheet-chart` call
  `paged_ooxml::colour::excel_tint`; sheet-xlsx, pptx and docx read EMU from `ooxml::units`.

## Consequences

- When the engine gains pattern paint, opacity stops or an effect stack (core ADRs 1007 and
  1008), the change goes into `dml-native` and every module gets it.
- doc's pictures are read through ooxmlsdk's typed DOM, not the element tree, and are placed
  by the TypeScript host model. Mapping their paint means a typed-DOM adapter into the neutral
  IR plus host mutations for the frame effects. That is WP10.3, still open.
- The deck IR's JSON names the new fields (`effects`, `image_effects`). Both read with serde
  defaults, so an older IR still loads.

## Evidence

- `platform/shared/ooxml/src/drawingml/*` (unit tests per element, the write/read round trip)
- `platform/shared/dml-native/tests/map.rs`
- `modules/slide/pptx-export/tests/regenerate.rs`
  (`shadows_glow_soft_edge_and_dashes_set_in_the_editor_read_back__feat__plugin_slide_native_effects`)

## Amendment 2026-10-28 — a linear gradient states its start

`placement` gave a linear gradient its angle and length but no start, and the engine starts
an unplaced linear gradient at the box's bottom-left corner. That is where PowerPoint starts
it only for an axis running up or right (0° to 90° in the engine's counter-clockwise
angles). A vertical (`a:lin ang="5400000"`, top to bottom) or down-diagonal gradient began
below the box, so most of the shape showed its first stop. `slide-native` now states the
start for every fill gradient through `dml_native::axis_start` (added for sheet ADR 527): the
start of the axis Office runs through the box's centre, in the item's local box `(0, 0)` to
`(w, h)`, which is the outline's coordinate space (`transform` places it), so a rotated or
flipped shape keeps its gradient. A radial gradient keeps the centre it already stated. The
item tables' background frames take the same placement.

doc's pictures read and lower their looks through the same reader and mapper (doc ADR 618),
through the mapper's new wire form `dml_native::native`.

Evidence: `modules/slide/slide-native/tests/effects.rs`
(`a_vertical_or_down_diagonal_gradient_starts_where_powerpoint_starts_it__feat__plugin_slide_native_effects`),
`platform/shared/dml-native/tests/map.rs`
(`a_linear_axis_starts_where_office_centres_it__feat__sheet_chart_native_effects`).

## Amendment 2026-10-30 — the effect stack, picture filters and the fill rule (plan C10)

What the mapper reported because the engine could not hold it now lands natively, through
`dml-native` for slide, doc and sheet alike:

- **Effect list → the effect stack** (engine ADR 1008). `a:fillOverlay` with a solid paint is a
  colour overlay under its blend (`mult`, `screen`, `darken`, `lighten`; `over` is Normal), its
  alpha the entry's opacity; `a:blur` a Gaussian blur; `a:reflection` a reflection (gap, `endPos`
  as its size, start and end alpha, blur). A DrawingML blur radius is three σ
  (`BLUR_SIGMA_PER_RADIUS`): PowerPoint's PDF of a 10 pt blur ramps 16 %→84 % over 6.6 pt. The
  stack lists InDesign's effects first, in InDesign's order (the frame body draws them as
  before), then overlay, blur, reflection; an item with InDesign's effects alone keeps the
  canonical empty stack. `a:effectDag` is read as a list of its direct effects
  (`paged_ooxml::drawingml::effect::container`); its containers are reported.
- **Still reported:** a gradient fill overlay (PowerPoint draws none — the `effect-stack`
  fixture's PDF shows the shape unchanged), a picture or pattern overlay, `grow="0"`, a
  reflection that is not a mirror image below, a shadow's distortion, patterns (pattern paint is
  not on main), alpha gradient stops beyond the gradient feather (paint v2 is not on main).
- **Picture effects** (engine ADR 1037): `a:clrRepl` is a duotone of one colour; a picture's
  `a:blur` a blur in the picture's pixels (`Mapper::picture_at`, given its pixels per point as
  placed). `a:clrChange` and `a:tint` have no equivalent op and stay reported.
- **Fill rule** (engine ADR 1006): PowerPoint fills each `a:path` even-odd — two nested squares
  turning the same way show a hole. `Mapper::fill_rule` sets even-odd where the rules differ for
  a one-path outline and leaves every other outline non-zero (its serialisation unchanged); an
  outline of several paths one of which needs even-odd is reported. `dml-geom`'s `SubPath`
  names its `a:path`.
- **Export:** `dml_native::effects_with_stack` writes the stack's overlay, blur and reflection
  back as `a:effectLst`.

Evidence: `modules/slide/slide-native/tests/effect_stack.rs` on the PowerPoint-written
`effect-stack` fixture, `platform/shared/dml-native/tests/map.rs`
(`blur_reflection_and_overlay_ride_the_effect_stack`, `the_effect_stack_comes_back_as_drawingml`,
`powerpoint_fills_a_path_even_odd`, `colour_replacement_and_picture_blur_join_the_filter_stack`),
`platform/shared/dml-native/tests/native.rs`.
