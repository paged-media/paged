# ADR 351 — Drawn shapes are native page items; the plugin owns no content type

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `0d12bf8`.
- **Scope:** `packages/draw-bundle` (manifest, tools, commands, the SVG importer and exporter)
  and the SVG reader and writer in `packages/draw-geometry`

## Context

The plugin contract gives a bundle two ways to put something on a page. It can write ordinary
document content through `host.document.mutate`, or it can register an object type
(`contributes.objectTypes`) and submit its own drawing through a scene layer; the rendering
capability names are `sceneLayer`, `overlay`, `hitTest` and `resourceProvider`
(`plugin-sdk: packages/plugin-sdk/src/host-impl.ts:1096-1098`, `:1459-1464`, `:1589-1604`).

The repo states its reasons per feature, not once. The SVG importer's header:
"No new platform door: it rides" `host.document.mutate` only
(`packages/draw-bundle/src/io/svg.ts:25-26`). The symbols module says the engine has no symbol
primitive and that no core op was invented for the feature
(`packages/draw-bundle/src/commands/symbols.ts:27-36`). The edit context enters by kind because
"a path is recognizable from its engine kind" (`packages/draw-bundle/src/edit-context.ts:26`).
No passage states the rule for the plugin as a whole; the general rule for plugins is ADR 316.
The SVG reader had to fit a package with no dependencies ([ADR 350](350-three-typescript-layers.md)).

## Decision

Everything paged.draw produces is ordinary engine content written through
`host.document.mutate`. New paths are created with `insertPath`, anchors are edited with the
`pathPoint*` ops, paint is set with `setElementProperty`, groups are made with `createGroup`.

The manifest declares `rendering: ["overlay", "hitTest"]` and no `objectTypes`. The bundle
registers no object type and no scene layer. What it draws on the canvas itself is the transient
tool preview (`host.overlay.setToolPreview`). The `vectorGraphic` edit context claims an element
by its engine kind (`polygon`, `graphicLine`, `rectangle`, `textFrame`), not by plugin metadata.

SVG is an interchange format only. The importer parses the file with a hand-written XML and SVG
reader in `draw-geometry` and, for each shape, creates colour swatches, points the document's
creation defaults at them and inserts one path per contour on the target page; at the end it
restores the defaults. The exporter reads the selected elements' anchors and paint and writes one
`<path>` per shape. Both are registered only when the host reports `contribute.importer@1` and
`contribute.exporter@1`. Nothing SVG-shaped is stored in the document.

## Evidence

- `packages/draw-bundle/manifest.json:7-22`, `:32-216` — `rendering` is `overlay` and `hitTest`;
  `contributes` has no `objectTypes` key
- `packages/draw-bundle/src/handlers/insert-path.ts:19-48` — the one builder that turns a
  freehand or curvature commit into `insertPath`
- `packages/draw-bundle/src/handlers/anchors.ts:66-113` — anchor edits: `pathPointRemove`,
  `pathPointCurveType`, and one `batch` of two `pathPointSet` and one `pathPointInsert`
- `packages/draw-bundle/src/edit-context.ts:25-29`, `:44-54` — entry by kind, the four kinds
- `packages/draw-bundle/src/io/svg.ts:104-126`, `:252-313` — one `insertPath` per contour; the
  import loop over swatches, defaults and inserts
- `packages/draw-bundle/src/io/svg.ts:440-471` — both doors behind `host.supports`
- `packages/draw-geometry/src/svg-doc.ts:19-32` — the hand-rolled reader, its reason
  ("draw-geometry has zero deps and must stay host-free"), and what is out of scope

## Alternatives considered

None recorded in the repository for a scene-layer or object-type lane: `sceneLayer` does not
occur in the repo, and in the bundle's source `objectType` occurs only in two comments of
`packages/draw-bundle/src/edit-context.ts` that describe another plugin. For SVG the reader's
header rules out a DOM dependency; no XML or SVG library appears in any `package.json`.

## Consequences

Drawn shapes are engine content: undo is the engine's history, and the plugin paints nothing on
a page. The operations `host.document.mutate` accepts (the contract's `Mutation` union plus its
protocol-ahead `PendingMutation` operations, `packages/draw-bundle/src/commands/v59-wire.ts:47-53`)
are the plugin's whole vocabulary for page content, so a construct the engine cannot model is
refused or lowered to items it can model ([ADR 354](354-multi-paint-bakes-to-a-group.md),
[ADR 356](356-live-constructs-are-recipes.md)). Limits of the SVG lane, all named in the code:

- Paint is solid colour or none. Gradients and patterns as paint, `<text>`, `<image>`, `<use>`,
  `<defs>`, `<symbol>`, clip paths, masks and CSS stylesheets are not read
  (`packages/draw-geometry/src/svg-doc.ts:28-32`).
- A shape with several subpaths is imported as one path per contour, as sibling items
  (`packages/draw-bundle/src/io/svg.ts:99-103`, `:297-298`).
- The import is a sequence of separate `mutate` calls, not one batch
  (`packages/draw-bundle/src/io/svg.ts:291-313`).
- On export, a colour whose swatch name is not a CSS colour falls back: fill to `#000000`,
  stroke omitted (`packages/draw-bundle/src/io/svg.ts:37-41`).
- The importer inserts into the open document, on the active page or else the first page
  (`packages/draw-bundle/src/io/svg.ts:226-243`), rather than opening the file as a document.
  The repository does not record why.

## Related

- [ADR 316](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/316-native-content-and-baking.md) — the general rule: plugin content is valid native document content
- [ADR 310](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/310-one-write-door.md), [ADR 017](https://github.com/paged-media/plugin-sdk/blob/main/docs/adr/017-importer-exporter-door-shape.md) — the write door; the importer and exporter doors
- [ADR 013](https://github.com/paged-media/core/blob/main/docs/adr/013-in-frame-scenelayer.md) — the scene-layer lane this plugin does not use
- [ADR 352](352-basic-operations-belong-to-the-host.md), [ADR 353](353-path-algebra-runs-in-the-engine.md) — what the host and the engine own
