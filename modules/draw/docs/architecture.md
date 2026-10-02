# Architecture

How the `paged.draw` plugin is built: vector drawing tools, path operations and appearance
features for the paged editor. It describes what the code does at commit `0d12bf8`. The
reason behind each choice is in an ADR under [`adr/`](adr/README.md), linked where it
applies. A bare file name is in `packages/draw-bundle/src/` unless another package is named.

## Packages and crates

The repo is two workspaces at one root: a pnpm workspace (`packages/*`, TypeScript) and a
Cargo workspace (`crates/draw-trace`, `crates/trace-js`, Rust pinned to 1.93.0 with the
`wasm32-unknown-unknown` target in `rust-toolchain.toml`).

**`packages/draw-geometry`** — private, no dependencies, no import other than relative
ones. Pure path math over one vocabulary, `AnchorTriple` (anchor plus two handles) and
`AnchorTable` (anchors plus contour boundaries): polyline simplification, Bézier split and
closest-point, handle derivation, a smooth fit through points, affine helpers, arc-length
placement (`along-path.ts`), repeat placement (`repeat.ts`), blend interpolation, brush and
width profiles, parametric shapes, contour re-winding for compound paths (`compound.ts`),
and an SVG reader and writer with its own XML scanner (`svg-doc.ts`, `svg-path.ts`,
`svg-arc.ts`, `svg-shapes.ts`, `svg-color.ts`).

**`packages/draw-tools`** — private. Eleven tool modules that take page-local points and
return snapshots, plans or commits: anchor editing, pen, pencil, curvature, brush, width,
measure, shape builder, live paint, corner radius, repeat. It imports `draw-geometry` and,
as types only, `@paged-media/plugin-api`. `wire-compat.ts` holds compile-time assertions
that the machines' output is assignable to the engine's wire types, so a protocol change
that breaks them fails `pnpm typecheck` here.

**`packages/draw-bundle`** — published to npm as `@paged-media/draw` (`dist`, `wasm`,
`manifest.json`). The only package that touches a host. It holds `activate(host)`
(`activate.ts`), the tool catalogue (`tools.ts`), the gesture handlers
(`handlers/`), the command modules (`commands/`), ten panels (`panels/`), the SVG importer
and exporter (`io/svg.ts`), the menu entries (`menu.ts`), the edit context
(`edit-context.ts`), a binding provider for the host's Layers panel (`binding-provider/`)
and the loader for the trace wasm (`trace-engine.ts`).

**`crates/draw-trace`** — the image-trace kernel: RGBA pixels in, regions of cubic contours
out, over the `visioncortex` crate. No wasm-bindgen dependency.

**`crates/trace-js`** — the wasm-bindgen surface over `draw-trace`: three exported functions,
`traceInit`, `traceLimits` and `traceRgba`, with options and results as JSON strings.

```
 draw-geometry     imports nothing
      ^
 draw-tools        + @paged-media/plugin-api (types only)
      ^
 draw-bundle       + draw-geometry, @paged-media/plugin-api, @paged-media/plugin-sdk, react
      | imports at run time
      v
 packages/draw-bundle/wasm/  <== scripts/build-wasm.sh ==  crates/trace-js --> crates/draw-trace
```

- tsup inlines the two private packages into the published one (`noExternal`), with two
  entry points: the bundle, and `./geometry`, a re-export of `draw-geometry`
  (`geometry.ts`). The editor imports both: the bundle in `editor: apps/canvas/src/main.tsx`
  and the geometry in its built-in Pen and Pencil (`editor: packages/tools/src/handlers/`).
  `draw-tools` has no entry point of its own.
- `@paged-media/plugin-api`, `@paged-media/plugin-sdk` and `react` are peer dependencies of the
  published package. `scripts/check-contract-imports.mjs` runs before the tests and fails on any
  static `import … from` or `export … from` that is not one of those three, a package of this repo,
  or relative. It does not check dynamic `import()` (three `node:` modules in `trace-engine.ts`).
- The built wasm is committed in `packages/draw-bundle/wasm/`. That directory is both the
  path the manifest declares (`wasm/trace_js_bg.wasm`) and the path `trace-engine.ts`
  imports, so there is one copy.

See [ADR 350](adr/350-three-typescript-layers.md) for the three TypeScript layers and
[ADR 357](adr/357-image-trace-rust-lane.md) for the Rust half.

## What activation registers

`manifest.json` (id `media.paged.draw`) declares 19 tools, 10 panels, 92 commands, one
importer, one exporter, seven container part types, one edit context and one wasm module.
`activate(host)` registers them through the host's contribution doors and returns a handle
whose `dispose()` drops the bundle's command groups, binding subscriptions, menu entries,
SVG doors and Layers provider.

- **Tools.** Each entry in `tools.ts` is data (id, title, icon, shortcut, rail group) plus a
  factory returning a gesture handler closed over `host`.
