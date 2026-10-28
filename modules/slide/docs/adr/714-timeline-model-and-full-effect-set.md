# ADR 714 — Timeline model and full effect set

- **Status:** Accepted 2026-10-28.
- **Scope:** `pptx-core/src/anim.rs` (the IR and its writer), `pptx-import/src/anim.rs` (the
  reader), `slide-native` (the timing in the page label), `pptx-export/src/timing.rs`,
  `slide-anim` (schedule, evaluator, formulas, motion paths, the preset table, authoring),
  `slide-js/src/anim.rs` (the `anim` door, `AnimPlayer`), and in the bundle `src/anim/`
  (model, shapes, authoring, the Animations pane, preview, commands) and `src/show/`
  (`scene.ts`, `scene-source.ts`, `animation.ts`, `scene-2d.ts`, `effects/`). Wave 5 of the
  parity program (ADR 711), on extensions ADR 346 and its C4 amendment (paragraph layers).
  Plays inside the show of ADR 716; the layer shader follows ADR 721's conventions.

## Context

Until now import kept `p:timing` as an opaque string and export copied it: a deck's
animations survived a round trip but did not play, could not be edited and were lost with a
regenerated slide part. PowerPoint's animation model is SMIL's: a tree of time nodes (`par`,
`seq`, `excl`) whose leaves are behaviours (`set`, `anim`, `animEffect`, `animMotion`,
`animScale`, `animRot`, `animClr`, `cmd`) on shapes, paragraphs or the slide, started by
clicks, by other nodes or by clicks on a shape (triggers). Every effect PowerPoint offers is a
preset (`presetClass` / `presetID` / `presetSubtype`) written out as such behaviours, so a
player that runs the behaviours faithfully plays every preset a deck contains, and authoring
needs the presets as behaviour templates.

## Decision

1. **The IR is the tree as written** (`pptx_core::anim::Timing`). Containers keep their common
   time node (`p:cTn`: id, preset, duration, repeat, speed, acceleration, auto-reverse, restart,
   fill, node type, start and end conditions, iteration); behaviours keep their `p:cBhvr`
   (additive, target, attribute names) and their own values (key points with formulas, filters,
   paths, scale, rotation, colours, commands); targets keep the shape, its background, a
   paragraph or character range. An element the model does not know (`p:audio`, `p:video`,
   `mc:AlternateContent`, extension lists) is kept as XML; an attribute it does not know stays
   in the element's `extra` list. `Timing::to_xml` writes it back; every timing PowerPoint wrote
   in the fixtures and the corpus reads back as the same tree and writes back byte for byte.
2. **A slide's timing lives in its page label** (`data.timing`, ADR 703), so it moves,
   duplicates and undoes with the slide. Each shape target also carries the document's names
   for the shape: the page item it became (`item`) and its shape key (`key`, ADR 711). A target
   resolves to the item while it is on the page, else to the shape with the key (a duplicated
   slide, whose items have new ids).
3. **Export** (`pptx-export/src/timing.rs`): a timing equal to the deck's (names stripped)
   keeps the slide's bytes; another one is resolved to the cNvPr ids the slide is written with
   (a shape made in the editor gets the id export gave it), and spliced in place of `p:timing`
   (or inserted in schema order). An effect whose shape is gone is dropped with its build and
   reported; a timing with no nodes removes `p:timing`.
4. **The evaluator is Rust and pure** (`slide-anim`): `AnimPlayer` compiles a timing with the
   slide size and each layer's box, and `evaluate(events, t)` answers each layer's state
   (visibility, opacity, move, scale, turn, skew, a filter mask with its progress and direction,
   colour and text-style changes) from the clicks and shape clicks so far. It schedules the tree
   as SMIL does (par / seq / excl, delays, `onBegin` / `onEnd` / `onClick` / `onNext`, durations,
   repeat, auto-reverse, acceleration, fill), seeks a running click group to its end on the next
   click (`nextAc="seek"`), evaluates PowerPoint's formulas (`#ppt_x`, `$`, the functions) and key
   points, runs motion paths at constant speed by arc length, and takes a target whose first
   visibility change is "visible" as hidden at the start. Deterministic: the same input gives
   the same output (`rand()` is seeded by the node).
5. **The preset table comes from the oracle** (ADR 705). `slide-conformance/fixtures/animations`
   is a deck PowerPoint wrote through its own scripting dictionary
   (`scripts/fixtures/animations.applescript`): every effect it offers, every direction it takes
   for each, and the exit twin of each entrance effect. `slide-anim/data/presets.json` is
   generated from it (a test regenerates it and fails while it differs), and authoring an effect
   from the table writes what PowerPoint wrote for it.
6. **Playback is layers** (on ADR 716's show): the slide's background without its animated
   items (one `render.layers` call); each animated item a layer of its own; a text frame built
   by paragraph cut into paragraph layers (extensions ADR 346, C4); and the static items that
   lie above an animated one drawn as runs between the layers, so the stacking order holds.
   Each layer's state is its shape's whole state composed with its part's (the shape's
   background, a paragraph). The layers are composited each frame on WebGPU by one WGSL shader
   (`src/show/effects/layer.wgsl`: the affine map, opacity, a recolour, and up to two of
   PowerPoint's filters — fade, wipe, barn, blinds, box, checkerboard, circle, diamond, dissolve,
   plus, randombar, slide, strips, wedge, wheel(n) — laid out in their own box), on the device
   the transitions run on; without WebGPU, Canvas2D draws the same layers with the filters as
   clip paths. A transition into an animated slide runs to the slide's first state. Clicks play
   the slide's builds before it advances; going back undoes one; a click on a trigger shape
   plays its sequence; the next slide's layers are prefetched with its frame.
7. **Authoring goes through the engine.** The Animations pane (right dock) lists the slide's
   effects in play order with a bar on a timeline (drag to retime, drag a row to reorder), adds
   any preset by class to the selected shape (by paragraph on request), and edits direction,
   start, duration, delay, repeat, rewind and trigger. Each change is one `edit` of the timing
   through `slide-anim` (which rebuilds PowerPoint's canonical structure: click groups, with and
   after previous sub-groups with computed delays, interactive sequences for triggers, a
   consistent build list) and one page-label write, so one undo step. Preview plays the active
   slide's animations over it in the editor; the Animation Painter gives the next shape selected
   the selected shape's effects. Typed twins (ADR 323): `addAnimation`, `removeAnimation`,
   `setAnimationTiming`, `moveAnimation`, `listAnimations`, `previewAnimations`.

## Consequences

- Approximations (recorded in the player, not hidden): a colour change recolours the layer
  (flat: exact for solid fills and single-colour text, not for gradients and pictures); text
  style changes (bold, italic, underline) are not drawn and a font-size change scales the
  layer; animation by word or letter plays as by paragraph; a character range plays as its
  paragraph; a group's members cannot be animated separately (PowerPoint cannot either);
  chart and diagram builds (`bldGraphic`, `bldDgm`) play the frame whole; media commands are
  hooks with nothing to play until media items land (wave 4's media door).
- Paragraph layers are cut along line boxes: a glyph past its line into the next paragraph's
  band is cut at the band (ADR 346 amendment).
- The MP4 export (ADR 720) plays the same player frame by frame through the offline renderer's
  `slide(frame, layers)` (Canvas2D): each click step when the one before has finished, within
  the slide's time; builds that run past it are cut.
