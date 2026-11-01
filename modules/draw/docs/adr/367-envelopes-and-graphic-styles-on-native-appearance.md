# ADR 367 — Draw's appearance runs on the engine: the host panel, envelopes as stack entries, graphic styles on native appearance

- **Status:** Accepted 2026-10-31. Amends [ADR 354](354-multi-paint-bakes-to-a-group.md) and
  [ADR 355](355-libraries-in-container-parts.md); applies [ADR 361](361-visual-live-constructs-move-to-the-engine.md).
- **Scope:** `packages/draw-geometry/src/envelope.ts`; in `packages/draw-bundle/src`
  `commands/{envelope,appearance,appearance-native,appearance-migrate,appearance-bake,graphic-styles,graphic-styles-native,select-same}.ts`,
  `handlers/envelope-mesh.ts`, `panels/graphic-styles-panel.tsx`, `menu.ts`, `tools.ts`, the typed
  twins; the probe `scripts/illustrator/probes/envelope.jsx`. Engine (additive under protocol 78,
  no bump): the `envelope` effect kind (`paged-model::vector_effect::EnvelopeParams`,
  `paged-vector-fx::envelope`, `EffectEntrySpec.rows` / `columns` / `mesh`, its row in
  `effect_kinds.rs`), amending engine ADR 1042. Editor: the host Appearance panel lists every fill
  and stroke (editor ADR 312). Work package WP6.3 of the image/draw plan; gaps D-12, D-27, D-28,
  D-29, D-30, D-34 and D-35 (their UI).

## Context

The engine draws an item's several fills and strokes (engine ADR 1043) and its live vector
effects, Warp among them (engine ADR 1042), on both rasterizers, in PDF and through IDML. Draw
still kept an appearance as a stack in its metadata envelope with its own Appearance panel and a
group bake (ADR 354), graphic styles held that stack, and Illustrator's Envelope Distort had no
counterpart: the engine's Warp is a fixed style, and nothing bent an item through a free mesh or
into another object's outline.

## Decision

**The host's Appearance panel is the Appearance panel.** Draw contributes no panel of its own:
the host's lists the item's native fills and strokes in their order, with the object's effects
and opacity (editor ADR 312), in every module. Draw's appearance commands (Add fill, Add stroke,
Remove / Move layer, Clear) write `frameAppearance` when the host's engine has
`document.appearance@1`: every selected item in one batch, one undo step; a new fill or stroke
goes directly above the topmost layer of its kind (Illustrator's rule, recorded by the
`appearance` probe). Bake has nothing to bake on a native appearance (IDML export bakes it) and
says so. Without the flag the metadata lane of ADR 354 stays, as the symbols' v0 lane did
(ADR 365).

**Metadata stacks migrate on open.** `installAppearanceMigration` moves every element's stack
onto `frameAppearance` in ONE batch (`migrateAppearanceMutations`): the lower fills and strokes
as layers around the frame's own fill and stroke, the top layers' opacity and blend onto the fill
and stroke targets. A group-baked stack is released first in the same batch. The graphic-style
library is converted (v2) and every link that was in sync is re-stamped in a second batch that
AMENDS the first, so the whole move is one undo step and no follower turns up overridden. A
migrated document has nothing left to move.

**An envelope is a stack entry.** Object ▸ Envelope distort:

- *Make with warp* appends a `warp` entry (Arc, 50 %, as Illustrator's dialog opens) and raises
  the host Appearance panel, where its options are edited.
- *Make with mesh* appends an `envelope` entry: a flat net of `rows` × `columns` bicubic Bézier
  patches (4 × 4 by default; the payload names others) over the item's tight source box, its
  control points in the box's unit square — the engine kind this ADR adds.
- *Make with top object* cuts the frontmost item's outline at its box corners (its own anchors
  when four of them are in turn, else the nearest points), fits each side with one cubic (kept
  exactly when it is one), blends the inside (`coonsPatch`), and gives each content item the part
  of that patch over its own box within the union box (`restrictPatch`), so items made together
  map as one; the front item is deleted in the same batch.
- *Edit contents* selects the items and switches to Direct Selection: the source path is what it
  edits while the envelope keeps drawing (engine ADR 1042's "editing stays on the source").
- *Expand* expands the envelope and the vector entries before it (`expandAppearance`) and puts
  the later ones back, one batch. *Object ▸ Expand appearance* expands every live effect.

**The Envelope Mesh tool** (keyless, in the host's Free Transform flyout — the shortcut
registers are full) draws the mesh as the engine bends it, drags a node with its handles or one
handle alone, and Alt+click adds a row and a column through the point (the surface unchanged).
Each release is one write of the stack.

**Graphic styles on native appearance.** A style also carries `layers` (the native fills and
strokes), `effects` (the object stack, envelopes included) and `targets` (the fill and stroke
targets' opacity and blend); apply writes each where the target has the path and skips what it
already holds; the digest covers them only when they say something, so a v1 style's links keep
their revisions. *Import library* and *Export library* move a library file
(`{ "paged": "graphicStyles", "v": 2, "styles": […] }`) through the host's file doors; *Merge
styles* is Illustrator's Merge Graphic Styles (the first style's paint, the next styles' fills and
strokes as real layers on top, every effect in order) — from the panel's checked rows, or from the
palette over the styles the selection follows. Select Same ▸ Appearance compares the native parts
too.

## Illustrator

`scripts/illustrator/probes/envelope.jsx` (Illustrator 30.1, recorded 2026-10-31) runs Make
Envelope + Expand Envelope; `test/oracle/envelope.spec.ts` replays it:

| case | agreement |
| --- | --- |
| trapezoid | every corner, bounds 0.5 pt, area 0.5 % |
| two contents in one envelope | each content's corners and bounds as above (the union-box mapping) |
| circle | corners exact; CONVENTION: Illustrator refits each content edge with one cubic, so its outline falls short of the circle (box 100.87 … 299.13 against ours on the circle, 100 … 300; area 2 %) |
| wavy top edge | corners exact; CONVENTION as above (Illustrator's top 90.33, ours on the cubic's extreme; bounds 2 pt) |

Make with Warp (`Make Warp`) and Make with Mesh (`Create Envelope Grid`) open their options
dialog, which a script cannot fill in, so they are not recorded; Expand Appearance's part counts
are the `appearance` probe's (engine ADR 1043).

## Consequences

- An envelope, a warp, several fills and strokes and a graphic style made in paged.draw are
  engine state, drawn and edited the same in every module and every export.
- Differences from Illustrator, named: an envelope is per item (Illustrator wraps several in one
  envelope object; Make with Top Object maps them as one, the others do not); a group takes none
  (its stack is the Pathfinder's); Expand appearance expands live effects only — several fills and
  strokes stay native and IDML export bakes them; Release Envelope, Envelope Options and Reset
  with Mesh are not built.
- Not moved onto the native appearance yet: Recolor Artwork and the appearance object kind of the
  object model (ADR 323) still read the metadata stack, which a migrated document no longer holds.
