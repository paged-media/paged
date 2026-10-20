# Testing the shell and its command layer

The editor shell (`packages/shell`) and the canvas app (`apps/canvas`) register
every command, menu item, keybinding and setting a user reaches from the menu
bar, the keyboard, the palette and the panels. This page says where each of
those is tested, at which layer, and how to add a test for a new one. The gate
that counts them is described in [surface-conformance.md](surface-conformance.md);
the tool gestures have their own page, [gestures.md](gestures.md).

## Where things are tested

| Layer                       | Where                                                                                                                                                                       | Runs with                                                                  | What it asserts                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registries (unit)           | `packages/shell/test/registries/`                                                                                                                                           | `bun run test:shell`                                                       | The command registry (ids, the `when` gate per edit context and mode, `args`, observers); the keybinding registry (combo vocabulary, dispatch rule, `precedence`, `targetOwnsKey`, the window listener); the menu registry and the menu model (`buildMenuTree`, accelerators per platform); edit-context and mode resolution (ADR 024); the palette ranking; the shell's own bindings. |
| Stores and settings         | `packages/shell/test/stores/`, `packages/shell/test/settings/`, `apps/canvas/test/unit/settings/`                                                                           | `bun run test:shell`, `bun run test:shell-dom`, `bun run test:canvas-unit` | The selection mirror, tool state, layout, document state; every setting of `scripts/settings-inventory.json`: default, storage key and reload round trip, older stored shapes, invalid stored values, the effect of a change. The storage scan fails on a storage key the inventory does not list.                                                                                     |
| Command handlers (unit)     | `apps/canvas/test/unit/commands/`, `apps/canvas/test/unit/app-commands.test.ts`, `packages/shell/test/commands/`                                                            | `bun run test:canvas-unit`, `bun run test:shell`, `bun run test:shell-dom` | Each built-in command against the test kit's fake editor: the mutation it emits, its enablement, one undo step, and what it does with no document, an empty selection and a wrong-type selection. `command-inventory.test.ts` ties the command tables to the gate's host command list.                                                                                                 |
| Keybinding tables (unit)    | `apps/canvas/test/unit/keybindings.test.ts`                                                                                                                                 | `bun run test:canvas-unit`                                                 | Every binding of the app's tables fires its command at the document root and goes quiet where its key means something else (a caret, path-edit mode, the Page tool, a drawing tool, a marquee, an edit context, a focused field); Cmd/Ctrl twins.                                                                                                                                      |
| The mounted shell           | `apps/canvas/test/shell/` (PagedShell over the real engine in happy-dom), `packages/shell/test/bundles/` (the worker-bundle loader with the sample bundle in a real Worker) | `bun run test:dom`, `bun run test:shell`                                   | The commands PagedShell registers over its own state (the chrome toggles: which chrome is mounted after each); the loader's activate / register / ready handshake, the invoke round trip, a key binding dispatched to a worker command, dispose.                                                                                                                                       |
| Commands on the real engine | `apps/canvas/tests/headless/commands-*.test.ts`                                                                                                                             | `bun run test:headless`                                                    | The document commands through the real registry against the headless engine (`createHeadlessEditor`): the model after, undo restoring it, the empty and wrong-type cases.                                                                                                                                                                                                              |
| Browser                     | `apps/canvas/tests/e2e/shell-*.spec.ts`, harness `tests/e2e/harness/shell-surface.ts`                                                                                       | Playwright (below)                                                         | The menu enablement matrix and menu dispatch, keybinding dispatch, the derived families member by member, the commands whose effect is the browser (camera, chrome, dialogs, downloads, file pickers, new tabs), and the browser-only findings.                                                                                                                                        |

The browser specs:

