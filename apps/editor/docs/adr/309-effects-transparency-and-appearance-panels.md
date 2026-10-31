# ADR 309 — The Effects, Transparency and Appearance panels, and the Effect menu

- **Status:** Accepted 2026-10-29.
- **Scope:** `apps/canvas/src/panels/` (`effect-stack.ts`, `effect-stack-section.tsx`,
  `effects-panel.tsx`, `transparency-panel.tsx`, `appearance-panel.tsx`, `built-in-panels.tsx`),
  `apps/canvas/src/effect-menu.ts`, `cockpit-menus.ts`, `solo/profiles.ts`, the shell's panel
  glyphs; in the engine (additive, protocol 78 unchanged) `paged-introspect` (`effect_kinds.rs`,
  the catalog's `effectKinds` and `effectCategories`; the frame rows `opacityMaskType`,
  `opacityMaskInvert`, `opacityMaskClip`), `paged-model` (`OpacityMask::clip`), `paged-mutate` /
  `paged-wire` (`ApplyOpacityMask.clip`), `paged-renderer` (the unclipped mask's backdrop),
  `paged-canvas` (the option writes and reads; a snapshot of a mask item alone); in the contract
  `CORE_EFFECT_KINDS` / `CORE_EFFECT_CATEGORIES` and the `EffectKindDescriptor` type
  (plugin-sdk / plugin-api 0.74.3-canary.44). Amends engine ADR 124 (opacity masks) and engine
  ADR 1008 (the effect stack). Plan WP4.3, WP10.7 (the panels' part) and C16 (the effects panel
  lists from the schema); gaps D-14, D-27, D-34 and I-12 (their UI).

## Context

The engine keeps an ordered effect stack per transparency target (engine ADR 1008) and the
Effects panel edits it, but the panel listed the kinds, which targets take them and each kind's
parameters in a TypeScript table. Every kind the engine adds — the live vector effects of WP3.2
are next — would need that table changed, and the plugin SDK had no description of the kinds at
all. Illustrator's Transparency panel (blend, opacity, the opacity mask with Clip, Invert Mask
and Edit Mask) and Appearance panel (what draws an item, in order) had no counterpart: an
opacity mask could be made and released through draw's commands, but its mode and inversion
could only be set when it was made, its artwork could not be edited while it masked, and the
engine had no Clip switch. These panels are host panels: a slide shape, a sheet's chart frame or
a frame inside a Word document is a page item like any other, so they must be offered inside
every module's edit context.

## Decision

**The kinds are core's.** `paged-introspect` describes every `EffectKind` in `effect_kinds.rs`:
its menu group (one of `effectCategories`: Stylize, Blur, Noise, Color, Distort & Transform,
Path, Pathfinder, Warp, Convert to Shape, Rasterize), whether it is one of InDesign's nine, the
targets that take it, how often a stack may hold it, whether the entry carries its own blend and
opacity, and its parameters as `EffectEntrySpec` fields with the contract's `ValueType`, range
and default; InDesign's kinds name their switch and per-field paths instead. The match over
`EffectKind` is exhaustive, so a kind the engine adds does not compile until it is described,
and tests hold every parameter to a field of the wire's entry. The catalog carries the table as
`effectKinds`; the SDK serves it as `CORE_EFFECT_KINDS`. The editor's Add menu, its parameter
forms (a number with its unit and range, an enum, a switch, a colour or swatch), the Effects
panel's InDesign disclosures and the Effect menu are built from it; the editor holds only words:
a kind or parameter its catalogue does not translate shows core's English name.

**The Effect menu** is Object ▸ Effects ▸ ‹group› ▸ ‹effect›, beside Effects…, Transparency…,
Appearance… and Global light… — inside the Object menu, which every profile's menu bar keeps,
rather than a new top-level menu the solo profiles would drop. A row appends the effect at its
defaults to the object stack of every selected item that takes it, all in one batch (one undo
step), and raises the Appearance panel. Its only condition is a selection: it applies in every
edit context.

**The Transparency panel** writes the object's blend (the schema row's members, so the 27 modes
of WP3.4 appear when the engine lists them) and opacity, and shows the opacity mask: Make takes
the selection's top item (by the scene tree's paint order) as the mask of the one below
(`applyOpacityMask`), Release is `releaseOpacityMask`. The mask's options are three new frame
rows, each one write and one undo step: `opacityMaskType` (`luminosity` | `alpha`),
`opacityMaskInvert` and `opacityMaskClip`. The wire has no op that edits a mask in place, so a
write is the release and the re-apply with the new option as one batch; the artwork comes back
out of the z-order exactly as it went in, and the undo restores the state hash. On an item
without a mask they read as a new mask would take them and a write is refused. The thumbnail is
a snapshot whose `only` names the mask item: a mask item named without its target is drawn as an
object of its own in the snapshot's throwaway copy. Edit Mask selects the mask artwork while it
masks — it is no page item of its own, but every per-item path still reaches it — so the Color,
Swatches, Gradient and Stroke panels edit it and the canvas shows the masked result; Stop
selects the target again.

**Clip.** Illustrator's Clip switch is new in the model: `OpacityMask::clip`, on by default and
not serialised when on, so documents and digests are unchanged. Off, what the artwork does not
paint shows the target: the renderer emits one opaque white fill under the artwork inside the
mask bracket, a page's size past the page on every side — the artwork resolved over a white
backdrop, PDF's `/BC [1 1 1]`. Every rasterizer and the PDF writer read it as ordinary mask
artwork, so the lanes agree without new display-list vocabulary. Invert applies after it, as in
Illustrator. `applyOpacityMask` takes an optional `clip` (absent: on); the release's inverse
keeps it.

**The Appearance panel** lists what draws the item, front to back as Illustrator does: the
stroke (colour, weight), the fill (colour), the object's effect stack and its opacity. A paint
row opens to its own target's stack (the stroke's and the fill's: InDesign's effects only). The
rows are sections in one list (`APPEARANCE_SECTIONS`); the engine's multiple fills and strokes
(engine ADR 1009, WP3.3) join it as their own rows, reading the rows the engine adds for them,
without changing the rows that are here.

**Every context.** No edit context claims the three panels, so the applicability rule offers
them in all of them (`panelBelongsHere`); every module's solo profile lists them. A unit test
holds the rule against each module's context and claimed panels, and an editor e2e per module
context (doc, slide, sheet, draw, and a publish document) enters it, opens the panels and
applies an effect through the Effect menu.

## Consequences

- WP3.2's vector effects, and any kind after them, appear in the Add menu, the Effect menu
  (Distort & Transform, Path, …) and the forms by describing them in `effect_kinds.rs`; the
  catalog and SDK sync carry them.
- An extension can list and describe the kinds from the SDK without a copy of the table.
- A mask's options are editable after it is made, from the panel, `paged.set` and
  `host.objects`, each an undo step; Clip is a native construct that PDF export draws exactly
  (it is ordinary artwork) and that IDML export loses with the mask (engine ADR 124).
- Not in this decision: per-target stacks other than fill and stroke in the Appearance panel,
  an Edit Mask mode that dims everything but the mask, a mask on a text frame or a group (the
  engine refuses both, ADR 124), and Make Opacity Mask from a selection whose top item the scene
  tree does not list.
