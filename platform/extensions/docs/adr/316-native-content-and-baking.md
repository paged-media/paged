# ADR 316 — Plugin content is stored as valid native document content; baking is the fallback

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `d90f727`;
  plugin repositories at plugin-draw `0d12bf8`, plugin-sheets `71f37d7`, plugin-data `6b96ce5`,
  plugin-doc `76e1d06`, plugin-web `653a95e`, plugin-image `f7d21e5`, plugin-publish `6994ad1`.
- **Scope:** what a plugin leaves in the document; in this repository the metadata carrier,
  `ObjectTypeContribution.bakedFallback` and the `ObjectTypeBaker` type.

## Context

The contract and the plugin repositories name one concern: what a document shows where the
plugin is absent, in another application that opens the interchange format and in the
engine's own export. The contract gives a plugin two things for this. The metadata carrier
stores a plugin's envelope on a page item, and its doc comment says "IDML round-trips it as a
`Properties/Label` `KeyValuePair`, which InDesign preserves verbatim"
(`packages/plugin-api/src/host.ts:974-979`). An object type marks an element by that
metadata (the comment's example, a web frame, is "an ordinary rectangle") and declares a
`bakedFallback`: "What the baked IDML form degrades to without the plugin"
(`packages/plugin-api/src/host.ts:264-266`, `:286-290`).

The plugins give their reasons. Bound data is compiled to native content "so frame ops
(scale/rotate/skew/crop/reposition) are honored for free" (`plugin-data: CLAUDE.md:13-16`).
A sheet becomes a table that is "selectable + printable + IDML-round-tripping + transforming
with the frame" (`plugin-sheets: packages/sheet-host-model/src/lower-to-table.ts:19-24`). A
multi-paint frame "would be a paged-only extension that cannot round-trip the format the
engine exists to speak" (`plugin-draw: packages/draw-bundle/src/commands/appearance-bake.ts:21-28`).
A web frame is flattened so that "a foreign open sees real content (no plugin engine
needed)" (`plugin-web: packages/web-bundle/src/bake-plan.ts:19-22`).

## Decision

What a plugin puts on the page is ordinary native content, written through
`document.mutate` ([ADR 310](310-one-write-door.md)). State that the native model cannot
hold rides on those items as the plugin's metadata envelope, or in a container part
([ADR 311](311-plugin-state-under-own-id.md)). Where the visible result is not native
content, a bake lowers it to native items, so that the document without the plugin still
shows valid content.

| Plugin | What is in the document | Baking |
|---|---|---|
| plugin-draw | Native paths and groups from the start; no object type, no scene layer. | Bundle commands: an appearance stack is baked into the frame's own fill and stroke, or into a group of derived paths with the source frame as carrier; "release" is the inverse. |
| plugin-sheets | A native table in a text frame, plus the binding envelope; charts as native paths and text frames. The in-place editing grid is a scene layer and is not document content. | None. A tab-separated text lane is the fallback when the host rejects `insertTable`. |
| plugin-data | Placeholder fields, a native table, placed images, one path per barcode module, element visibility. | None; the same text-lane fallback. |
| plugin-doc | Native stories, styles, tables, anchored frames and hyperlinks. | None. |
| plugin-web | A native rectangle with the HTML/CSS source in metadata and a container part. The rendering is a scene layer, not document content. | An explicit command, "Bake web frame to document", flattens the rendered layer into rectangles, paths and text frames. |
| plugin-image | The placed image frame stays native and keeps its original bytes; the frame carries an ownership marker. Edits live in the plugin's session and are shown as a scene-layer image. | None: edited pixels do not enter the document. |
| plugin-publish | Its importers hand the host a whole native document; there is no plugin content. | Not applicable. |

In this repository the baking contract is declared and not run. `bakedFallback` is a closed
vocabulary (`group`, `rectangle`, `raster`) that the schema and the CLI validate; three
manifests declare it (plugin-web and plugin-sheets `rectangle`, plugin-doc `group`).
`ObjectTypeBaker` and `BakeContext` are exported types that no code implements or calls.

## Evidence

- `packages/plugin-api/src/host.ts:264-296`, `:966-996` — the object type and its
  `bakedFallback`; the metadata carrier and envelope
- `packages/plugin-api/src/host.ts:998-1021` — `ObjectTypeBaker`, with the note that it
  "ships ahead of the host loop"; `packages/plugin-sdk/src/host-impl.ts:1459-1474` — the
  adapter registers an object type and never reads `bakedFallback`