- `shell-menu-matrix.spec.ts`: the host menu inventory, then per edit context (no
  document, a document, a frame, a group, two items, a text frame, a caret, inside
  the draw bundle's `vectorGraphic` frame) and per workflow mode: every rendered row
  is enabled exactly when the registry's `when` holds for the live editor, plus the
  product rules (insert needs a document, object verbs refuse inside a frame, a seam
  never enables). Then every enabled row is clicked and must run exactly its command.
  The families `menu:Window/*` and `menu:Plugins/*` are walked member by member.
- `shell-keybindings.spec.ts`: the host keybinding inventory; every binding pressed on
  the page runs its command; the guarded keys stay text with a caret; a focused field
  keeps its keys; every live tool shortcut (`keybinding:*→paged.tool.activate.*`)
  arms its tool at the root or inside the context that claims it.
- `shell-commands.spec.ts`: zoom, the View extras, the preview screen mode, the chrome
  toggles, the palette, Save, Save As IDML, Open PDF, Export PDF, the Help links,
  Ask Claude, Global light, actions record/stop/play, fill and stroke; and the command
  families `paged.panel.show.*`, `paged.panel.hide.*`, `paged.tool.activate.*` over
  every live panel and tool.
- `shell-findings.spec.ts`: the browser-only expected failures, each next to a control.

### How the browser specs see the editor

- **The live registries.** `window.__canvas.registries` (dev builds) holds every
  registry. The `when` of a menu item is evaluated against the same `PagedEditor`
  the menu bar uses, fetched through a probe command (a command handler receives
  the editor). `liveMenu()` and `liveKeybindings()` in the harness do this.
- **The menu bar.** `readMenuBar()` opens each menu and walks its submenus with the
  keyboard (a pointer crossing rows opens their submenus on the way); `menuRow()`
  walks to one row, reads `data-disabled` and clicks it. Menus are closed by a press
  outside them, never by Escape, which an active edit context would also take.
- **The command recorder.** `recordCommands()` replaces the handlers of a set of
  commands with a recorder, keeping their `when` and `args`, so a click or a key
  press is asserted by the command it ran, without a file picker or a download
  getting in the way. `restore()` puts the real handlers back. Tests of what a
  handler DOES use the real handler (`shell-commands.spec.ts`).
- **Fixtures in code.** `shellFixture()` builds the matrix document with the test
  kit's IDML builder (a frame, a group, a closed polygon, a text frame with a story,
  a second page). The editor's Playwright lane in CI cannot check out the private
  corpus, so nothing here reads it.

### Running the browser specs

```sh
cd apps/editor/apps/canvas
# once: bun install at the root, moon run core:wasm-pkg, the module wasm
# (moon run doc:wasm, slide:wasm, sheet:wasm, data:wasm, web:wasm)
bunx playwright test tests/e2e/shell-menu-matrix.spec.ts --project=chromium
```

`IDML_CANVAS_TEST_PORT=<port>` points Playwright at a dev server already running
on that port (outside CI it reuses one). Each spec boots the editor per test; the
whole set takes a few minutes.

## Adding a test

Every test that asserts a surface id calls `covers(...)` from `@paged-media/test-kit`
in its body, with string literals (rules: [surface-conformance.md](surface-conformance.md)).
After covering ids, run `bun scripts/surface-coverage.mjs --prune` from `apps/editor`
and commit the pruned acknowledged files.

**A command.** The gate wants a `unit` and an `integration` test.

1. Unit: put the handler's logic where it can be driven without React (the
   `build*Commands(deps)` pattern) and test it in `apps/canvas/test/unit/commands/`
   (canvas commands) or `packages/shell/test/commands/` (shell commands) against
   `createFakeShellEditor()` or the deps the runner takes. Assert the mutation, the
   `when` per context, one undo step, and the no-document, empty-selection and
   wrong-type cases. Tag it `covers("command:<id>")`.
2. Integration: a document command goes in `tests/headless/commands-*.test.ts`
   (`createHeadlessEditor`, `ed.invoke`, `ed.dump`, undo); a command whose effect is
   the browser goes in `tests/e2e/shell-commands.spec.ts`.
3. If the command is registered in a new table or a new inline site,
   `command-inventory.test.ts` fails until it is added there.

**A menu item.** The gate wants `e2e`. Add its path to `HOST_MENU` in
`shell-menu-matrix.spec.ts` and to each `covers(...)` list there; the inventory test
fails until you do. If the item has a product rule (needs a document, refuses inside a
frame), add it to the rules block of the matrix test. The menu model itself (where an
item lands, its group and order) is a unit test in `packages/shell/test/registries/menu.test.ts`.

**A keybinding.** The gate wants any layer. Add `<key>→<command>` to `HOST_KEYS` in
`shell-keybindings.spec.ts` (the inventory fails until you do) and to its dispatch
`covers(...)`. A binding of the app's tables also gets its context cases in
`apps/canvas/test/unit/keybindings.test.ts`; a binding the shell registers, in
`packages/shell/test/registries/shell-keybindings.test.ts`. Register Cmd and Ctrl
twins: the registry has no `mod` token.

**A setting.** The gate wants `unit` or `component`. Add it to
`scripts/settings-inventory.json` (the storage scan fails until you do), then test
its default, round trip, older shapes, invalid values and effect in
`packages/shell/test/settings/` or `apps/canvas/test/unit/settings/`, tagged
`covers("setting:<id>")`.

