# ADR 360 — A bake or trace record names no id its own batch mints

- **Status:** Accepted 2026-10-20.
- **Scope:** `packages/draw-bundle/src/commands/appearance-bake.ts` (`bakeBatchFor`,
  `bakedLayersOf`, `AppearanceBakeRecord`), `packages/draw-bundle/src/commands/image-trace.ts`
  (`traceBatchFor`, `tracedRegionOf`, `ImageTraceRecord`)

## Context

Bake appearance and Image Trace each took two undo steps (findings DRW-5 and DRW-6, root R4).
Their first batch inserted paths; the second painted and grouped them and wrote a record into
the source's plugin metadata naming the new elements by id (`appearanceBake.layers`,
`imageTrace.regions`). Every op but the record could address the new paths by batch handle
(`bindCreated`, `"$h:"`). The record could not: an envelope is a JSON string, and the engine
treats a `$h:` inside text as content (`test/headless/minted.spec.ts`).

There were two ways to make it one batch:

1. The engine resolves batch handles inside metadata text. That makes a handle-shaped string in
   any text a reference, changes the C-15 rule that text is never rewritten, and changes the
   canvas wasm, so the wire and the contract move with it.
2. The record names no id that its own batch mints.

## Decision

The record names no minted id (option 2).

- Each derived layer of a bake already carries a marker naming its carrier
  (`appearanceLayer.of`), and the carrier exists before the batch. The layers of a baked carrier
  are the members of its group whose marker names it (`bakedLayersOf`), in group order, which
  is paint order. The record keeps the carrier's pre-bake paint (`restore`) and no list.
- Each traced region gets a marker naming the image it was traced from (`tracedRegion.of`). The
  trace record keeps what was traced and how, and no list.
- So the whole bake and the whole trace are one batch: insert and name, then paint, mark and
  group by handle. One undo step each.
- A record written before this ADR still lists its ids. `appearanceBakeOf` and `imageTraceOf`
  read the list, and release takes a listed layer that is still alive as a layer too. A new
  record is written without it.

The same rule holds for any later flow that records what it made: name it from the made thing
(a marker on it pointing at something that already exists), not from the record.

## Consequences

- DRW-5 and DRW-6 close: one undo step each, measured against the real engine
  (`test/headless/commands-recipes.spec.ts`, `appearance-bake.spec.ts`, `image-trace.spec.ts`,
  the perf budgets).
- No engine, wire or contract change.
- A re-bake (an edit of a baked stack) is release + bake: two undo steps, was three.
- Release reads the carrier's group and each member's envelope instead of a list. A layer moved
  out of the group by hand is no longer found by a new bake's release; a legacy record's listed
  layer still is.
- The appearance-bake InDesign recording was re-recorded on 2026-10-20 (the envelope lost its
  list; geometry, paint and grouping are unchanged).

## Related

- [ADR 354](354-multi-paint-bakes-to-a-group.md) — the group bake (amended)
- [ADR 357](357-image-trace-rust-lane.md) — Image Trace (amended)
- [ADR 356](356-live-constructs-are-recipes.md) — one-shot results as artwork
