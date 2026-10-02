# ADR 356 — Live constructs are a stored recipe plus artwork that can be regenerated

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-bundle/src/commands/{symbols,live-paint,pattern,repeat,blend}.ts`,
  with their panels and tools

## Context

Symbols, live paint, patterns, repeats and blends promise by name an object that lives in the
document and follows its inputs. The engine has no such node. The symbols module:
"THE ENGINE HAS NO SYMBOL/INSTANCE PRIMITIVE, and neither does IDML."
(`packages/draw-bundle/src/commands/symbols.ts:27`). The blend note:
"The engine has no blend node" (`packages/draw-bundle/src/commands/blend.ts:236`). Live paint has
a per-call query of the planar arrangement, whose face ids mean something only against the
ordered input list that produced them (`packages/draw-bundle/src/commands/live-paint.ts:27-35`).

The live-paint header names the posture the repo takes and says that appearance stacks, patterns
and image trace did the same before it (`packages/draw-bundle/src/commands/live-paint.ts:37-40`).
The pattern module says why no fake object is invented: a third swatch kind
"would render nothing and lie on save" (`packages/draw-bundle/src/commands/pattern.ts:30`).

## Decision

Each of the five was built in the plugin, without a new node type in the engine, as three parts.

- **A recipe**: the ordered inputs and the parameters, stored in a container part
  ([ADR 355](355-libraries-in-container-parts.md)).
- **Real artwork**: ordinary page items inserted with `insertPath`. Every leaf carries a link to
  the recipe in its metadata envelope, because a group cannot carry metadata.
- **Explicit verbs**. Editing an input does not change the result. Regenerate (live paint),
  Update (repeat, blend), Re-plan (pattern) and Redefine (symbols) derive the artwork again;
  Expand, Release, Delete tiles and Break link take the construct apart.

What the engine cannot represent at all is not approximated. It is refused with a diagnostic or
left out, and the limit is written into a panel note or a command title: a pattern as a paint
(a swatch), live-paint edge strokes and gap tolerance, a clip group, a text frame inside a
symbol or a pattern. Tests pin the panel notes of pattern, repeat and blend.

## Evidence

- `packages/draw-bundle/src/commands/live-paint.ts:19-50`, `:53-76` — "REGENERABLE, NOT LIVE";
  recipe, inserted fills, Regenerate; edges and gap options not reachable
- `packages/draw-bundle/src/commands/symbols.ts:38-60` — an instance is re-emitted through
  `insertPath`; text frames refused; the link on every leaf
- `packages/draw-bundle/src/commands/pattern.ts:23-39`, `:64-67`, `:79-96` — no pattern paint; a
  re-editable tile field; copies are Polygons, text frames refused; copies paint above the source
- `packages/draw-bundle/src/commands/repeat.ts:261-266`,
  `packages/draw-bundle/src/commands/blend.ts:235-240` — the notes shown to the user: real
  artwork plus a recipe; Update re-reads the sources
- `packages/draw-bundle/src/activate.ts:278-284`;
  `packages/draw-bundle/test/conformance/pattern.spec.ts:260-263`,
  `packages/draw-bundle/test/conformance/repeat.spec.ts:1293-1296`,
  `packages/draw-bundle/test/conformance/blend.spec.ts:1017` — panel notes and their tests
- `packages/draw-bundle/src/commands/group.ts:39-47` — a clip group is not representable

## Alternatives considered

- An engine object per feature (a persistent face and edge graph, a pattern paint kind, a clip
  extension of the group). The code names each as engine work that does not exist
  (`packages/draw-bundle/src/commands/pattern.ts:24-33`,
  `packages/draw-bundle/src/commands/group.ts:60-63`).
- Approximating an edge stroke by stroking a face outline: rejected as a different shape
  (`packages/draw-bundle/src/commands/live-paint.ts:58-60`).
- Objects on a Path is the opposite design in the same repo. It writes one `frameTransform` per
  selected object and inserts nothing, so element ids survive and text frames are not refused
  (`packages/draw-bundle/src/activate.ts:484-491`, `CLAUDE.md:140-146`).

## Consequences

The visible result is ordinary page items ([ADR 351](351-shapes-are-native-page-items.md)), and
the engine is not asked to model symbols, live paint or pattern paints. In return "live" means
"can be regenerated", and the result is stale until the user runs the verb. Further limits:

- A symbol instance carries geometry and flat paint; a pattern copy is a Polygon with paint.
- An inserted item lands at the top of the page's z-order: a face fill paints above the paths
  that bound it, and pattern copies paint above their source
  (`packages/draw-bundle/src/commands/live-paint.ts:124-130`).
- A flow that inserts and then paints costs two batches and two undo steps. An unclipped repeat
  and a blend cost one, through `bindCreated` (`packages/draw-bundle/src/commands/repeat.ts:34-41`).
- Moving a live-paint member can renumber faces under an unchanged id; Regenerate rebuilds the
  face ids that still resolve and reports the others.
- Some headers describe an older contract: `packages/draw-bundle/src/commands/repeat.ts:55-57`
  names `0.2.25-canary.0` and a cast; `packages/draw-bundle/package.json:24-25` pins
  `0.2.33-canary.0`, and `packages/draw-bundle/src/commands/v59-wire.ts:34-45` says the three op
  casts are gone (one cast remains in that file, in `batchMutationFor`, `:156-183`).

## Related

- [ADR 355](355-libraries-in-container-parts.md), [ADR 354](354-multi-paint-bakes-to-a-group.md) — where recipes are stored; the envelope and the bake
- [ADR 353](353-path-algebra-runs-in-the-engine.md), [ADR 357](357-image-trace-rust-lane.md) — the arrangement query; the one-shot tracer
- [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md), [ADR 007](https://github.com/paged-media/core/blob/main/docs/adr/007-carry-through-rendering-honesty.md) — native content; not faking what cannot be rendered