## Findings

A test that exposes a product bug is an expected failure (`test.failing` in bun,
`test.fail()` in Playwright) named with its finding id, and fails for the finding's
reason. The shell's findings (`SH-*`), with the UX audit
([ux-audit-2026-10.md](../design/ux-audit-2026-10.md)) id where there is one:

| Id               | Surface                                                                                                                        | Test                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| SH-1             | **Fixed 2026-10-20 (`a6274341f`).** Help ▸ Report an issue opens the frozen repository's tracker                               | `apps/canvas/test/unit/app-commands.test.ts`                                                            |
| SH-2 (F-49)      | Fixed (ADR 234): Tab toggled the chrome inside a dialog                                                                        | `packages/shell/test/registries/keybinding.test.ts`, `tests/e2e/shell-findings.spec.ts`                 |
| SH-3 (F-36)      | Fixed (ADR 234): a composition key fired a binding; IME and Option text were lost                                              | `packages/shell/test/registries/keybinding.test.ts`, `tests/e2e/shell-findings.spec.ts`                 |
| SH-4             | **Fixed 2026-10-20 (`a6274341f`, editor ADR 255).** The View toggles show no checked state                                     | `tests/e2e/shell-menu-matrix.spec.ts`                                                                   |
| SH-5             | **Fixed 2026-10-20 (`426912f45`).** A Cmd-only binding is shown as Ctrl+X on Windows and Linux                                 | `packages/shell/test/registries/menu.test.ts`                                                           |
| SH-6             | **Fixed 2026-10-20 (`a6274341f`).** A panel two contexts claim is hidden inside the second                                     | `packages/shell/test/registries/edit-context.test.ts`                                                   |
| SH-7             | **Fixed 2026-10-20 (`a6274341f`).** Palette: titles that open with the query tie at the score cap                              | `packages/shell/test/registries/palette-score.test.ts`                                                  |
| SH-8 (F-14)      | **Fixed 2026-10-19 (`b5cc7328a`, editor ADR 249).** Object verbs are enabled with nothing selected                             | `tests/e2e/shell-menu-matrix.spec.ts`                                                                   |
| SH-9 (F-16)      | **Fixed 2026-10-19 (`907b1b153`, editor ADR 246).** Cmd+0 and Cmd+1 are not registry bindings                                  | `apps/canvas/test/unit/keybindings.test.ts`                                                             |
| SH-10 (F-01)     | A dropped file replaces an edited document without asking                                                                      | `tests/e2e/shell-findings.spec.ts`                                                                      |
| SH-11            | Fixed (ADR 234): with a caret, an open menu's arrows moved the caret                                                           | `tests/e2e/shell-findings.spec.ts`                                                                      |
| SH-12            | Fixed (ADR 234): Enter that chose a menu item also entered path-edit mode                                                      | `tests/e2e/shell-findings.spec.ts`                                                                      |
| SH-13            | **Fixed 2026-10-20 (`a6274341f`).** The sample bundle's manifest declares a menu path its kernel registers with other capitals | `packages/shell/test/bundles/sample-bundle.test.ts`                                                     |
| SH-101 to SH-106 | **Fixed 2026-10-19 (`907b1b153`, editor ADR 247, 248).** Settings and stores                                                   | `packages/shell/test/settings/`, `packages/shell/test/stores/`, `apps/canvas/test/unit/settings/`       |
| SH-201 (F-28)    | No Cut, Copy, Paste or Duplicate for page items                                                                                | `apps/canvas/test/unit/commands/edit-commands.test.ts`, `tests/e2e/shell-findings.spec.ts`              |
| SH-202 to SH-205 | Fixed (`653f6314d`, `89219f88e`): Command undo granularity and fidelity                                                        | `apps/canvas/test/unit/commands/`, `tests/headless/commands-*.test.ts`, `packages/shell/test/commands/` |
| WRK-1            | Fixed (`ef8c262bd`): A binary load whose dispatch throws is reported with no seq (the real render worker)                      | `tests/worker-boot.spec.ts`                                                                             |
| WRK-2            | Fixed (`ef8c262bd`): The client settles no load on a `dispatchError`, even with its seq                                        | `apps/canvas/test/unit/client/load-dispatch-error.test.ts`                                              |

Every finding of every layer, with severities, shared root causes and fix waves:
[conformance-findings-2026-10.md](../../../../docs/development/conformance-findings-2026-10.md).
