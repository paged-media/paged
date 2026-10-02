# ADR 355 — Document-level libraries and recipes live in container parts

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-bundle/manifest.json` (`contributes.partTypes`) and the seven command
  modules in `packages/draw-bundle/src/commands/` that read and write a part

## Context

Some paged.draw state belongs to the document and not to one element: a library of named
graphic styles, a library of symbol definitions, and the parameters of a live-paint group, a
pattern field, a repeat, a blend or a distribution of objects on a path.

The graphic-styles module states why neither of the two other stores could hold it
(`packages/draw-bundle/src/commands/graphic-styles.ts:39-49`). Reopening the file somewhere else
must find the styles, and `host.storage` is "per-plugin-per-BROWSER (it does not travel)". Plugin
metadata is per element only: the engine's metadata op resolves leaf items, so there is no
document-level slot, and a group cannot carry metadata at all. The symbols module repeats the
same reasoning (`packages/draw-bundle/src/commands/symbols.ts:76-80`).

## Decision

Document state of this kind is written as one JSON part per feature inside the `.paged`
container, under the plugin's own namespace `paged/media.paged.draw/`, through `host.parts`.

- There are seven parts: `graphic-styles.json`, `symbols.json`, `live-paint.json`,
  `pattern.json`, `repeat.json`, `blend.json` and `objects-on-path.json`. The manifest declares
  seven part types (`graphicStyleLibrary`, `symbolLibrary`, `livePaintRecipe`, `patternRecipe`,
  `repeatRecipe`, `blendRecipe`, `objectsOnPathRecipe`), each with `role: "spec"`,
  `format: "json"` and `linkable: false`.
- An element carries only a link in its metadata envelope, for example
  `data.graphicStyle = { id, rev }`. A style's name and definition are resolved from the library
  by id, so a rename changes the library and does not walk the document.
- Each part is an object with a version `v` (1 in all seven) and one array of records. Absent
  bytes, invalid JSON or another `v` read as an empty library.
- Every read and write is guarded by `host.supports("storage.parts@1")`. Without it a read
  logs a warning and returns an empty library, and a write returns `false`.

## Evidence

- `packages/draw-bundle/manifest.json:166-209` — the seven `partTypes`
- `packages/draw-bundle/src/commands/graphic-styles.ts:39-49`, `:52-74` — why `host.parts`; the
  library shape and the `{ id, rev }` link
- `packages/draw-bundle/src/commands/graphic-styles.ts:170-181`, `:285-326` — part name, version
  and capability; the tolerant parser and the indented serializer
- `packages/draw-bundle/src/commands/graphic-styles.ts:647-693` — guarded read and write
- `packages/draw-bundle/src/commands/symbols.ts:63-80`,
  `packages/draw-bundle/src/commands/live-paint.ts:89-105`,
  `packages/draw-bundle/src/commands/pattern.ts:105-125` — the same shape in three more features
- `packages/draw-bundle/src/commands/graphic-styles.ts:108-112` — a part write is not an engine
  mutation and is not undone
- `CLAUDE.md:300-305` — seven parts; the one whose recipe is not load-bearing

## Alternatives considered

`host.storage` and per-element metadata are named and rejected in the passage cited above. An
engine object style is rejected in the same header for holding too little
([ADR 354](354-multi-paint-bakes-to-a-group.md)).

Objects on a path splits its state on purpose: each object's home transform is kept on the
object's own link, so Release and Update work on a host with no container writer and only the
parameters are lost there (`packages/draw-bundle/src/commands/objects-on-path.ts:184-188`).

## Consequences

Renaming a library entry costs no document mutation. The cost is that the library is outside
undo: an undo after a part write unwinds the mutation and leaves the part in place. Undoing the
making of a repeat therefore removes the artwork and leaves a recipe naming ids that no longer
exist; the readers tolerate a dangling id (`packages/draw-bundle/src/commands/repeat.ts:144-147`).

On a host without a container writer the features degrade differently:

- graphic styles, symbols and live-paint recipes cannot be read or saved;
- a pattern field, a repeat and a blend can still be released through their per-leaf links and
  lose only their parameters (`packages/draw-bundle/src/commands/pattern.ts:123-125`,
  `packages/draw-bundle/src/commands/blend.ts:1146-1153`);
- a repeat is built unclipped, because a clipped instance is invisible to `document.tree()` and
  the recipe would be the only index to it (`packages/draw-bundle/src/commands/repeat.ts:1346-1354`).

Limits at this commit: there is no migration code, so a part with another `v` is shown as empty.
Merging, importing, exporting and organising style libraries are not built
(`packages/draw-bundle/src/commands/graphic-styles.ts:119-121`). The record collections are
arrays, not maps; live paint and pattern give the reason, a deterministic and diffable part
(`packages/draw-bundle/src/commands/live-paint.ts:99-100`).

## Related

- [ADR 311](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/311-plugin-state-under-own-id.md), [ADR 305](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/305-doors-always-present.md) — plugin state under its own id; probing `storage.parts@1`
- [ADR 118](https://github.com/paged-media/core/blob/main/docs/adr/118-paged-file-is-a-valid-idml-package.md), [ADR 021](https://github.com/paged-media/core/blob/main/docs/adr/021-paged-native-document-model-idml-as-format.md) — the `.paged` container this rests on
- [ADR 354](354-multi-paint-bakes-to-a-group.md), [ADR 356](356-live-constructs-are-recipes.md) — the per-element envelope; what a recipe is for