- **Panels.** Stroke and Fill are schema panels: pure data, with sections shown or enabled
  by booleans the bundle computes and publishes through `host.bindings.publish`. The other
  eight are React components (Appearance, Graphic Styles, Symbols, Live Paint, Pattern,
  Repeat, Blend, Objects on Path).
- **Edit context.** `vectorGraphic` is entered by double-click on a polygon, graphic line,
  rectangle or text frame. It names the three anchor tools as its tool set and the Stroke
  panel as its panel set. While it is active, a binding provider answers the host's Layers
  panel with the entered object and its siblings instead of the document's layers; with more
  than 200 siblings it declines, and the panel shows the document's layers.
- **Menu.** 72 of the commands get a menu path (`menu.ts`), under a Draw menu and inside
  the host's Object and Edit menus.

The bundle contributes no Pen tool, no Group or Ungroup command and no Layers panel; those
are the host's. See [ADR 352](adr/352-basic-operations-belong-to-the-host.md).

## Data paths

**A tool gesture.** The host delivers pointer events to the active tool's handler. For the
anchor tools (`handlers/anchors.ts`) the handler hit-tests the click, reads the element's
anchor table with `host.document.pathAnchors`, maps the point into the path's own space,
and asks a planner in `draw-tools` for a plan. `mutationFor` turns the plan into engine
operations (`pathPointSet`, `pathPointInsert`, `pathPointRemove`, `pathPointCurveType`),
and the handler sends them through `host.document.mutate`. Curvature and Pencil feed
events to a machine, show its preview with `host.overlay.setToolPreview`, and commit an
`insertPath` (`handlers/insert-path.ts`). Everything the plugin draws into the document is
an ordinary page item: the manifest's rendering capabilities are `overlay` and `hitTest`
only. See [ADR 351](adr/351-shapes-are-native-page-items.md).

**Path operations.** Outline stroke, offset, simplify, join, close, the four boolean and
the six region pathfinder commands each send an engine operation; the bundle builds it and
reports a refusal. The brushes compose the same operations: insert a centreline, outline
it, and for Blob Brush and Eraser unite it with or subtract it from the selection. The
Width tool applies a variable-width outline to an existing open path. The Shape Builder and
Live Paint tools read the planar arrangement of the inputs through
`host.document.planarRegions`; `handlers/planar-regions.ts` is the one place that calls it,
caches the answer per gesture, and maps between page space and the raw path space the
engine works in. TypeScript geometry is used for what a gesture needs synchronously and for
re-winding nested contours so that the engine's non-zero fill cuts holes. See
[ADR 353](adr/353-path-algebra-runs-in-the-engine.md).

**Appearance.** Extra fills and strokes are a stack in the element's metadata; the front
fill and stroke are written to the frame's own paint. "Bake" lowers the stack to a group:
the source frame stays as the carrier of the metadata, with its own paint cleared, and one
path per paint is inserted (fills, then strokes) and grouped with it. "Release" is the
inverse. See [ADR 354](adr/354-multi-paint-bakes-to-a-group.md).

**Recipes.** Graphic styles, symbols, live paint, pattern fields, repeats, blends and
objects on a path have no object in the engine. Each is a recipe stored with the document
plus ordinary page items stamped with a link to it. The result changes when a command
(Update, Regenerate, Redefine) rebuilds it, not when a source is edited. Objects on a Path
is the exception in kind: it inserts nothing and writes one `frameTransform` per selected
object. See [ADR 356](adr/356-live-constructs-are-recipes.md).

**Image trace.** `commands/image-trace.ts` fetches the placed image's original bytes with
`host.assets.getPlacedImage`, decodes them with the browser's `createImageBitmap` and
`OffscreenCanvas` (`io/raster-decode.ts`), downsamples to at most 1,048,576 pixels by
default, and calls `traceRgba` synchronously on the calling thread. The kernel refuses
rasters above 4096 px on a side or 4,194,304 pixels. Each region's contours are merged and
re-wound by `makeCompoundTable` in `draw-geometry`. Two mutations follow: one creates the
colour swatches and inserts every contour, the second merges contours, deletes the
surplus, sets fills, stamps a record on the image frame and groups the result.

**SVG.** The importer parses the file with the reader in `draw-geometry` and inserts one
path per contour into the open document. Solid colours become swatches and reach each new
path through the document's creation defaults, which the importer sets before an insert
and restores at the end. The exporter serialises the selected elements' anchors and solid
colours.

## Where data is stored

- **Page items.** Paths, groups and swatches the plugin creates are native document content.
- **Element metadata.** Plugin state on an element is one envelope, `{ v, data, engine? }`,
  under the key `x-paged:media.paged.draw`. Features share it by key inside `data`
  (`appearance`, `appearanceBake`, `graphicStyle`, `symbolInstance`, `livePaintMember`,
  `patternTile`, `repeatInstance`, `opacityMask`, `textOnPath`, `imageTrace` and others),
  and every writer merges into the existing envelope. When the envelope must change in the
  same undo step as the paint it describes, the bundle puts a raw `setPluginMetadata`
  operation into its own batch (`stampDrawMetadata` in `commands/appearance-bake.ts`)
  instead of calling `host.document.setMetadata`.
