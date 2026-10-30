# ADR 618 — Pictures' DrawingML looks through the shared reader and mapper

- **Status:** Accepted 2026-10-28. Amends [ADR 606](606-skeleton-is-a-native-document.md)
  (which crates reach the engine).
- **Scope:** `docx-core` (`Image::look`, `PictureLook`, `Theme::drawingml_slots`, the theme
  tint and shade on the shared HSL), `docx-import` (`picture_looks`), `docx-lower`
  (`Lowering::lower_look`, `LoweredImage::fx` / `losses`, the diagnostics),
  `packages/doc-host-model/src/lowered.ts` (`NativeFx`), `platform/shared/ooxml`
  (`tree::subtrees`, `drawingml::ShapeProperties`), `platform/shared/dml-native`
  (`native`), `docx-conformance` (`picture_effects_docx`, `tests/it/picture_effects.rs`),
  `scripts/word-picture-effects-probe.sh`. Plan WP10.3 and Phase 11 C10/C11.

## Context

A Word picture is more than its image. `pic:spPr` can fill behind it, outline it and give it
an effect list (Word's picture styles are exactly that: a white frame and a drop shadow, a
soft edge, a reflection, a glow), and its `a:blip` can make it translucent
(`a:alphaModFix`) or recolour it. paged.doc read only the blip's relationship and the
extent, so all of this was dropped without a word.

slide ADR 722 made one DrawingML reader (`paged_ooxml::drawingml`, over the element tree)
and one mapper onto the engine (`dml-native`). doc reads WordprocessingML through ooxmlsdk's
typed DOM, not the element tree, and places its pictures from TypeScript
(`insertAnchoredFrame`), not by building the model; ADR 722 left doc's adoption open for
that reason.

## Decision

1. **Read once, with the shared reader.** `docx-import` reads each part's `wp:inline` and
   `wp:anchor` subtrees with `paged_ooxml::tree::subtrees` (the part's other elements are
   skipped, not built) and the picture's `pic:spPr` and `pic:blipFill` with
   `drawingml::shape_properties` and `drawingml::blip`. A typed drawing finds its look by
   `wp:docPr/@id`, each id's looks in document order. The look is kept AS AUTHORED on
   `docx_core::Image::look` (`PictureLook`: theme colours still slot names), serialised
   through paged-ooxml's `serde` feature; a plain picture keeps none.
2. **Resolve and lower once, with the shared mapper.** `docx-lower` resolves the look
   against the document theme (`Theme::drawingml_slots`: the scheme by element name, and
   `tx1` / `bg1` / `tx2` / `bg2` through `w:clrSchemeMapping`) and lowers it through
   `dml_native::native::Lowering::picture`: a solid or gradient fill (the linear axis
   started where Office starts it, `axis_start`), the outline (weight, dashes, cap, join,
   miter), `a:alphaModFix` times a translucent fill as the opacity, alpha stops as a
   gradient feather, the outer shadow as the drop shadow, the inner shadow, glow and soft
   edge. The result rides the IR as `LoweredImage::fx` (`NativeFx`, colours `#RRGGBB`) and
   what the engine cannot hold as `LoweredImage::losses`.
3. **`NativeFx` is the mapper's, not doc's.** The wire form of the mapper's result lives in
   `dml-native` (`native.rs`) so paged.sheet's chart and picture lowering (sheet ADR 527,
   which has the same shape locally) can take it instead of its own.
4. **Honest about the page.** Pictures are placed as anchored frames
   (`insertAnchoredFrame`), and the engine's anchored frame holds no fill, outline,
   opacity or effects: `AnchoredFrame` has no field for them, `setElementProperty` finds
   only spread-level frames, and the renderer draws an anchored frame's effects as none.
   The host model therefore applies nothing yet. One warning names how many pictures carry
   a look and what it is ("4 picture(s) carry a DrawingML look (drop shadow, glow, …) that
   is NOT shown"); one info line per kind of loss names what the mapper cannot hold
   (reflection, blur, the picture adjustments `a:grayscl`, `a:lum`, …). Pictures in table
   cells are not poured at all and are reported as before.
5. **The source keeps every byte.** The look is read, never written: save-back splices
   runs and paragraphs, so a drawing stays byte-identical in an unedited save and in a save
   that edits text around it (`pictures_with_a_look_save_back_byte_identical`).
6. **The engine boundary (amends ADR 606).** `docx-lower` depends on `dml-native`, which
   depends on the engine's `paged-model` for its value types (`DropShadowSetting`,
   `FrameEffects`, `GradientEntry`). `docx-skeleton` is still the one crate that builds an
   engine document; `docx-lower` reaches no scene, store or canvas crate.
7. **Word's colour arithmetic is the shared one (C11).** `docx_core::theme::tinted` (Word's
   `w:themeTint` / `w:themeShade`) runs on `paged_ooxml::colour::{rgb_to_hsl, hsl_to_rgb}`;
   doc's own copies are gone.

## Consequences

- When the engine's anchored frames carry the frame properties (an engine change: the
  `AnchoredFrame` fields, `setElementProperty` reaching story-anchored frames, the anchored
  render path, IDML in and out), doc-host-model translates `fx` into
  `setElementProperty` ops on the frame `insertAnchoredFrame` mints (bound with
  `bindCreated`), and the warning goes. The translation is the one paged.sheet's
  `nativeFxOps` already is; it belongs in the shared lowering kit (C2) then.
- `docx-export` has nothing to lower back while nothing native carries the look. Once
  it does, a changed shadow, glow, soft edge or outline is written through the mapper's
  inverse (`effects_of`, `dash_of`) and `drawingml::write`, as pptx-export does.
- Shapes (`wps:wsp`), text boxes and charts are still counted, not carried (ADR 035
  decision 8): their look would go through the same `Lowering::shape`, but placing a shape
  is the open floating-drawing work, not this record's.

## Evidence

- `docx-conformance/tests/it/picture_effects.rs` (`__feat__plugin_doc_native_effects`):
  the look as authored, the outline and drop shadow, alpha, glow and soft edge against the
  theme, the gradient behind with its start and the alpha-stop feather, the losses and
  diagnostics, the IR JSON, byte-identical save-back.
- `platform/shared/dml-native/tests/native.rs`, `platform/shared/ooxml/src/tree.rs`
  (`subtrees_picks_deep_elements_in_document_order`).
- `scripts/word-picture-effects-probe.sh`: the Word case of this record (ADR 604). It has
  Word open the fixture and the edited save (a repair prompt leaves no PDF) and save the
  fixture again as `.docx`, and prints the `a:blip` and `pic:spPr` Word writes per picture
  as `docx-conformance/fixtures/picture-effects.word.json`. Not recorded yet: the first run
  (2026-10-28) got no answer from Word, which opened no document at all, not even a fixture
  it had opened before. The answer file and a test that reads Word's own look back to the
  same native effects follow once it is recorded.

## Amendment 2026-10-30 — the effect stack in the look (plan C10)

`NativeFx` gains `effectStack` (engine ADR 1008): a picture's `a:blur`, solid `a:fillOverlay`
and `a:reflection` are carried in the look instead of reported (slide ADR 722 amendment
2026-10-30); `lowered.ts` types it. The look as a whole is still carried for the anchored
frames (the diagnostic names "reflection" among what it holds); whatever writes the look onto
the frame writes the stack last, as `frameEffectStack`. Evidence:
`docx-conformance/tests/it/picture_effects.rs`, `platform/shared/dml-native/tests/native.rs`.
