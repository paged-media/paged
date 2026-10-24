# ADR 361 — Visual live constructs move to the engine; recipes remain for generators

- **Status:** Accepted 2026-10-24. Partially supersedes [ADR 354](354-multi-paint-bakes-to-a-group.md)
  (the multi-paint bake) and [ADR 356](356-live-constructs-are-recipes.md) (recipes, for the
  constructs named below). Follows from [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md).
- **Scope:** `packages/draw-bundle/src/commands/{appearance,appearance-bake,symbols,width-profile}.ts`,
  `packages/draw-bundle/src/handlers/{brush,width}.ts` and their panels; the engine records that
  carry the constructs (core ADRs 1007–1012)

## Context

ADR 356 built symbols, live paint, patterns, repeats and blends as a stored recipe plus ordinary
artwork, because the engine had no node for them. ADR 354 baked a multi-paint appearance into a
group of single-paint items, because an engine frame has one fill and one stroke. Brushes and
width profiles bake an outline the same way (`commands/width-profile.ts`: "destructive, as the
tool's bake is").

The result renders everywhere, but it is live only inside this module: a doc, slide or sheet
document cannot carry an effect, a brush or an appearance stack, the host's panels cannot edit
one, and the user has to run a verb to see an input's change. PM-0014 puts anything visible on a
page item in the engine, so that every module's output, every export and the host's panels see
it.

## Decision

Two kinds of construct, two homes.

- **Visual constructs become engine-native.** What changes how one item looks is a property of
  that item in the engine model, rendered on GPU, CPU and in PDF, and edited by the host panels:
  - **effects** — live vector effects (roughen, zig-zag, pucker and bloat, warp, offset, round
    corners and the rest) and the ordered effect stack (core ADRs 1008, 1009);
  - **brushes** — art, scatter and pattern brushes along a path (core ADR 1009);
  - **width profiles** — variable-width strokes (core ADR 1009);
  - **multi-paint appearance** — several fills and strokes on one item (core ADR 1009);
  - **symbols** — a symbol instance node (core ADR 1012).

  The draw module keeps the tools and panels that author them; it stops baking them. IDML export
  bakes the geometry and keeps the source in a label, so a round trip through InDesign loses
  liveness, not the picture.
- **Generators keep the recipe model of ADR 356.** What produces several items from inputs stays a
  stored recipe plus ordinary artwork with explicit verbs: **repeat**, **blend**, **pattern
  tiling** (as artwork; the pattern *paint* is core ADR 1007), **objects on a path** and **live
  paint**.
- **Until an engine record lands, the current bake stays.** Each construct switches when its
  engine property ships; existing baked artwork and recipes keep opening, and Expand still turns
  a live construct into plain items.

## Consequences

- An effect, brush, width profile, appearance stack or symbol drawn in paged.draw is live in a doc,
  slide or sheet document too, and editable from the host's panels.
- The appearance bake (ADR 354, ADR 360) and the destructive width bake become the IDML-export path
  and the Expand verb, not the document's state.
- Recipes for generators keep their limits: "live" means "can be regenerated", and the artwork is
  stale until the verb runs.
- The draw module's geometry for these effects moves to `paged-vector-fx` in the engine, and the
  module calls it there.

## Related

- [ADR 354](354-multi-paint-bakes-to-a-group.md), [ADR 356](356-live-constructs-are-recipes.md) — what this partially supersedes
- [ADR 360](360-records-name-no-minted-ids.md) — the one-batch bake that becomes the export path
- [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md) — the layering this applies
