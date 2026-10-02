# ADR 353 — Path algebra that changes a document path runs in the engine

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-geometry`, and the path commands and tools in `packages/draw-bundle`

## Context

When the repo was scaffolded the engine had no outline-stroke, offset-path or simplify
operation. The gap log of that day (`BREAKAGE_LOG.md` at commit `a0367d6`, since removed) set
the direction: add a kernel to the engine and expose the three as mutations. Its last version
(at `5158035^`) records both as landed, and says the local TypeScript closest-point math stays
legitimate for synchronous interactive paths.

A second reason for math in TypeScript is in `packages/draw-bundle/src/handlers/insert-path.ts:26-30`:
the tool machines fit the curve themselves and the engine's own smoothing pass is not requested,
so that the preview and the committed geometry are the same.

No passage states the split as one rule, or says why a boolean kernel in TypeScript was not
considered. The repository does not record why.

## Decision

Path algebra on a document path (combining, dividing, outlining, offsetting, simplifying,
joining, closing) is an engine wire op. The bundle chooses operands, order and parameters and
sends the op through `host.document.mutate`:

- shape modes: `pathfinderBoolean` with kind `union`, `subtract`, `intersect` or `exclude`;
- regions of the planar arrangement: `pathfinderDivide`, `pathfinderTrim`, `pathfinderMerge`,
  `pathfinderCrop`, `pathfinderOutline`, `pathfinderMinusBack`, `pathfinderFaces`;
- `outlineStroke`, `offsetPath`, `simplifyPath`, `joinPaths`, `closePath`, and variable-width
  outlining as the `outlineStrokeVariable` property path of `setElementProperty`.

The arrangement itself is read through one door, `host.document.planarRegions`, in one module.
The repo contains no boolean, offset or outline kernel, in TypeScript or in Rust. The three brush
tools are composed from `insertPath`, the outline ops and `pathfinderBoolean`.

`draw-geometry` holds what a tool computes synchronously or before it commits: simplification
of a stroke (RDP), de Casteljau split, closest-t, flattening, handle derivation, curve fitting
through points, width profiles, placement along a path, repeat affines, parametric shapes. It
also holds one piece of contour bookkeeping the engine leaves to the caller: `makeCompoundTable`
re-winds nested contours by nesting depth, because the engine fills non-zero.

## Evidence

- `packages/draw-bundle/src/commands/pathfinder.ts:75-84` — the `pathfinderBoolean` builder
- `packages/draw-bundle/src/commands/pathfinder-region.ts:19-24`, `:72-78`, `:131-150` — six
  region verbs, each one wire op; the `pathfinderFaces` builder
- `packages/draw-bundle/src/commands/path-ops.ts:19-22`, `:102-138` — outline, offset, simplify
- `packages/draw-bundle/src/commands/join-average.ts:21-42`, `:214-234` — `closePath`, `joinPaths`
- `packages/draw-bundle/src/handlers/brush.ts:19-30`, `:99-115` — brushes
  "composed ENTIRELY from existing engine ops"; the variable-width outline builder
- `packages/draw-bundle/src/handlers/planar-regions.ts:112-130` — the one arrangement read
- `packages/draw-geometry/src/compound.ts:23-33`; `CLAUDE.md:456-463` — why winding is done
  here; one winding implementation in the repo, in TypeScript
- `packages/draw-geometry/src/index.ts:33-41`, `:98-123`, `:161-175` — the exported gesture math

## Alternatives considered

The log's entry on the geometry kernel names the choice inside the engine ("add kurbo"); the
engine-side record is ADR 004 in core. In this repo Join first shipped as a move of endpoints with
`pathPointSet`, kept as the fallback for an engine without `joinPaths`
(`packages/draw-bundle/src/commands/join-average.ts:34-42`).

## Consequences

A new path-algebra operation needs an engine op first. Engine limits are product limits:

- The arrangement takes at most 12 inputs and 256 faces; past either the engine refuses and
  never truncates (`packages/draw-bundle/src/commands/pathfinder-region.ts:41-48`).
- The arrangement runs in raw path space; item transforms are not composed. The bundle maps
  through the frontmost input's transform, which is approximate when inputs differ
  (`packages/draw-bundle/src/handlers/planar-regions.ts:61-68`).
- The variable-width outline treats the contour as open, takes a single contour and ignores
  cap, join and miter limit (`packages/draw-bundle/src/handlers/brush.ts:41-47`).

Three lanes do write TypeScript-computed geometry into an existing path: the anchor tools, whose
segment split goes out as `pathPoint*` ops; Average endpoints and the Join fallback, which move
endpoints with `pathPointSet` (`packages/draw-bundle/src/commands/join-average.ts:139-202`); and
Make and Release Compound Path, which write the merged, re-wound table with `framePath`
(`packages/draw-bundle/src/commands/compound-path.ts:41-55`). Pattern, repeat, symbols, live paint
and image trace use the same `framePath` builder on paths they have just inserted.

Comments lag the code. `packages/draw-bundle/src/handlers/planar-regions.ts:27-38` still
describes a raw `client.send` read; the function below calls the published facade. The region
and join builders still cast to `Mutation` (`packages/draw-bundle/src/commands/pathfinder-region.ts:135`,
`:149`; `packages/draw-bundle/src/commands/join-average.ts:221`, `:233`), while `CLAUDE.md:222-223`
says one cast survives. One read is still raw: `requestNearestPathPoint` in
`packages/draw-bundle/src/handlers/measure.ts:168-173`.

## Related

- [ADR 004](https://github.com/paged-media/core/blob/main/docs/adr/004-kurbo-geometry-kernel.md) — the engine's geometry kernel
- [ADR 310](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/310-one-write-door.md), [ADR 305](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/305-doors-always-present.md) — the write door; probing instead of reading a version
- [ADR 350](350-three-typescript-layers.md), [ADR 351](351-shapes-are-native-page-items.md), [ADR 357](357-image-trace-rust-lane.md) — the geometry package; native items; the tracer reuses the winding step
