# Testing paged.draw

Every contribution in `packages/draw-bundle/manifest.json` (107 commands, 21 tools, 10
panels, the SVG importer and exporter) and the 17 tool options are tested through the
code the editor runs: the command a menu dispatches, the gesture handler a tool mounts,
the panel component the bundle contributes. Each asserting test marks the surface ids it
vouches for with `covers()` (the surface-conformance gate,
`apps/editor/docs/reference/surface-conformance.md`); the gate takes the layer from the
file's path.

| Layer          | Files                                                        | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit, commands | `test/commands/*.spec.ts` over `test/commands/unit-kit.ts`   | The real bundle activated through the real host adapter over a fake document (no engine). For every command: the mutations it sends for the selection, as how many undo steps; what it does to its record's library part and to the selection; that it sends nothing, and logs why, where it does not apply; a "…" command raises Path Options at its section.                                                                                                                |
| unit, gestures | `test/tool-gestures.spec.ts`                                 | Every tool through the gesture DSL over the same fake document: what the gesture commits, as one undo step that one undo takes back (INV-1, INV-4), and that Escape mid-gesture commits nothing (INV-2). `test/gestures.spec.ts` keeps the battery every tool passes.                                                                                                                                                                                                         |
| unit, settings | `test/tool-options.spec.ts`                                  | Every tool option: the value in the host's tool-settings store reaches what the tool sends, and the default is the tool as it shipped.                                                                                                                                                                                                                                                                                                                                        |
| component      | `test/panels/*.dom.test.tsx` (`bun run test:dom`, happy-dom) | Every panel mounted against the real engine: what it shows for the selection and the document, and that its buttons change the document. The Draw settings schema panel is mounted through a minimal renderer over its contributed schema and published lists.                                                                                                                                                                                                                |
| headless       | `test/headless/`                                             | The real engine wasm, booted headlessly (`createHeadlessHost`). `commands-*.spec.ts` holds every command to one contract (`command-kit.ts`): it changes the model as ONE undo step that undoes and redoes exactly, it leaves the model byte-identical where it does not apply, and a library command writes its part and nothing else. The other specs assert each feature's geometry, metadata and undo shape. `svg-io.spec.ts` drives the registered importer and exporter. |

## Expected failures

The findings the command contract found are committed as `it.failing` tests named with
their id, each rethrowing only the invariant it breaks (`brokenInvariant` in
`command-kit.ts`), so a fix turns them red and asks for the flip:

- DRW-1: the gradient fill presets take four undo steps.
- DRW-2: a live-corner preset takes two (the geometry batch, then the marker).
- DRW-3: dash presets, Outline stroke, Offset path, Simplify, Close path and a style
  redefine commit one undo step per selected (or linked) element.
- DRW-4: Add fill, Add stroke and Move layer take two (the stack, then its paint).
- DRW-5: a bake takes two ([ADR 354](adr/354-multi-paint-bakes-to-a-group.md) names the
  cost).
- DRW-6: Image Trace takes two (the module header states it).

## Running them

```sh
cd packages/draw-bundle
bun run test        # unit + headless
bun run test:dom    # the panels, with happy-dom
```

Image Trace needs `packages/draw-bundle/wasm/` (`moon run draw:wasm`); its headless and
unit tests decode the fixture PNG through `test/headless/raster-realm.ts`, because Bun has
no `createImageBitmap`.
