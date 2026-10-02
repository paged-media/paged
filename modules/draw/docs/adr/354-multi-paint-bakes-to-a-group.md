# ADR 354 — A multi-paint appearance bakes to a group of single-paint items

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-bundle/src/commands/{appearance,appearance-bake}.ts`, and every
  module that writes the plugin's metadata envelope

## Context

An appearance in paged.draw is a stack of fills and strokes, each with tint, opacity and blend
mode. An engine frame has one fill and one stroke (`packages/draw-bundle/src/commands/appearance.ts:22-24`).

State the engine cannot model rides on the element in one envelope `{ v, data, engine? }` under
the key `x-paged:media.paged.draw` (ADR 311, ADR 316). Each feature has its own key under
`data` (`appearance`, `graphicStyle`, `symbolInstance` and others).

The first version (commit `0c2f8f4`, 2026-06-13) kept the stack in the envelope and wrote only
the front-most fill and stroke to the frame. Its message names two ways to a faithful stack:
"a multi-paint frame model or baking into an overlapping group". The bake module gives the
reason for the choice: "A multi-paint frame would be a paged-only extension" that cannot
round-trip IDML, while a group of stacked items with one paint each "is ordinary IDML"
(`packages/draw-bundle/src/commands/appearance-bake.ts:21-26`).

## Decision

The appearance stack is lowered to document content by the bundle; the engine's frame model
was not extended. "Baking" here means writing plugin-only state from the envelope onto real
page items. There are two bakes.

- **Front-most-layer bake**, for an object that is not group-baked. `commitAppearance` stores
  the stack with `host.document.setMetadata`, then writes the top fill (colour, tint) and the top
  stroke (colour, weight) to the frame's own paint properties.
- **Group bake**, the `bakeAppearance` command. The source frame stays as the carrier: it keeps
  its identity, geometry and envelope, and its own fill and stroke are cleared. One derived path
  per paint is inserted with `insertPath`, fills bottom to top and then strokes; each gets one
  paint with its tint, opacity and blend mode. `createGroup` wraps the carrier and the derived
  paths. The carrier's envelope gains `data.appearanceBake` (layer ids, the carrier's paint
  before the bake); each derived path gets `data.appearanceLayer` (carrier id, kind, index).
  `releaseAppearance` is the inverse.

An envelope write that must share an undo step with the paint it describes is a raw
`setPluginMetadata` op inside the batch (`stampDrawMetadata`), not a call to the facade. A
selected group, carrier or derived layer resolves to the same stack. The manifest declares no
object type and no baked fallback; the bake is run by the bundle's commands.

## Evidence

- `packages/draw-bundle/src/commands/appearance-bake.ts:21-48`, `:50-62` — why a group and the
  document shape; the measured undo steps
- `packages/draw-bundle/src/commands/appearance-bake.ts:144-151`, `:374-385` — the key
  `x-paged:${manifest.id}`; the raw in-batch stamp and why the facade is not used
- `packages/draw-bundle/src/commands/appearance-bake.ts:157-176`, `:218-234` — the bake record
  and the layer marker; the merge that preserves every other key
- `packages/draw-bundle/src/commands/appearance-bake.ts:452-487`, `:494-523`, `:566-587` — the
  paint batch (carrier cleared, envelope stamped, `createGroup`); release; carrier resolution
- `packages/draw-bundle/src/commands/appearance.ts:211-262`, `:279-297` — the front-most-layer bake
- `packages/draw-bundle/test/conformance/appearance-bake.spec.ts:603`, `:743`, `:764` — two undo
  steps asserted; PDF export paints every layer; the baked group survives an IDML save

## Alternatives considered

- A multi-paint frame in the engine: named in `0c2f8f4`, rejected in the passage quoted above.
- The front-most-layer bake alone: the first shipped state; an unbaked object still shows it.
- The envelope on the group: `setPluginMetadata` answers `notImplemented` for a group id
  (`packages/draw-bundle/src/commands/appearance-bake.ts:569-571`).
- An engine object style to hold a graphic style: its seven fields would drop every layer past
  the first (`packages/draw-bundle/src/commands/graphic-styles.ts:30-35`).

## Consequences

A baked appearance is plain page items: the module states that it renders, exports to PDF and
survives an IDML save and re-import with the envelope on the carrier
(`packages/draw-bundle/src/commands/appearance-bake.ts:64-96`). The costs and limits are named:

- A bake is two batches and two undo steps. The bake module gives as the reason that a batch op
  cannot address an id minted earlier in the same batch
  (`packages/draw-bundle/src/commands/appearance-bake.ts:52-57`); the contract has since gained
  `bindCreated`, which an unclipped repeat and a blend use to build in one step, and the bake has
  not been converted (`CLAUDE.md:357-362`). Release is one. An edit of a baked stack re-bakes: three.
- A source with more than one subpath, or one on the pasteboard, is refused
  (`packages/draw-bundle/src/commands/appearance-bake.ts:266-300`).
- After an IDML save the baked group re-imports above the items the source file already had;
  its place among them is not kept (`packages/draw-bundle/src/commands/appearance-bake.ts:98-107`).
- Graphic-style save, apply and redefine refuse a baked object
  (`packages/draw-bundle/src/commands/graphic-styles.ts:113-118`).
- A stale comment: `packages/draw-bundle/src/handlers/brush.ts:32-34` says an inserted Polygon
  rejects direct frame-property writes; the bake's paint batch makes exactly such writes.

## Related

- [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md), [ADR 311](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/311-plugin-state-under-own-id.md) — the general rule for native content and baking; state under the plugin's own id
- [ADR 310](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/310-one-write-door.md), [ADR 010](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/010-raw-mutate-gate-capability-enforcement.md), [ADR 309](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/309-conformance-against-real-engine.md) — the write door; the gate a raw `setPluginMetadata` passes; the real engine behind the measured counts
- [ADR 351](351-shapes-are-native-page-items.md), [ADR 355](355-libraries-in-container-parts.md), [ADR 356](356-live-constructs-are-recipes.md) — native items; document-level state; recipes
