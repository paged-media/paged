# Testing the editor's panels

Every built-in panel (`BUILT_IN_PANELS`, `apps/canvas/src/panels/built-in-panels.tsx`) has a
component test that renders it in happy-dom over the real engine and asserts what it shows and
what each control sends. Browser-only behaviour (drag and drop, colour pickers, layout, canvas
interplay) has a Playwright flow on top. This page is the panels layer of
[surface conformance](surface-conformance.md): the gate counts a panel as covered at the
`component` layer when a `*.dom.test.tsx` file calls `covers("panel:<id>")`.

```sh
cd apps/editor && bun run test:dom     # every *.dom.test.tsx of the canvas app
cd apps/editor/apps/canvas && bun test --timeout 30000 \
  --preload ../../../../tooling/js/bun-test-setup.ts \
  --preload ./test/happydom.ts --preload ./test/vite-shim.ts test/panels/stroke-panel.dom.test.tsx
```

It needs the engine's wasm packages (`moon run core:wasm-pkg`), nothing else: no browser, no
corpus, no secrets. CI runs it in the `checks` job of `editor-tests.yml`.

## The harness

`apps/canvas/test/panels/harness.tsx` mounts one panel where the cockpit mounts it.

| Part         | What it is                                                                                                                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine       | The engine wasm, booted in the test process (`loadHeadlessEngine`), a fresh `CanvasWorker` per mount. `engine-worker.ts` gives it the shape of the editor's Worker and does what `src/worker/worker.ts` does with each message: `handleMessage` for the JSON channel, the binary load, the shaper, the resolver. Nothing renders pixels.                 |
| Client       | The real `CanvasClient` (`workerFactory: () => engineWorker`): seq matching, edit tracking, listener fan-out.                                                                                                                                                                                                                                            |
| Providers    | `ShellProviders`, PagedShell's provider stack in PagedShell's order, plus the `CockpitStateProvider` its chrome adds. `harness-parity.dom.test.tsx` fails when the two drift.                                                                                                                                                                            |
| Mount        | The panel is registered in the shell's panel registry and rendered by the shell's `PanelHost`, so it gets `{ paged, api }` and its binding scope as in the app.                                                                                                                                                                                          |
| Object model | The editor's own registry (`src/object-model.ts`), which every `PropertyField` reads and writes through. Its core seam is reset per mount (the app has one client for its lifetime; a test has one per mount).                                                                                                                                           |
| Documents    | Built in code (`fixtures.ts`): a blank page minted by the engine, then the engine's own mutations. `richScene` has text with two paragraphs, a rectangle, an oval, a group, a locked and a hidden frame, a table, swatches, a gradient, a colour group, one style of each family, a layer, a hyperlink, a bookmark, a guide, a second page in a section. |
| Vite shims   | `test/vite-shim.ts` gives app source `import.meta.glob`; Bun answers `?url` itself.                                                                                                                                                                                                                                                                      |

`mountPanel(component | contribution, { id, document, scene })` returns `h`:

| Door                                                                                      | What it does                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `h.root`, `h.view`, `h.user`                                                              | The panel's DOM, Testing Library queries scoped to it, a user-event session.                                  |
| `h.scene`                                                                                 | The ids the scene builder minted (read off the engine's replies, never assumed).                              |
| `h.select(ids)`                                                                           | What a canvas click does: the engine's element selection, then the shell's mirror with the engine's geometry. |
| `h.caret(story, offset)`, `h.selectText(story, a, b)`                                     | What a Type-tool click does: the text tool in hand and the content selection set.                             |
| `h.leaveText()`, `h.enterTable(cell)`                                                     | Back to Selection; a table cell selection.                                                                    |
| `h.mark()`, `h.sent(kind, from)`, `h.mutations(from)`                                     | The wire log: every message the client posted, in order, as the engine received it.                           |
| `h.get(address, path)`, `h.props(id)`                                                     | The engine's model, read back (`requestGet`, `requestElementProperties`).                                     |
| `h.field(path)`                                                                           | A schema-driven control's wrapper (`[data-property-field]`).                                                  |
| `h.typeInto(path, text)`, `h.choose(path, value)`, `h.press(path, option)`, `h.click(el)` | A user's input: clear, type and Enter; pick an option; click a toggle segment.                                |
| `h.mutate(m)`                                                                             | Setup through the engine (not under test).                                                                    |
| `h.spyCommand(id)`, `h.invoked(id)`                                                       | Register a command id the panel invokes and read its payloads; every invocation the registry saw.             |
| `h.settle()`, `h.act(fn)`                                                                 | Wait until no request is in flight and React has rendered.                                                    |

## What every panel gets

`registry.dom.test.tsx` enumerates `BUILT_IN_PANELS` and asserts, for every entry:

- it mounts with no document, on a blank page and on the rich scene with a frame selected,
  with no render error and no request the engine could not dispatch;
- the basics of reach (`a11y.ts`): every interactive control has a role and an accessible name,
  and can be reached with Tab, itself or through its composite widget;
- the lane has a test file for it. `NOT_YET_TESTED` lists the panels without one; it only
  shrinks, and a panel that gains a file must leave it.

The reach findings are kept by the primitive that renders the control (`A11Y_KNOWN`), so one
fix in a primitive clears every panel that uses it. Each panel with findings has a ratchet test
(nothing beyond its listed findings, and every listed finding still there) and an expected
failure that flips when the panel is clean.

## The states matrix

A panel's own file covers the states it reacts to. Not every panel reacts to every state; the
file says which apply.

| State            | How                                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| No document      | `document: "none"`                                                     |
| Empty selection  | a scene, nothing selected                                              |
| Single selection | `h.select([h.scene.rect])`, and each kind the panel treats differently |
| Multi-selection  | `h.select([a, b])`: a write is one `batch`, one undo step              |
| Mixed values     | make two items differ with `h.mutate`, then select both                |
| Locked / hidden  | `h.scene.locked`, `h.scene.hidden`                                     |
| Text editing     | `h.caret(h.scene.storyId, n)` or `h.selectText(...)`                   |
| Table            | `h.enterTable(cell)`                                                   |

## What a control test asserts

Three things, each against the real engine:

1. the exact message the control sent (`expect(h.mutations(from)).toEqual([...])`);
2. the model holding the new value (`h.get(address, path)`);
3. the panel showing it.

And its disabled state where it has one (a disabled control sends nothing).

## Findings

A test that exposes a bug is an expected failure, `test.failing("PN-<n>: <what should
happen>", …)`, asserting the right behaviour, so it fails today for that reason and passes the
day the bug is fixed (which fails the run until the `.failing` is removed). The finding ids are
`PN-<n>`, numbered across the lane. Bugs are not fixed in the same change.

## Adding a panel test

1. A file `test/panels/<panel>.dom.test.tsx` with the license header.
2. Mount the component with its registry id: `mountPanel(MyPanel, { id: "paged.my", scene: richScene })`.
3. One `describe` for the states, one for the controls; every asserting test calls
   `covers("panel:paged.my")` (and `command:…` when it asserts a command the panel invokes or
   registers).
4. Remove the id from `NOT_YET_TESTED`, then run `bun scripts/surface-coverage.mjs --prune` from
   `apps/editor`.

A new panel added to `BUILT_IN_PANELS` fails `registry.dom.test.tsx` until it has its file.