- `packages/plugin-api/src/manifest.schema.json:282-302`,
  `packages/plugin-cli/bin/paged-plugin.mjs:39`, `:465` — the closed vocabulary
- `plugin-draw: packages/draw-bundle/manifest.json:12-15`,
  `plugin-draw: packages/draw-bundle/src/commands/appearance.ts:22-29`,
  `plugin-draw: packages/draw-bundle/src/commands/appearance-bake.ts:21-48` — `rendering` is
  overlay and hit test only; the two bakes
- `plugin-sheets: packages/sheet-bundle/src/lower.ts:19-40`, `:381-386`,
  `plugin-sheets: packages/sheet-bundle/src/activate.ts:280-285` — the two lanes, the
  runtime fallback, the declared object type
- `plugin-data: packages/data-bundle/src/lower.ts:19-24`,
  `plugin-data: packages/data-host-model/src/barcode.ts:19-29`,
  `plugin-doc: docx-lower/src/lib.rs:19-23` — native lowering in plugin-data and plugin-doc
- `plugin-web: packages/web-bundle/src/edit-context.ts:60-65`,
  `plugin-web: packages/web-bundle/src/activate.ts:117-127` — the declared fallback; the
  bake command
- `plugin-image: glue/src/session.ts:25-30`, `:1371-1378` — adjusted pixels go back as a
  scene-layer image; the marker `{ v: 1, data: { owns: "pixels" } }`

## Alternatives considered

The contract describes a baker driven by the host, which would apply the mutations
"atomically (one undo step) on metadata change (debounced) and before save/export"
(`packages/plugin-api/src/host.ts:999-1005`); it is not built. plugin-draw rejected a
multi-paint frame in the engine (see Context). plugin-data rejects a raster barcode because
inline image bytes cannot be placed (`plugin-data: packages/data-host-model/src/barcode.ts:27-29`).

## Consequences

Content that follows the decision is edited with the host's own tools, is undone on the
engine's history and is written by the engine's exporters with no plugin code. Baking is
per plugin: each bundle decides when to bake and what it covers, and nothing in the host
bakes before save or export. The declared `bakedFallback` describes an intent; no code in
this repository's adapter or in the editor's source reads the value.

Two plugins do not put their visible result into the document. A web frame shows content
only after a render command in the session, and reaches an IDML export only through the
explicit bake, whose coverage is partial (ADR 407, under Related). An edited image leaves
plugin-image only as file bytes (ADR 460, under Related).

Comments disagree with the code in two places. `packages/plugin-api/src/host.ts:1007` says
"`contribute.objectType` is still reserved at runtime"; the adapter implements it
(`packages/plugin-sdk/src/host-impl.ts:1459`), and only the bake loop is missing.
`packages/plugin-api/src/manifest.ts:345` still calls `objectTypes` "Reserved".

## Related

- [ADR 310](310-one-write-door.md), [ADR 311](311-plugin-state-under-own-id.md), [ADR 010](010-raw-mutate-gate-capability-enforcement.md) — the write door; where plugin state lives; the metadata key gate
- [ADR 351](https://github.com/paged-media/plugin-draw/blob/main/docs/adr/351-shapes-are-native-page-items.md), [ADR 354](https://github.com/paged-media/plugin-draw/blob/main/docs/adr/354-multi-paint-bakes-to-a-group.md), [ADR 505](https://github.com/paged-media/plugin-sheets/blob/main/docs/adr/505-native-table-and-edit-grid.md), [ADR 551](https://github.com/paged-media/plugin-data/blob/main/docs/adr/551-compiled-to-native-content.md), [ADR 600](https://github.com/paged-media/plugin-doc/blob/main/docs/adr/600-docx-lowered-onto-native-model.md) — native content in four plugins
- [ADR 406](https://github.com/paged-media/plugin-web/blob/main/docs/adr/406-web-frame-and-source-storage.md), [ADR 407](https://github.com/paged-media/plugin-web/blob/main/docs/adr/407-baking-flattens-to-native-items.md), [ADR 459](https://github.com/paged-media/plugin-image/blob/main/docs/adr/459-scene-layer-image-and-tiles.md), [ADR 460](https://github.com/paged-media/plugin-image/blob/main/docs/adr/460-document-is-not-the-store.md) — the two plugins whose visible result is a scene layer
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md), [ADR 021](https://github.com/paged-media/core/blob/main/docs/adr/021-paged-native-document-model-idml-as-format.md) — the scene layer; the native document model
