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

`mountPanel(component | contribution, { id, document, scene, registries })` returns `h`.
`registries` runs before the panel first renders, for a panel that reads the command,
keybinding or panel registries once (as the app's are full before a user opens a panel).

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

Shared helpers for families of panels sit in `test/panels/support/`: `structure.ts` (an IDML
built in code with what no mutation creates: conditions, a condition set, an article, a
cross-reference, index topics, a missing link), `styles.ts` and the two style-list suites,
`options.ts`, `frames.ts` (a placed image) and `cockpit.ts` (missing-link and ink-limit
documents). `settleTimers(h, ms)` in `styles.ts` waits for a panel's own debounce, which
`settle()` does not (it waits for the engine, not for timers).

### State that outlives a mount

Each mount has its own engine, client and providers, but some editor state is module scope and
is shared by the tests of one file (and of the files one worker runs): the problems store, the
journal buffer, the assistant session, the preflight findings, schema panels' local bindings and
`localStorage`. A test that depends on it resets it (`resetProblems()`, `journal.take()`,
`dismissAssistantRun()`, `localStorage.clear()`) or does not assume it starts empty.

## What every panel gets

`registry.dom.test.tsx` enumerates `BUILT_IN_PANELS` and asserts, for every entry:

- it mounts with no document, on a blank page and on the rich scene with a frame selected,
  with no render error and no request the engine could not dispatch;
- the basics of reach (`a11y.ts`): every interactive control has a role and an accessible name,
  and can be reached with Tab, itself or through its composite widget;
- the lane has a test file for it. `NOT_YET_TESTED` lists the panels without one; it only
  shrinks, and a panel that gains a file must leave it.

The reach findings are kept by the primitive that renders the control (`A11Y_KNOWN`), so one
fix in a primitive clears every panel that uses it. Each panel has a ratchet test (nothing
beyond its listed findings, and every listed finding still there); a panel with findings also
has an expected failure that flips when the panel is clean. The table is empty since the panel
kit's field naming (ADR 233): a row's label names its controls, a field with no visible label is
named after its row's title, and every built-in panel passes. A new unnamed control is fixed
with the kit (`LabelledBy`, `NamedAs`, `useFieldName`, `IconButton`), not listed.

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

## Browser-only behaviour (Playwright)

What happy-dom cannot show has one Playwright flow per panel in
`apps/canvas/tests/e2e/panels-browser.spec.ts`: a pointer drag on the Color Wheel (and Add to
Swatches as one undo step), a stop dragged along the Gradients ramp, a real HTML5 drag between
Layers rows, and Properties following a click on the canvas and writing the clicked frame. Real
layout is checked where a panel breaks at the dock's default width (1280 × 720 window): PN-358,
Layers rows whose buttons squeeze the layer name to 18 px.
They load the test kit's code-built gesture fixture, so they need no corpus. The component lane
already covers everything that does not need layout, pointer capture or the canvas.

```sh
cd apps/editor/apps/canvas
bunx playwright test tests/e2e/panels-browser.spec.ts --project=chromium
```

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

## Counts

All 89 built-in panels have their own file: 76 files in `test/panels`, 1,052 tests (on
2026-10-19), of which 79 are expected failures, each written per finding (the 42 the reach
table generated went when PN-5 to PN-16 were fixed, and PN-2, PN-4, PN-155, PN-162, PN-213 and
PN-262 are ordinary tests now), out of 99 findings named between `PN-1` and `PN-357`; the Playwright flows add PN-358. Panels that register commands while mounted (Layers, the
schema demos) and panels that run typed core commands (style lists, options panels) assert
those commands too, under `command:` ids. The commands a panel registers while mounted also
need the gate's `integration` clause, which only a browser can give them (the headless editor
mounts no panel): the Layers commands are asserted in `tests/e2e/panels-browser.spec.ts`
(New layer, each row action, Move selection here, each with one undo), the schema demos' in
`tests/e2e/schema-list-panel.spec.ts` and `schema-tree-panel.spec.ts`.

Every panel finding, with the other layers' findings, severities and shared root causes:
[conformance-findings-2026-10.md](../../../../docs/development/conformance-findings-2026-10.md).