- **Container parts.** Seven JSON files in the plugin's part namespace of the `.paged`
  container, read and written through `host.parts`: `graphic-styles.json`, `symbols.json`,
  `live-paint.json`, `pattern.json`, `repeat.json`, `blend.json` and
  `objects-on-path.json`. Part writes are not on the engine's undo stack. See
  [ADR 355](adr/355-libraries-in-container-parts.md).

The bundle uses neither `host.storage` nor browser storage, and the manifest declares
`network: false`. The one request it causes is for its own file: in a browser the generated
wasm glue fetches `wasm/trace_js_bg.wasm` by URL.

## Host doors

| Door | What the plugin uses it for |
|---|---|
| `contributeTool`, `contributeSchemaPanel`, `contributeEditContext` (plugin-sdk) | tools with their activation commands and shortcuts; the Stroke and Fill panels; the `vectorGraphic` context |
| `host.contribute.command`, `.panel`, `.menu`, `.importer`, `.exporter`, `.bindingProvider` | commands, React panels, menu entries, SVG in and out, the Layers provider |
| `host.document.mutate` | every document change |
| `host.document.pathAnchors`, `elementGeometry`, `elementProperties`, `tree`, `hitTest`, `collection`, `meta`, `frameChain` | reads: anchors, bounds and transforms, typed properties, the scene tree, hit tests, pages, swatches and stories, the active page and creation defaults |
| `host.document.planarRegions` | the faces of overlapping paths, for Shape Builder and Live Paint |
| `host.document.getMetadata` / `setMetadata`, `host.parts.read` / `write` | the metadata envelope and the container parts |
| `host.document.onDidChange`, `host.selection.get` / `set` / `onDidChange` | panels and bindings follow the selection and the document |
| `host.overlay.setToolPreview`, `host.viewport.pxToPt` | tool previews (one shape at a time); screen-constant pick tolerances |
| `host.bindings.publish` | panel gates, the measure readout, status and refusal messages |
| `host.assets.getPlacedImage` | the bytes of a placed image, for the trace |
| `host.supports`, `host.log` | probing optional doors; logging |

One call bypasses these doors: the Measure tool's snap to the nearest path point sends the
raw request `requestNearestPathPoint` through `host.editor.client.send` (`handlers/measure.ts`).

The bundle does not read a protocol number. Optional doors are probed with `host.supports`
(`storage.parts@1`, `assets.images@1`, `bindings.provider@1`, `contribute.importer@1`,
`contribute.exporter@1`, `overlay.text@1`). Engine operations are detected by sending one
deliberately unknown operation and reading the list of known operations from the error
(`engineOpVocabulary` in `commands/join-average.ts`); Join and Shape Builder fall back to
older operations when the newer ones are missing. Operations that the contract types as
`PendingMutation` are built in three modules: `commands/v58-wire.ts`,
`commands/v59-wire.ts` and `binding-provider/adr023-seam.ts`. `commands/pathfinder-region.ts`
and `commands/join-average.ts` still cast their operations to `Mutation`.

## Build and test

- The root `build` script is the typecheck. `pnpm -r build` runs tsup in each package; only
  `draw-bundle` is published. `.github/workflows/publish.yml` runs typecheck and build on
  every push to `main` and publishes `@paged-media/draw` under the `canary` tag when the
  version is not yet on npm.
- `scripts/build-wasm.sh` builds `trace-js` in release mode, checks that the installed
  `wasm-bindgen` CLI matches `Cargo.lock`, runs `wasm-bindgen --target web` and, if
  present, `wasm-opt -Oz`, and writes `packages/draw-bundle/wasm/`. It is needed only when
  `crates/` changes. The manifest caps the module at 2,097,152 bytes; the script's own size
  check is set to 100,000,000 bytes. The committed module is 173,402 bytes.
- `pnpm test` runs the import lint, then vitest in the three packages. `draw-geometry` and
  `draw-tools` are unit tests. In `draw-bundle`, `test/conformance/` holds 42 spec files; 40 of them
  boot the published engine wasm in Node with `createHeadlessHost` from `@paged-media/plugin-sdk`
  and drive the bundle through its real document door; `@paged-media/canvas-wasm` is a devDependency
  for that purpose. The specs call the same exported builder functions the live code calls.
  `test/activate.spec.ts` checks registration over a fake editor. `test/real-vector-corpus.spec.ts`
  is opt-in (`PAGED_SVG_CORPUS=1`) and needs files that are not in this repository.
- `cargo test --workspace` runs the Rust tests. `.github/workflows/rust.yml` runs format,
  clippy for native and wasm32, the tests, a fresh wasm build and a manifest validation.
- `.github/workflows/vitest.yml` runs vitest on pushes to `main` and uploads the results;
  the vitest command is followed by `|| true`, so a failing test does not fail the job.
