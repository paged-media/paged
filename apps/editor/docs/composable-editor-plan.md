# The composable editor — Implementation plan

October 2026. Companion to [`composable-editor.md`](composable-editor.md) (the concept, cited
here as "the concept, §n"). This plan says **what is built, where, in which order, and how
each step is proven**. When code lands, ADRs record the decisions and [`status.md`](status.md)
records what ships. This plan is then amended or retired; it never overrides either.

Paths are relative to the repository root. Line numbers are as of the plan's date and serve as
orientation only.

---

## 0. How to read this plan

- **Workstreams** (§4–§9) group the work by where it lives: shell composition (A), features
  (B), engine policy (C), filling UI (D), embedding (E), authoring and headless (F).
- **Tasks** inside a workstream have ids (`A3`, `C5`, …). Each task names its goal, the files
  it touches, the steps, its tests and its exit condition. A task is one or a few commits, each
  green on its own gates.
- **Milestones** (§10) cut across workstreams. Each one gives an embedder something usable.
- **§2 lists facts in the code that the concept did not account for.** The tasks are built
  around them. Read §2 before any task.

## 0a. Progress (2026-10-23)

| Task                                             | State                                                                                                                                   | Where                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A1–A6 profiles, regions, presets                 | Done                                                                                                                                    | ADR 274, `packages/shell/src/profile/`, `apps/canvas/src/profiles/`                 |
| B1–B3 features                                   | Done                                                                                                                                    | ADR 275, `apps/canvas/feature-ids.json`                                             |
| C1–C8, C11 engine policy                         | Done                                                                                                                                    | engine ADRs 1000, 1001 (protocol 75)                                                |
| C9, C10 XML tags ↔ fields, F5 open as template   | Done (protocol 76): tagged ranges become placeholder runs; paged writes XML tags; File ▸ Open as template; `paged-node template ingest` | engine ADR 1002, `paged-template/src/derive.rs`, `idml-export/src/xml_structure.rs` |
| D1–D5 filling in the editor                      | Done                                                                                                                                    | ADR 276, `panels/template/`                                                         |
| E2, E3, E5 host actions, handle, host components | Done                                                                                                                                    | `apps/canvas/src/embed/create-editor.ts`                                            |
| E4 theme and strings                             | Done                                                                                                                                    | `setTheme`, `docs/theme-tokens.json`, `platform/shared/strings`                     |
| E6 iframe bridge                                 | Done; scripts run over it too (`runScript`), the old `paged:run` bridge stays for the docs playground                                   | `embed.html`, `src/embed/{bridge,connect}.ts`                                       |
| E7 example host                                  | Done as the demo pages                                                                                                                  | `apps/canvas/demos/`                                                                |
| E10 the whole editor in strings                  | Done: 5,036 messages, German shipped; extensions through `host.strings`                                                                 | extensions ADR 333, strings guard in CI                                             |
| E1 instance safety                               | Done: two editors on a page, scoped styles, root-held keys and portals, a storage adapter                                               | ADR 277, `scripts/instance-guard.mjs`                                               |
| E8 the npm package                               | Done; first publish needs the npm trusted publisher (a user action)                                                                     | `apps/editor/packages/editor`, PM-0013                                              |
| E9 embedding docs                                | Done                                                                                                                                    | docs site PR                                                                        |
| F1, F2 Template panel, preview as filler         | Done                                                                                                                                    | `panels/template/template-panel.tsx`                                                |
| F6 the CLI                                       | Done: `paged-node template fields, kinds, fill, check, ingest` and `paged template fields, fill, check`                                 | `apps/cli/src/template.ts`, `paged-cli/src/template.rs`                             |
| F7 server rendering                              | Done                                                                                                                                    | `engine-serve` `POST /run` `template`                                               |
| F8 catalogues                                    | Done                                                                                                                                    | data ADR 560                                                                        |
| F3 preflight, F4 author overlay                  | Done: the `templateFindings` collection, the Template panel's Problems, markers on the author's field outlines                          | `paged-template/src/preflight.rs`                                                   |
| G1, G2 module field kinds, routing               | Done                                                                                                                                    | extensions ADR 335, engine ADR 1000 amendment                                       |
| G3 field kinds of every module                   | Done, `pdf.page` included (a placed PDF shows the page the document names, engine ADR 1003)                                             | each module's `template-fields.ts`                                                  |
| G4 coverage gaps                                 | Largely done: CLI imports and bytes, typed commands per module; open items listed in G4                                                 |                                                                                     |
| H demos                                          | Done: gallery of ten pages, journeys                                                                                                    | `apps/canvas/demos/`                                                                |
| I docs and website                               | PRs open                                                                                                                                | docs site, website                                                                  |

Corrections to the plan found while building:

- An iframe does not free the host page from cross-origin isolation: a frame is isolated only
  when its top page is. The host page sends COOP `same-origin` and COEP `credentialless`, and the
  frame is allowed `cross-origin-isolated` (E6).
- The strings package lives in `platform/shared/strings`, not under `apps/editor/packages`, so
  the built-in modules can use it (PM-0002); third-party extensions reach it through
  `host.strings`.
- Engine follow-ups found by the module work, and what became of them: a module's document-
  and page-level label now opens to a filler when a field of that module is open, and a story
  on a path is decided by the item that carries the path (engine ADR 1000, amendment of
  2026-10-23); a placed PDF still always draws its first page.

## 1. Summary

| Workstream             | Concept  | Where                                                                                   | Depends on       |
| ---------------------- | -------- | --------------------------------------------------------------------------------------- | ---------------- |
| A Composition          | §5       | `apps/editor/packages/shell`, `apps/editor/apps/canvas`                                 | —                |
| B Features             | §6       | `apps/editor/packages/shell`, `platform/shared/test-kit`, `apps/editor/scripts/surface` | A1               |
| C Engine policy        | §7.1–7.8 | `engine/core/crates/*` (new `paged-template`), `apps/editor/packages/client`            | —                |
| D Filling              | §7.10    | `apps/editor/apps/canvas`, `apps/editor/packages/shell`                                 | A, B, C          |
| E Embedding            | §8       | new `apps/editor/packages/editor`, `apps/editor/apps/canvas`, `tooling/release`         | A, B; D for fill |
| F Authoring + headless | §7.9, §9 | `apps/editor/apps/canvas`, `engine/core/crates/paged-cli`, `apps/cli`, `modules/data`   | C; D for preview |

```
 A1 ─► A2 ─► A3 ─► A4 ─► A5 ─► A6 ───────────────┐
  │                                              ├─► D ─► M3 ─► E (fill) ─► M5
  └──► B1 ─► B2 ─► B3 ───────────────────────────┤
 C1 ─► C2 ─► C3 ─► C4 ─► C5 ─► C6 ─► C7 ─► C8 ───┤
                    └─► C9 ─► C10 (XML writer)   │
                                    └─► F6 (CLI) ┘      E1 (instance safety) runs beside A–D
                                                        E4 ─► E10 (strings) runs beside D–E
                                                        F1–F5 after D
```

The critical path is **C (engine policy) and A (regions) into D (filling)**. E1, the
instance-safety refactor, is the largest single risk. It runs early and in parallel, because
`createEditor` cannot ship without it.

## 2. Facts in the code that shape the plan

Collected while planning; each changes a task. The concept has been corrected where it
assumed otherwise.

**Shell and app.**

1. **The app cannot mount twice or into a host element.** `apps/editor/apps/canvas/src/main.tsx`
   mounts on `#root` and has module-scope effects:
   - trusted types and the global CSS (Tailwind base, `body` styles);
   - singletons: `documentIdentity`, `editorConsent`, `editorDocuments`, `editorSecrets`,
     `bindingProviders`, `willSave`, `liveActivator`, the library worker;
   - global handles: `__paged`, `__canvas` and others;
   - `window` keydown listeners: the keybinding registry, `canvas-panel.tsx`.

   The shell has more module singletons: `CommandPalette`, `ExportPdfDialog`,
   `CanvasContextMenu`, `open-file-handle`, `document-source`, `view-toggles`, `replace-guard`,
   `chrome-storage-scope`. ThemeProvider writes `.dark` on `<html>`, the tokens sit on `:root`,
   and Radix popovers portal to `document.body`.

2. **Regions are not optional.** `PagedShell.tsx` always renders `Header` (with `MenuBar`),
   the edit-context breadcrumb, `CommandPalette`, `ExportPdfDialog` and `ReplaceDocumentPrompt`.
   `CockpitLayout.tsx` always renders `DocTitleBar` and `RightDock`. Only `railHidden` and
   `panelsHidden`, which are internal state, hide anything.
3. **`WorkflowMode` is a closed union** of six ids (`state/workflow-mode-context.tsx`). Solo
   reuses `design` for that reason.
4. **Menu filtering happens only at registration**, and only for host menus. Plugin menus are
   not filtered. Solo relies on loading only one bundle.
5. **Gating has one evaluator but several call sites.**
   - `isEnabled` (`registries/types.ts:92`) is called from `entryApplies`,
     `CommandRegistry.invoke`, keybinding `resolveParsed` and the palette's
     `applicableCommands`.
   - The canvas context menu uses its own `holds()`.
   - `OverlayHost` ignores an overlay's `when`.
   - ToolRail, PanelRail, RightDock, PanelHost and MenuBar filter lists themselves.
6. **The solo guard parses TypeScript with regular expressions**
   (`apps/editor/scripts/solo-profiles-guard.mjs`), so it breaks once profiles are data.
7. **Hit testing knows no "selectable"**: `HitFilter` is `Frame | Text | Any`
   (`engine/core/crates/paged-canvas/src/channel.rs`).
8. **There is no string table.** All UI strings are inline English.
9. **The iframe bridge** (`playground/IframeScriptBridge.tsx`) runs only in dev and demo
   builds. It depends on `window.__canvas` and sends no `frame-ancestors` header.

**Engine.**

10. **Text edits do not reach `apply_inner`.** `InsertText` and `DeleteRange` run as text
    operations from `CanvasModel::apply_mutation` (`paged-canvas/src/mutate.rs`). Several
    settings mutations return early there too.
11. **Undo re-runs the lock check.** Undo, redo and batch rollback call `paged_mutate::apply`
    or `apply_inner` again (`model.rs` undo/redo sites, `paged-mutate/src/lib.rs`
    `Project::undo`/`redo`, `apply/layer.rs` batch rollback). Nothing exempts them; `lock.rs`
    only argues they cannot fail.
12. **Refusals reach the wire untyped.** `frame_mutation_error` (`model.rs`) maps every
    `OperationError` except `NodeNotFound` to `WorkerError::NotImplemented { what }`. Not even
    `Locked` is typed today.
13. **`OnMaster` swaps the parent spread into `doc.spreads`** before it recurses
    (`apply/master.rs`), so an operation-level check cannot see a parent-page item unless it
    is told.
14. **Labels have a gate and an envelope.** `PluginMetadata` writes require an `x-paged:` key,
    `x-paged:<caller>` when a caller is set, at most 64 KiB, and a JSON envelope
    `{ "v": n, "data": {…} }` (`apply/layer.rs` `plugin_metadata_gate`).
15. **XML tags are imported but not written.** `idml-export` copies the source package's `XML/`
    parts; no operation adds or removes tags. A new blank document writes no `Tags.xml`.
16. **Effective resolution is not computed.** `LinkSummary.effective_ppi` is InDesign's stored
    value. Overset is per story (`paged-renderer/src/diagnostics.rs`).
17. **`apply_inner` has nine call sites, all inside `paged-mutate`.** `apply_mutation` has 21 in
    `paged-script` and one in `paged-canvas-wasm`. Session state lives on `CanvasModel`, with
    a copy on `WorkerCore` that is re-applied on load. `SetSnapSettings` is the template for a
    setter message.

**Packaging and CI.**

18. **No library build exists anywhere in the editor.** Every editor package is private and
    consumed as source. A public package may depend only on public packages
    (`tooling/release/verify-tarballs.mjs`), and the release scripts hard-code "the three".
19. **ADR numbers.** The next free numbers are:
    - editor **274**;
    - `modules/data` **560**;
    - extensions **333**;
    - server **954**;
    - PM **PM-0012** (the engine range) and **PM-0013** (the package).

    The engine's 1xx range is full, and its 200–209 overlap the editor's. Decided: a new
    engine range through PM-0012 before C lands (§12, §14).

## 3. Rules that hold for every task

- **Gates.**
  - Before each push, run the gates the change touches: `moon ci --base origin/main --head HEAD`,
    `tooling/js/fmt.sh --check`, `tooling/js/bun-canary.sh lint`.
  - For the editor, also run `bun run test:dom` and `test:dom:compiled` in `apps/canvas` and
    `packages/shell`.
  - For the engine, `cargo nextest run --workspace` in `engine/core`.
- **Protocol.** Any wire change bumps `PROTOCOL_VERSION` (`paged-canvas/src/channel.rs`), runs
  `node engine/core/scripts/check-wasm-package-versions.mjs --write`, updates `bun.lock` and
  rebuilds with `moon run core:wasm-pkg`, all in the same commit as the editor change that
  consumes it. Workstream C batches its wire changes into as few bumps as practical (C2 and C6
  share one).
- **Contract.** An edit under `platform/extensions/packages/{plugin-api,plugin-sdk}/src` bumps
  plugin-sdk's canary version and plugin-api's with it. This plan touches the contract once, in
  E10 (contribution titles as message keys). Plugins see permissions only as refusals, which
  the contract already models as outcomes.
- **React.**
  - New components are compiled by the React Compiler. Reading registries uses
    `useRegistryView`, and stores use `useLive`.
  - No new `useMemo`/`useCallback`.
  - Run `bun tooling/js/react-compiler-coverage.mjs --write` when coverage changes.
- **Surface conformance.** Every new command, panel, tool, menu, setting and CLI verb gets
  `covers("<kind>:<id>")` in a test of the required tier (ADR 227).
- **Lint boundaries.** A new `platform/shared/*` package needs its lint allow-list entries and
  self-test cases (`bun run lint:selftest`). A new `apps/editor/packages/*` package falls into
  the editor zones automatically.
- **ADRs.** A decision is recorded when it lands, in the component's range, in the README
  format (`apps/editor/docs/adr/README.md`). The ledger is in §12.
- **Public repository.** No private paths, no private corpus names, no names of people, no
  business terms. Corpus-dependent tests go through `platform/shared/test-resources`
  (`skip!`, `PAGED_REQUIRE_<X>=1`).

---

## 4. Workstream A — Composition (concept §5)

Goal: a runtime `EditorProfile` decides which bundles, modes and chrome regions exist and what
each region holds. The six solo profiles become presets. With the `full` preset, nothing
changes for the editor.

### A1 — The `EditorProfile` type, presets as data, resolution

- **Files.** New `apps/editor/packages/shell/src/profile/` (`types.ts`, `resolve.ts`,
  `adjust.ts`, `validate.ts`). New `apps/editor/apps/canvas/src/profiles/` (`presets.ts`,
  `from-url.ts`).
- **Steps.**
  1. Define `EditorProfile`, `RegionId`, `RegionSpec`, `RegionItem` and `PresetId` as in the
     concept, §5.3. Add `ResolvedProfile`: the fully expanded form, with no `extends` and every
     region either a resolved list or `null`.
  2. `resolveProfile(input, presets) → ResolvedProfile`. Expand `extends` (with cycle
     detection), merge region by region (an absent key inherits, `null` removes), then apply
     adjustments.
  3. `adjust.ts`: `remove`, `insert({before|after|position})`, `set` and `update`, by matcher
     (exact id, glob, `first`/`last`, index). These are pure functions over `RegionItem[]`.
  4. `validate.ts`: a shape check in the style of the stored-settings checks
     ([ADR 247](adr/247-stored-settings-are-shape-checked.md)), returning
     `{ profile, problems[] }`. Unknown keys and bad types are problems, never throws.
  5. Express the six `SoloProfile`s (`apps/canvas/src/solo/profiles.ts`) as `solo:<name>`
     presets in `presets.ts`, as plain data. Add `full`, which mirrors today's
     `BUILT_IN_PANELS`, `BUILT_IN_TOOLS`, `PANEL_RAIL`, `COCKPIT_MODES` and every region.
  6. `from-url.ts`: `?profile=<preset>` (dev and demo), with `?solo=<name>` as an alias for
     `solo:<name>`. An unknown name resolves to `full` and records a problem, as
     `resolveSoloProfile` does today.
- **Tests.** Unit tests for resolution, inheritance, `null` removal, every matcher kind,
  cycles and validation problems (`packages/shell/test/profile/*.test.ts`). A golden test:
  `resolveProfile({extends:"solo:draw"})` produces the same panel, tool, menu and slot sets as
  today's `SOLO_SURFACES` for `paged.draw`.
- **Exit.** Pure functions with tests; nothing is wired yet.

### A2 — Every region optional

- **Files.** `apps/editor/packages/shell/src/PagedShell.tsx`, `chrome/Header.tsx`,
  `cockpit/CockpitLayout.tsx`, `chrome/ToolRail.tsx`, `chrome/PanelRail.tsx`,
  `chrome/ModeSwitcher.tsx`.
- **Steps.**
  1. Add a `regions?: ResolvedRegions` prop to `PagedShellProps`. Absent means "as today", so
     the change is behaviour-neutral.
  2. Split `Header` into parts addressable as region items: wordmark, document title, menu
     bar, `headerExtras`. `regions.header === null` removes the header row. `regions.menubar
=== null` removes the menu bar while keeping the header.
  3. Make conditional:
     - `ContextToolbar`, `ToolRail`, `PanelRail`, `ModeSwitcher` (zoom moves to a separable
       item);
     - `CommandPalette` (`regions.palette`);
     - `ExportPdfDialog` (present only when the export command is registered);
     - the edit-context breadcrumb.
  4. `CockpitLayout`: `canvas.titleBar`, `canvas.rulers` and `canvas.thumbnails` flags, and
     `left`/`right` as `null` (no column, no reserved width). Keep the viewport `div` and its
     data attributes unchanged; tests and overlays rely on them.
  5. `railHidden`/`panelsHidden` (Tab, Shift+Tab) keep working inside what the profile allows.
- **Tests.** DOM tests per region (`packages/shell/test/chrome/regions.dom.test.tsx`): absent
  regions render no element and reserve no space. A journey renders a document with only the
  `canvas` region and checks the canvas is the full viewport.
- **Exit.** A profile with only `canvas` shows a document edge to edge. The existing journeys
  are unchanged.

### A3 — Region contents as ordered id lists

- **Files.** `chrome/MenuBar.tsx` (`buildMenuTree`), `chrome/ToolRail.tsx` (`slotVisible`),
  `cockpit/RightDock`, `chrome/PanelRail.tsx`, `chrome/Header.tsx`, a new
  `chrome/RegionItems.tsx`.
- **Steps.**
  1. Add `RegionItems`, a renderer for `RegionItem[]`:
     - a command id renders a button that invokes it, gated by `entryApplies`;
     - a panel id renders a launcher;
     - a tool id renders a rail button;
     - `separator`, `spacer` and `group` render layout;
     - `host` renders a host component (E5).
  2. Menu bar order: the region lists top-level menus in order. Items inside a menu keep
     their registry order, with optional per-menu ordering in a later step.
  3. The tool rail lists tools and groups in order. This replaces the filtered
     `BUILT_IN_TOOLS` plus `ALWAYS_IN_PALETTE` logic, and the navigation tools become explicit
     items in the presets.
  4. `right` holds panel ids (tabs) or one inspector; `left` holds one panel. Today's
     `ModeCockpitSlots` stays the per-mode source when the profile does not override it.
  5. An unknown id renders nothing and is reported once through the profile's problems.
- **Tests.** DOM tests for ordering, unknown ids, and command buttons that grey out by `when`.
- **Exit.** A host can say "the header holds Undo, Redo, a spacer and Save", and it does.

### A4 — The app applies profiles (solo becomes presets)

- **Files.** `apps/editor/apps/canvas/src/main.tsx` (`SOLO`, `SOLO_SURFACES`, the bundle
  activator, the `PagedShell` props), `src/solo/*`, `src/plugin-bundle-table.ts`.
- **Steps.**
  1. Replace `SOLO_SURFACES` with `applyProfile(resolved)`. It returns `{ panels, tools,
panelRail, modes, keepMenu, bundles, regions, initialDocumentSizePt, storageScope }` and
     is still computed once at module scope, as ADR 213 requires for stable array identities.
  2. Make the bundle activator take `bundles` from the profile: all, a list, or "those the
     document uses" (needs D; until then the list is explicit).
  3. Filter **plugin** menus too (fact 4): `keepMenu` applies to every
     `registries.menus.register` call. Do this in the menu registry (an `admit` predicate set
     by the host), not at each call site.
  4. Keep `setChromeStorageScope(profile.storageScope ?? derived)`.
  5. Delete `SoloProfile`, `resolveSoloProfile` and `soloMode`, which are now data and
     `applyProfile`. Keep `?solo=` working through `from-url.ts`.
- **Tests.** `tests/journey/focused/solo-mode.journey.spec.ts` passes unchanged. Add a case
  for `?profile=solo:draw`.
- **Exit.** No solo-specific code remains outside the presets and the URL alias.

### A5 — Open mode ids

- **Files.** `packages/shell/src/state/workflow-mode-context.tsx` (`ALL_MODES`,
  `WorkflowMode`), `registries/mode.ts`, `apps/canvas/src/cockpit-modes.ts`.
- **Steps.** Make `WorkflowMode` a branded string. The six ids stay as constants. The mode
  switcher lists the registered modes, and the stored mode key validates against them. A
  preset may then declare its own mode (`fill`) instead of borrowing `design`.
- **Tests.** Mode persistence with an unknown stored id falls back to the first mode.
- **Exit.** Presets use their own mode ids; the ADR 213 note about reusing `design` is
  superseded.

### A6 — The preset guard

- **Files.** Replace `apps/editor/scripts/solo-profiles-guard.mjs` with
  `scripts/profile-presets-guard.mjs`. Reuse `scripts/surface/enumerate.mjs`.
- **Steps.**
  1. Import the presets as data (they are TS data modules, run with Bun).
  2. Resolve every id against the surface inventory of ADR 227 (`enumerateSurface`) rather
     than with regular expressions over source. That covers plugin ids from manifests,
     including the bundle whose manifest could not be read before.
  3. Check `paletteSuggestions` too, which the old guard skipped.
  4. Keep the CI step name in `editor-tests.yml` (`checks`) so the job graph stays stable.
- **Exit.** CI fails on a renamed id used by any preset.

**ADR.** Editor **274**, "The editor profile is runtime data". It amends ADR 213: solo profiles
become presets, regions are optional, and mode ids are open.

---

## 5. Workstream B — Features (concept §6)

Goal: runtime on/off, with predicates, over the existing surface ids, honoured by every
surface that offers an entry.

### B1 — The feature store

- **Files.** New `apps/editor/packages/shell/src/state/features.ts`. Wire it into
  `registries-context.tsx` (`createShellRegistries`) and the editor state that `getEditor()`
  returns.
- **Steps.**
  1. `createFeatureStore()` with `enable`, `disable`, `set(id, boolean | predicate)`,
     `isEnabled(id)`, `list(glob)`, `subscribe` and a version counter.
  2. Ids are `SurfaceId` (`platform/shared/test-kit/src/covers.ts` `SURFACE_KINDS`) plus a new
     `chrome:` kind for non-registry features (`chrome:rulers`, `chrome:context-menu`,
     `chrome:drag-and-drop`, `chrome:keyboard`, …).
  3. Resolution: the newest `set` first; a predicate gets `{ state, role, previous }`. Globs
     match families, and `isEnabled(glob)` is true only when every match is enabled.
  4. A profile's `features` field seeds the store at start.
- **Tests.** Unit tests for order, globs and predicates that defer to `previous`.

### B2 — Every gate consults it

- **Files.** `registries/types.ts` (`isEnabled`, `entryApplies`), `registries/command.ts`
  (`invoke`), `registries/keybinding.ts` (`resolveParsed`), `chrome/CommandPalette.tsx`
  (`applicableCommands`), `chrome/CanvasContextMenu.tsx` (`holds`), `chrome/ToolRail.tsx`,
  `chrome/PanelRail.tsx`, `cockpit/RightDock`, `cockpit/PanelHost`, `chrome/MenuBar.tsx`,
  `overlays/overlay-host.tsx`.
- **Steps.**
  1. Add `featureAllows(kind, id)` beside `isEnabled`. `entryApplies` and `invoke` require
     it. `invoke` refuses a disabled command silently, as it does for a false `when`.
  2. Make the context menu use `entryApplies` instead of its own `holds()` (fact 5), which
     closes the gap for features and for `when` alike.
  3. List filters in the rails, the dock and the menu tree drop disabled ids, read through
     `useLive(featureStore)` so the compiler sees the dependency.
  4. Make `OverlayHost` honour `when` (fact 5) and `overlay:` feature ids.
- **Tests.** One DOM test per surface (`packages/shell/test/features/*.dom.test.tsx`): a
  disabled command disappears from the menu, the palette, the context menu and its keybinding
  at once; a disabled panel leaves its rail and dock; re-enabling restores them without a
  reload.

### B3 — Conformance and the feature-id inventory

- **Files.** `platform/shared/test-kit/src/covers.ts` (`chrome` kind),
  `apps/editor/scripts/surface/enumerate.mjs` (enumerate the `chrome:` ids from one table),
  `scripts/surface-coverage.mjs`.
- **Steps.** Publish the inventory as JSON (`apps/editor/apps/canvas/feature-ids.json`),
  generated and checked in CI like the client API catalog. It becomes the source for the
  embedding docs (E9) and for host-side type completion.
- **Exit.** `features.isEnabled` on any inventory id works; CI fails when the inventory is
  stale.

**ADR.** Editor **275**, "Features gate what is offered, over surface ids".

---

## 6. Workstream C — Engine policy (concept §7.1–§7.8)

Goal: documents carry a template policy, the engine session carries a role, and the engine
refuses every operation the policy does not permit, from any caller, with a typed refusal.
Field values can be read and written as fields.

### C1 — The policy model crate

- **Files.** New crate `engine/core/crates/paged-template` (workspace member). It depends on
  `paged-model`, `paged-scene`, `paged-mutate` (types only), `serde`, `schemars` and `tsify`
  (feature-gated as in `paged-wire`).
- **Types.**
  - `TemplatePolicy { v, defaults: PermSet, fields: Vec<FieldDef>, groups, order }` for the
    document level.
  - `ItemPolicy { field: Option<FieldDef>, allow: PermSet, deny: PermSet }` for each item.
  - `FieldDef { name, kind: FieldKind, label: Localised, help, group, required, constraints }`,
    with `FieldKind = Text | TextRun | Variable | Image | Choice | Visibility | Data`.
  - `Permission`, an enum of the concept's vocabulary (§7.5); `PermSet`, a bit set.
  - `Role = Author | Editor | Filler | Viewer`; `SessionPolicy { role, overrides:
Map<Permission, Allow | Deny | Defer> }`.
- **Storage.** The document policy lives in the `x-paged:template` label of `DesignMap.labels`,
  and each item policy in the `x-paged:template` label of `Spread::labels[item]`. Both use the
  `{ "v": 1, "data": … }` envelope required by `plugin_metadata_gate` (fact 14).
- **Functions.**
  - `PolicyIndex::build(&Document)`, built on load and kept fresh on label writes, maps names
    to items and items to policies.
  - `effective(&PolicyIndex, &SessionPolicy, item) → PermSet`: role defaults, then session
    overrides, then document defaults, then the item (concept, §7.5).
- **Tests.** Unit tests for resolution order, envelope parsing (bad JSON is a problem, not a
  panic) and versioning.

### C2 — The session role on the wire

- **Files.** `paged-canvas/src/channel.rs` (`MainToWorkerKind::SetSessionPolicy`,
  `WorkerToMainKind::SessionPolicyApplied`), `paged-canvas/src/model.rs` (a field on
  `CanvasModel`), `paged-canvas-wasm/src/dispatch.rs` (a copy on `WorkerCore`, re-applied on
  `LoadDocument`/`NewBlankDocument`), `apps/editor/packages/client/src/{protocol.ts,client.ts}`
  (re-export and `CanvasClient.setSessionPolicy`).
- **Steps.** Follow `SetSnapSettings` end to end (fact 17). The default is `Editor` with no
  overrides, so existing sessions behave as today. The CLI `Session` wraps `WorkerCore` and
  gets the role for free.
- **Tests.** A dispatch test in `paged-canvas-wasm/tests/it/dispatch.rs`: the role survives a
  document load.

### C3 — Classifying operations into permissions

- **Files.** New `paged-mutate/src/apply/permit.rs` (next to `lock.rs`), or the
  `paged-template` crate with a thin hook in `paged-mutate`.
- **Steps.**
  1. `required(doc, op) → SmallVec<(Permission, Target)>`, an **exhaustive** match over
     `Operation`. No wildcard arm: a new variant does not compile until someone decides its
     permission.
  2. Map the families as follows:
     - `SetProperty`: by `PropertyPath`. Reuse `lock::moves_geometry` for `item.move` and
       `item.resize`. `ImageContentTransform` maps to `image.crop`; fill, stroke, effects and
       opacity paths to `appearance.*`; `ItemName` and `PluginMetadata` for `x-paged:template`
       to policy writes (C7).
     - `InsertNode`, `InsertSnippet` and `InsertAnchoredFrame` map to `document.add-item`.
     - `RemoveNode` maps to `item.delete`.
     - `MoveNode`, `ReorderNode` and `MoveLayer` map to `item.restack` or `item.move`.
     - `DuplicateNodes` maps to `item.duplicate`.
     - `ApplyStyle` and range `SetProperty` map to `text.style`.
     - `InsertField`, `DeleteField` and `SetFieldValue` map to `text.edit` on the story's frame.
     - `PlaceImage` and `ReplaceImageBytes` map to `image.replace`.
     - Page, master, section and guide operations map to `document.pages`.
     - Style, swatch, gradient, numbering and text-variable definitions map to
       `document.styles`.
     - Tables, notes, hyperlinks and conditions map to `text.edit` on the containing story.
  3. Story targets resolve to frames with `paged_scene::Document::frame_for` and
     `frame_chain`. A story threaded through several frames needs the permission on each
     frame it touches; the first frame is enough for a field whose whole chain is the field.
  4. `OnMaster` (fact 13): the classifier sees the wrapper before the spread swap and marks
     every inner target as a parent-page item, which is scenery for a filler.
- **Tests.** A table test: every variant maps to at least one permission. A property test:
  for a sample of generated operations, `required` never panics.

### C4 — Enforcement at the operation level

- **Files.** `paged-mutate/src/apply/mod.rs` (`apply`, `apply_inner`), the nine internal call
  sites (fact 17), `paged-mutate/src/lib.rs` (`Project::apply`/`undo`/`redo`),
  `paged-canvas/src/model.rs` (`apply_operation`, the undo and redo sites).
- **Steps.**
  1. Add `ApplyCtx<'a> { policy: Option<&'a Guard<'a>> }`, threaded through `apply_inner`.
     `Guard` holds the `PolicyIndex` and the `SessionPolicy`.
  2. `apply_inner` runs `permit::refuse_if_not_permitted(doc, op, ctx)?` right after
     `refuse_if_locked`. In a batch, every child is checked before any child applies (a
     dry pass), so a refused batch never half-applies and rolls back.
  3. `apply` keeps its signature and passes `policy: None`, the trusted path. A new
     `apply_checked(doc, op, &Guard)` is used by `CanvasModel::apply_operation`.
  4. **Undo, redo and rollback pass `None` explicitly** (fact 11). Add the same explicit
     exemption for the lock check, so `lock.rs`'s argument becomes code.
  5. Add `OperationError::NotPermitted { permission, target }`.
- **Tests.** `paged-mutate/tests/it/template_policy.rs`, mirroring `element_lock.rs`:
  - refusal per permission family;
  - a batch refused whole;
  - an author edit undone while the session is `filler` succeeds;
  - a parent-page item refused for a filler;
  - `Editor` and `Author` refused nothing.

### C5 — Enforcement at the mutation level and at gesture begin

- **Files.** `paged-canvas/src/model.rs` (`apply_mutation`: the text path, the early-return
  settings writes, `Mutation::Set` after `resolve_set`), `paged-canvas/src/gesture.rs`
  (gesture begin), `paged-canvas/src/hit.rs` and the `HitFilter` in `channel.rs`.
- **Steps.**
  1. Text path (fact 10): before `crate::mutate::apply`, require `text.edit` on the story's
     frame for `InsertText` and `DeleteRange`, and `text.style` for style runs.
  2. Settings writes (`SetDocumentDefaults`, colour settings, ink and proof settings): proof
     and view settings stay allowed (they are view state), and the document-changing ones
     need `document.styles`. Each is listed explicitly.
  3. Gesture begin: require the permissions the gesture would need, next to the existing
     `is_locked` check at begin. Return a typed `GestureFailure::NotPermitted`.
  4. Hit testing (fact 7): add `HitFilter::Selectable`, which skips items without `select`
     for the session. The editor uses it whenever the role is `filler` or `viewer`.
- **Tests.** `paged-canvas/tests/it/template_policy_wire.rs`, mirroring
  `element_lock_wire.rs`: typing into a non-field frame is refused, typing into a field
  succeeds, a drag on scenery is refused at begin, and a click on scenery hits the field
  behind it.

### C6 — Typed refusals on the wire

- **Files.** `paged-canvas/src/channel.rs` (`WorkerError`), `model.rs`
  (`frame_mutation_error`), `apps/editor/packages/client/src/protocol.ts`.
- **Steps.** Add `WorkerError::NotPermitted { permission, target }` and, in the same bump,
  `WorkerError::Locked { node, action }` (fact 12). `frame_mutation_error` unwraps
  `BatchFailed` to the first typed cause. Ship this in the same protocol bump as C2.
- **Tests.** Wire tests assert the typed error. The editor's `mutate` outcome carries it
  (`packages/client` unit test).

### C7 — The policy protects itself

- **Steps.**
  - Writing an `x-paged:template` label, at document or item level, requires role `Author`.
  - Renaming an item that is a field (`ItemName`) requires `Author`.
  - Deleting a field item requires `Author`, unless `item.delete` is granted.
  - An `Editor` may change a policy only through a host's session override; the default is
    no (decided, §14).
- **Tests.** Neither a filler session nor a default editor session can write
  `x-paged:template` through `SetPluginMetadata`, `Set` or a script. An editor session with
  the override can.

### C8 — Fields as a read and write surface

- **Files.** `paged-template` (field lowering), `paged-canvas/src/channel.rs` (a
  `TemplateFields` collection like `XmlElements`; `Mutation::SetTemplateFields`),
  `paged-canvas/src/model.rs`.
- **Steps.**
  1. The collection returns `FieldInfo { name, kind, label, group, required, constraints,
targets, value, validity }`.
     - `text` reads the story text;
     - `text-run` reads `PlaceholderField.value`;
     - `variable` reads the custom variable's text;
     - `image` reads the link or embedded image identity;
     - `choice` reads the current value;
     - `visibility` reads `ElementVisible`.
  2. `SetTemplateFields { values: Map<name, FieldValue> }` lowers in the engine, as one
     batch, so the browser and headless runs behave the same:
     - `text`: replace the story's text and keep the first run's paragraph and character
       style ("content, not design", concept §7.3);
     - `text-run`: `SetFieldValue`;
     - `variable`: the custom variable's text;
     - `image`: `ReplaceImageBytes` plus the field's fit;
     - `choice`: `Set { address, path, value }` after checking the allowed list;
     - `visibility`: `ElementVisible`.

     The result is one undo step ([ADR 253](adr/253-one-action-one-batch.md)), and every
     lowered operation passes the policy check as usual.

  3. Constraints:
     - `maxLength`, `pattern`, `required` and the allowed lists are checked before apply.
     - The overset rule is checked after apply and layout, using `overset_story_ids`. `refuse`
       rolls the batch back; `shrink` steps the point size down within the field's bounds,
       inside the same batch; `allow-and-flag` reports it.
     - Effective resolution is a new computation (fact 16): pixel size against placed scale,
       from the image's decoded dimensions and the frame's content transform. It is reported,
       never refused at set time; validation reports it.
  4. `Validate` request returns `ValidationReport { fields: [{ name, problems }], document:
[preflight] }`.
- **Tests.**
  - `paged-template` unit tests per field kind.
  - Wire tests: a set of every kind, undo, a refused value.
  - An editor op-sandwich spec (`apps/canvas/tests/e2e/template-ops.spec.ts`) with model,
    pixel and undo assertions per kind, plus rows in `capabilities.ts`.

### C9 — Fields from XML tags

**Done (protocol 76, engine [ADR 1002](../../../engine/core/docs/adr/1002-xml-tags-carry-template-fields.md)).**
`paged_template::derive_fields`; the importer records where each tagged range stands; a tag
that cannot be a field (a parent page, nothing tagged, a line or group, a story whose ranges are
the fields) is reported with its reason. Run fields live in `DocumentPolicy::runs`, keyed by the
placeholder that holds them, and are read and set through it (`templateFields`,
`setTemplateFields`). Fixture: `paged_gen::fixtures::tagged_template_idml`.

- **Files.** `paged-template/src/derive.rs`. The model's `xml_root`, `xml_elements` and
  `xml_tags` are the sources.
- **Steps.**
  1. `derive_fields(&Document, DeriveOptions) → Vec<FieldDef + target>`:
     - a tagged text frame or story becomes `text`;
     - a tagged graphic frame becomes `image`;
     - a tagged range becomes `text-run`. **Decided:** on import as a template, the range is
       converted into a `PlaceholderField` run whose value is the range's text (`InsertField`
       with `FieldKind::Placeholder`, then `DeleteRange` of the original text, in one batch).
       The XML element stays and now wraps the placeholder, so edits cannot drift the range's
       bounds and `SetFieldValue` is the write path;
     - XML attributes `label`, `maxLength` and `required` become field metadata.
  2. Options: include names, include data-merge placeholders.
  3. The result is written as policy labels by the author's "Open as template" (F5) or by
     `paged template ingest` (F6). Derivation never writes by itself.
- **Not in this task.** Writing tags on IDML export (fact 15) is task C10.
- **Tests.** Fixtures: a small tagged IDML built in-repo (no corpus) with a tagged text frame,
  a tagged image frame, a tagged range and a parent-page tag.

### C10 — Writing XML tags (decided: in this project)

**Done (protocol 76, engine ADR 1002).** The seven operations (undone through the inverse-only
`RestoreXmlStructure`), the writer in `idml-export/src/xml_structure.rs` (story ranges placed by
the story writer through private-use markers), the blank document's `Root` tag, and Make field
in the Template panel tagging the item in the same batch. `TagItem` retags an item tagged
already; `SetXmlAttribute` also takes the item a tag is on. Not done: moving ranges through
every text-changing operation (the text kernels and the field operations do), renaming or
removing a tag definition when a field is renamed (the old definition stays), the optional
corpus lane.

Goal: a field made in paged is also an XML-tagged element in the exported IDML, so InDesign
and other tag-based tools see a paged-made template as tagged. Today tags survive only
because the exporter copies the source package's `XML/` parts (fact 15).

- **Files.**
  - `paged-mutate/src/operation.rs` and `src/apply/xml.rs` (new): operations on the XML
    structure;
  - `idml-export/src/lib.rs` (`write_package`), a new `idml-export/src/xml_structure.rs`
    writer, and `idml-export/src/rewrite.rs` (inline story elements);
  - `paged-canvas/src/blank.rs` (new documents);
  - `paged-model/src/lib.rs` (`DesignMap.xml_tags`, `xml_root`, `Story::xml_elements`).
- **Steps.**
  1. Add operations, all invertible (core ADR 005):
     - `CreateXmlTag { name, color }` and `DeleteXmlTag`;
     - `TagItem { item, tag }` and `UntagItem`, for a page item or a story;
     - `TagRange { story_id, start, end, tag }` and `UntagRange`;
     - `SetXmlAttribute { element, name, value }`.

     C3 classifies them as `document.styles` for tag definitions and as policy writes
     (author only, C7) for tagging.

  2. A writer that serialises the model's `xml_tags` and `xml_root` to `XML/Tags.xml` and
     `XML/BackingStory.xml`, and story-level `<XMLElement>` wrappers from
     `Story::xml_elements`. The copy-through of source parts is replaced by this writer
     whenever the model's XML structure differs from the imported one (a dirty flag set by
     the operations above), and for every document created in paged. An unchanged imported
     document keeps the byte-identical copy path.
  3. `blank.rs` writes a `Tags.xml` with InDesign's default `Root` tag, so a new document is
     tag-ready.
  4. The Template panel (F1): Make field also tags the item, or the range for `text-run`,
     with a tag named after the field (created if missing). Renaming a field renames the tag
     when no other element uses it. Removing a field removes the tag from the element (the
     tag definition stays if used elsewhere).
  5. XML attributes mirror the field metadata C9 reads (`label`, `maxLength`, `required`), so
     derive → write → derive is a fixed point.
- **Tests.**
  - `paged-mutate/tests/it/xml_structure.rs`: every operation and its undo.
  - `idml-export/tests/it/xml_structure_roundtrip.rs`: tags, elements, attributes and range
    wrappers survive export and import, and unchanged imports stay byte-identical.
  - A fixed-point test for derive and write.
  - A corpus lane (optional resource): a paged-made template opened and saved in InDesign
    still has its tags. It reports `unavailable` without the corpus.

### C11 — Round trips

- **Tests only.**
  - `idml-export/tests/it/template_policy_roundtrip.rs` (pattern: `label_roundtrip.rs`):
    document and item policies and item names survive export and import.
  - `.paged` save and load.
  - A corpus lane (optional resource) opens a policy-bearing file saved by InDesign and checks
    the policy is intact. It reports `unavailable` without the corpus.

**ADRs (engine; numbers per §12):**

- "A template policy lives in labels";
- "The session has a role";
- "Permissions are checked at three doors; undo is exempt";
- "Refusals are typed on the wire".

---

## 7. Workstream D — Filling (concept §7.10)

Goal: the `template-fill`, `form` and `viewer` presets work end to end in the editor.

### D1 — Client and shell plumbing

- **Files.** `apps/editor/packages/client/src/client.ts` (`setSessionPolicy`,
  `setTemplateFields`, `validate`), `packages/shell/src/catalog/use-collection.ts` (the
  `TemplateFields` collection), new `packages/shell/src/state/session-role.tsx` (role context
  for predicates and UI).
- **Steps.**
  - The role enters `getEditor()` state, so `when` and feature predicates can read it.
  - A `NotPermitted` outcome raises a quiet status message ("This part of the template can't
    be changed"), never an error dialog or a problems-panel entry.

### D2 — The form region

- **Files.** New `apps/editor/apps/canvas/src/panels/template/form-panel.tsx`, with leaves
  from the shared panel kit ([ADR 233](adr/233-panel-controls-share-one-kit.md)), registered
  as `paged.template.form`.
- **Steps.**
  1. Group and order fields as the policy says.
  2. Each kind gets its control:
     - text: input or textarea, with a counter for `maxLength`;
     - image: thumbnail, Replace, Remove, and the host's `pickAsset` when present;
     - choice: a select, or a swatch row for colours;
     - visibility: a switch.
  3. Every edit is `setTemplateFields`. Show validity inline and a summary on top.
  4. Focusing a field scrolls the canvas to it and highlights it; selecting a field on the
     canvas focuses its control. Both go through the selection context.
- **Tests.** `apps/canvas/test/panels/template-form.dom.test.tsx`: every kind, constraint
  display, and refusal display.

### D3 — Field overlay and canvas affordances

- **Files.**
  - new overlay `apps/canvas/src/overlays/template-fields.tsx`, an `OverlayContribution` with
    `when` (honoured after B2);
  - a small interactive layer for the Replace button, modelled on the interactive guide
    overlay (`overlays/guide-overlay.tsx`);
  - `apps/canvas/src/ui/ViewportCanvas.tsx` and `panels/canvas-panel.tsx` (`onHit`).
- **Steps.**
  1. Draw outlines and, on hover, labels for fields (author: always; filler: on hover and for
     invalid fields), with a new `--overlay-field` token.
  2. Image fields get a Replace button, a drop target ([ADR 258](adr/258-a-dropped-picture-is-placed-where-it-lands.md)
     semantics: dropped onto a field, the field takes it), and `pickAsset` when present.
  3. In a filler session, a single click on a text field enters text editing.
  4. Hit testing uses `Selectable` (C5) for fillers and viewers.
- **Tests.** A journey (`tests/journey/focused/template-fill.journey.spec.ts`) fills a card
  through the canvas: type, replace an image by drop, try to drag a logo (refused, nothing
  moves).

### D4 — The fill edit context

- **Files.** `apps/canvas/src/edit-contexts/template-fill.ts` (an `EditContextContribution`,
  ADR 024).
- **Steps.** The tool set is select, text, hand and zoom; there is no breadcrumb, and Esc does
  not leave it. It is entered at start when the role is `filler`. It is a UI convenience only;
  the engine (C) enforces.

### D5 — The presets

- **Files.** `apps/canvas/src/profiles/presets.ts`.
- **Steps.**
  - `template-fill`: `canvas` with no rulers or title bar, `form` on the right, `actions-bar`,
    and zoom and page arrows in a mode bar.
  - `form`: form plus preview. The preview is the viewport with pointer edits off: the
    `viewer` hit filter plus no tools.
  - `viewer`: `canvas`, page navigation and zoom.
  - The bundle rule "those the document uses" is a document query listing the plugin-owned
    frames (`x-paged:<plugin>` labels), mapped to bundle ids. Unknown plugins are reported.
- **Tests.** A journey per preset. The `form` journey fills every field from the form only and
  exports a PDF; the result matches the canvas-filled PDF.

**Milestone M3** (§10) is reached here: inside the editor (`?profile=template-fill`), a
filler fills a template, cannot break it, and exports a PDF.

**ADR.** Editor **276**, "Filling a template".

---

## 8. Workstream E — Embedding (concept §8)

Goal: `createEditor(element, config)` from a public npm package, and the same API through an
iframe.

### E1 — Instance safety (start early; behaviour-neutral steps)

Each step is its own commit, keeps the app identical and is checked by the full journey
suite.

1. **Mount function.** Move `main.tsx`'s body into `apps/canvas/src/app/mount.tsx`:
   `mountEditor(element, options) → { dispose }`. `main.tsx` keeps three lines:
   `assertCrossOriginIsolated()`, read the URL options, `mountEditor(#root, …)`.
2. **The instance.** Collect the module singletons (fact 1) into an `EditorInstance` object
   created by `mountEditor`, provided through context.
   - Shell singletons become instance-held stores passed by `PagedShell`.
   - Module-level "current editor" setters (`setObjectModelEditor`, `setPageGoTo`,
     `setDocumentSourceSink`, `setLibrary`, …) become instance fields.
   - One audit commit lists every `let`/singleton found, and a lint-style script
     (`scripts/instance-guard.mjs`) fails on new module-level mutable state in `apps/canvas/src`
     and `packages/shell/src`. Allowed exceptions are listed with reasons.
3. **Globals.** `__paged`, `__canvas` and the other `__*` handles are published only by the
   app entry and only in dev or demo, never by `mountEditor` itself. Tests that use them keep
   working through the entry.
4. **Events.** The keybinding registry and `canvas-panel.tsx` listen on the editor's root
   element (with `tabIndex` focus management), not on `window`. The page's own shortcuts stay
   the host's. `beforeunload` (`UnsavedChangesGuard`) becomes an option, off by default
   embedded.
5. **Styles.**
   - Scope the global CSS under `[data-paged-editor]`: Tailwind's preflight scoped to the
     root, and `body` rules moved to the root.
   - Tokens move from `:root` to `:root, [data-paged-editor]`.
   - `ThemeProvider` takes `theme` and `onThemeChange` props and sets `.dark` on the root
     element, not on `<html>`.
   - Radix portals get a container inside the root (one `PortalContainer` context, used by
     ToolRail, FillStrokeCluster and the swatch rows).
6. **Storage.** A `StorageAdapter` (get, set, remove, scoped) replaces direct `localStorage`.
   The app passes `localStorage` with today's keys (`scripts/settings-inventory.json` stays
   the inventory). An embedder passes memory, none, or its own.
7. **Workers and wasm.** Every `new Worker(new URL(...))` and `?url` import resolves relative
   to a configurable `assetBase`, defaulting to the module's own URL, as the viewer does in
   `engine/core/web/idml-viewer/src/bootstrap.ts`.
8. **Trusted types.** The policy is installed once per page and idempotently, since a host may
   already have one. The embedding docs list the policy name a host must allow.

- **Tests.** A journey mounts two editors on one page and edits both; a journey mounts,
  disposes and remounts; DOM tests check that nothing is written to `<html>` or `<body>`.
- **Exit.** `mountEditor` can be called on any element, twice, and disposed cleanly.

### E2 — Host actions

- **Files.** `apps/canvas/src/app-commands.ts` (`savePaged`, `saveAsIdml`, `openPdf`),
  `main.tsx`/`mount.tsx` (`savePagedFile`), `packages/shell/src/state/commands/export-commands.ts`
  and `chrome/ExportPdfDialog.tsx`, `apps/canvas/src/shell-file-saver.ts`,
  `shell-file-picker.ts`, `packages/shell/src/lib/file-chooser.ts`.
- **Steps.**
  1. Add `HostActions { save, export, upload, pickAsset, resolveAsset, submit, close, back,
validate }`, all optional, in `mountEditor` options.
  2. Each is a command `paged.host.<name>`, registered only when supplied
     ([ADR 209](adr/209-command-is-the-action-primitive.md)). Regions can therefore place them,
     and features can gate them.
  3. Save: `savePagedFile` calls `actions.save(bytes, meta)` when present, otherwise today's
     File System Access or download path.
  4. Export: the export dialog's final step calls `actions.export(blob, options)` when
     present. A host may also skip the dialog (`export: { dialog: false, options }`).
  5. Upload: the file chooser and drop paths call `actions.upload(file) → { uri } | { bytes }`.
     Bytes are placed with `ReplaceImageBytes`; a URI goes through `resolveAsset` first.
  6. Linked images: on load, read the links collection (`LinkSummary`) and call
     `actions.resolveAsset(link)` for each unresolved link, then hand the bytes to the
     engine. **Verify first** whether a message exists to register bytes for a link URI; if
     not, add `RegisterLinkedAsset { uri, bytes }` to the wire (engine task **C12**, same
     style as C2).
  7. `submit` runs `validate` (engine, then host), then `actions.submit({ values, bytes? })`.
     Failures show in the form.
- **Tests.** DOM tests per action with fakes; a journey (embed host, E7) uploads through a
  host action and saves through another.

### E3 — The handle

- **Files.** New `apps/editor/packages/editor/src/` (`create-editor.ts`, `handle.ts`,
  `events.ts`, `types.ts`).
- **Steps.** `createEditor(el, config) → Promise<EditorHandle>` (concept, §8.2), implemented
  over `mountEditor`, the instance's `CanvasClient`, the registries and the feature store:
  - `load`: `client.loadDocument`;
  - `save`: `client.exportPaged`;
  - `export`: `client.exportPdf` (and images through the export registry);
  - `fields`, `getFieldValues`, `setFieldValues`, `validate`: C8;
  - `ui`: A1's adjust functions on a live profile;
  - `features`: B1;
  - `setRole`: C2 plus a profile switch;
  - `setTheme`: E1 step 5;
  - `on`: an event bus fed by the client's mutation notices, the selection context and the
    field collection.

  `ready` fires after the boot bundles settle and the document has rendered.

- **Runtime profile switch.** `ui` changes re-run `applyProfile` and re-register the
  difference (registrations are ref-guarded today; add diffing so unchanged arrays keep their
  identity). Switching between presets keeps the same `CanvasClient` and document.
- **Tests.** `packages/editor/test/*.dom.test.ts` for every method against a mounted editor in
  happy-dom with a stub client; journeys through the example host (E7).

### E4 — Theme and strings

- **Steps.**
  1. Theme: document the token names as a contract (a generated table from `theme.css`).
     `setTheme({ mode, tokens })` writes custom properties on the root. Brand fonts are the
     host's; the editor's fonts become overridable tokens.
  2. Strings: new `apps/editor/packages/strings`.
     - A typed message catalogue with `t(key, params)` and an English source, plus a locale
       loader (JSON per locale, supplied by the host or fetched from `assetBase`).
     - **Phase 1** extracts the strings an end user of the fill presets sees: the form,
       the actions bar, field messages, refusals, validation, the loading state.
     - **Phase 2**, the whole editor and the bundles, is task E10 (decided: in this
       project).
     - Template labels and help texts are per-locale in the policy (`Localised`).
  3. Loading state: a host-supplied element or text shown until `ready`.
- **Tests.** A DOM test renders the form in two locales.

### E10 — The whole editor in strings (decided: in this project)

Goal: every string the editor and its built-in bundles show comes from a catalogue, and a host
can run the editor in another language. It runs beside D and E after E4's phase 1 and lands
package by package.

- **Files.** `apps/editor/packages/strings` (from E4); every `apps/editor/packages/*` and
  `apps/editor/apps/canvas/src`; the module bundles under `modules/*/packages/*`;
  `platform/extensions/packages/plugin-api/src` (contribution titles); a new check script
  `tooling/js/strings-guard.mjs`.
- **Steps.**
  1. **Catalogue format.** One JSON catalogue per package (`strings/en.json`), keys
     namespaced by package (`shell.palette.placeholder`). ICU message syntax for plurals and
     parameters. The catalogues are merged at build time per locale. A host may override any
     key at runtime (`setLocale(locale, { overrides })`).
  2. **Extraction**, a codemod per package. It replaces JSX text and string props (`title`,
     `label`, `placeholder`, `aria-label`) with `t()` calls and writes the English catalogue.
     It runs package by package, one commit each, each reviewed and green. Order:
     - shell chrome (menus, palette, dialogs, rails);
     - catalogue leaves and the panel kit;
     - canvas app panels (about 80; run in groups by cockpit mode);
     - the bundles.
  3. **Registry contributions.** Command, menu, panel and tool titles become message keys with
     an English default: `title: msg("paged.object.lock", "Lock")`. For host contributions this
     is shell-internal. For plugin bundles it is a **contract change**: plugin-api accepts
     `title: string | { key, default }` and the manifest gains `strings: { <locale>: path }`.
     This bumps plugin-sdk's version and plugin-api's with it, under the contract guard. A
     community plugin that passes plain strings keeps working, untranslated.
  4. **Formatting.** Numbers, measurements and dates go through one locale-aware formatter.
     Units follow the editor's unit rules ([ADR 245](adr/245-one-document-unit.md),
     [ADR 254](adr/254-engine-values-read-in-words.md)): the unit names translate, the values
     do not change. Engine messages surfaced to users (refusals, preflight findings) are keyed
     by their typed kind (C6), not by their English text.
  5. **The guard.** `strings-guard.mjs` fails CI on a new literal user-facing string in the
     covered packages (JSX text, and the string props of step 2), with an allow-list for brand
     names and file extensions. Coverage is ratcheted per package, as the React Compiler
     coverage is.
  6. **Locales.** English is the source. One second locale (German) ships in the repository,
     as the proof that the whole path works. Further locales are contributed catalogues.
     Pseudo-localisation (`?locale=qps`) makes missed strings and truncation visible in
     journeys.
  7. **Layout.** Long strings must not break the chrome. A journey runs the cockpit modes and
     the fill presets in pseudo-locale and checks for overflow in rails, menus and panel
     headers. Right-to-left languages are out of scope and recorded as such.
- **Tests.**
  - Unit tests for the catalogue merge, ICU formatting and fallback to English.
  - The strings guard in CI.
  - A pseudo-locale journey across modes and presets.
  - A DOM test per migrated package renders one panel in German.
- **Exit.** The guard covers every editor package and bundle, and the editor runs fully in
  German.

**ADRs.** Editor **280**, "The editor speaks through a string catalogue"; extensions **333**,
"Contribution titles may be message keys".

### E5 — Host components

- **Steps.** `registerComponent(id, render)`, where `render(view, root)` gets a read-only
  view (selection, field values, validity, role) and the handle's write methods. It mounts
  into a region item `{ kind: "host", id }` and is unmounted on dispose. It is framework-free
  (a DOM node), so a host does not need React.
- **Tests.** A DOM test with a host component that reads validity and calls `submit`.

### E6 — The iframe bridge

- **Files.** New `apps/canvas/src/embed/bridge.ts` (editor side) and
  `apps/editor/packages/editor/src/iframe/connect.ts` (host side, exported as
  `@paged-media/editor/iframe`). Also `apps/canvas/public/_headers` and the CSP writer in
  `vite.config.ts`.
- **Steps.**
  1. An `embed.html` entry (second `rollupOptions.input`) calls `mountEditor` with options
     received over the bridge. The ordinary `index.html` stays as is.
  2. The protocol is generated from the `EditorHandle` method list: `{ type: "paged:call",
id, method, args }`, answered by `paged:reply`; plus `paged:event`. `ArrayBuffer`s are
     transferred. Host actions are calls _from_ the editor _to_ the host, with the same
     shape reversed.
  3. Origins: an allow-list fixed at deploy time (`VITE_EMBED_ORIGINS`), checked on every
     message, plus `Content-Security-Policy: frame-ancestors <list>` for `embed.html` only.
  4. `connectEditor(iframe, config) → Promise<EditorHandle>` returns the same type as
     `createEditor`, with every method async.
  5. Retire `IframeScriptBridge` into the new bridge (`paged:run` becomes a method,
     `runScript`, available in dev and demo only), keeping the docs site's playground working.
- **Tests.**
  - A Playwright journey with a host page on a second origin embeds the editor, loads a
    template, sets fields, receives events, and handles an upload action.
  - A message from a foreign origin is ignored.

### E7 — The example host

- **Files.** New private `apps/editor/examples/embed-host` (Vite): `npm.html` uses
  `createEditor` (the host serves COOP/COEP), `iframe.html` uses `connectEditor` (no isolation
  headers).
- **Purpose.** The journeys of E2–E6 run against it. It is also the reference an embedder
  copies. It is not published.

### E8 — The package and its release

- **Files.** `apps/editor/packages/editor/package.json`, `vite.config.lib.ts`;
  `tooling/release/stage.mjs` (`PUBLIC_PACKAGES`), `verify-tarballs.mjs`, `consumer-test.sh`;
  `.github/workflows/release.yml`; `docs/adr/PM-0013-…`.
- **Steps.**
  1. Build in Vite library mode. It **bundles** every private dependency (shell, ui, client,
     tools, catalog, the module bundles, panel-kit, wasm-boot), because a public package may
     not depend on a private one (fact 18). React is a peer dependency (`>=19.3`, as for
     extensions). **Decided:** the engine wasm comes from `@paged-media/paged` as a regular
     dependency, so npm carries one copy of the engine and one version to keep in step. The
     editor's worker resolves the wasm from that package (as `apps/cli` already does through
     `resolveCanvasWasm`), with the `assetBase` override for hosts that move files.
  2. Wasm and workers ship as files in `dist/assets/`, resolved via `assetBase` (E1 step 7).
     Module wasm stays hosted where ADR 220 says. The `paged.data` bundle (DuckDB) is
     optional: excluded unless the profile names it, and fetched from the module host.
  3. Exports: `.` (`createEditor`, types), `./iframe` (`connectEditor`), `./presets` (preset
     data for host-side tooling), `./feature-ids.json`, `./style.css` only if E1 cannot scope
     everything.
  4. Release scripts: add the package to `PUBLIC_PACKAGES`, generalise the "three" checks,
     add consumer tests (import, `createEditor` type-checks under `nodenext` and `bundler`),
     add a size budget, and hold the version to the protocol like the others.
  5. Register the npm trusted publisher; the first publish uses the token path, as the PM
     record describes.
- **Exit.** `npm i @paged-media/editor` in a clean project, together with the example
  host's `npm.html` code, renders an editor.

### E9 — Embedding documentation

- `apps/editor/docs/embedding.md` (in-repo reference). The docs site picks it up through the
  existing docs dispatch. Contents: config, handle, host actions, presets, features (from the
  inventory, B3), roles and templates, theming tokens, CSP and isolation requirements, iframe
  setup.

**ADRs.**

- Editor **277**, "The editor mounts as an instance".
- Editor **278**, "Host actions are commands".
- Editor **279**, "The embedding API and the iframe bridge".
- **PM-0013**, "A fourth public package: `@paged-media/editor`", amending PM-0008.

---

## 9. Workstream F — Authoring and headless (concept §7.9, §9)

### F1 — The Template panel

- **Files.** `apps/canvas/src/panels/template/template-panel.tsx` (`paged.template`), shown
  for the `author` role only (feature predicate on role).
- **Steps.**
  1. Field list: name, kind, label, group and status (from tags, edited, or problems), plus
     Make field / Remove field on the selection.
  2. Editors for the field definition, constraints, extra permissions, and document defaults.
  3. Writes go through `SetPluginMetadata` with key `x-paged:template` and the envelope. Make
     field also sets the item's `Name` (`ItemName`) when it has none.
  4. Groups and order are edited by drag in the list.
- **Tests.** DOM tests for each editor. A journey makes a card template from a blank
  document, saves, reloads and finds the fields.

### F2 — Preview as filler

- **Steps.** A switch in the Template panel and the header sets the session role to `filler`
  and the profile to `template-fill` (E3's runtime switch), and switches back. The undo stack
  stays, and an author's edit can be undone after switching back (C4's exemption).
- **Tests.** A journey: author edits, previews, tries a forbidden move (refused), switches
  back, undoes.

### F3 — Template preflight

- **Files.** `paged-template/src/preflight.rs`, a findings collection, and the Problems panel
  (`apps/canvas/src/panels/problems-panel.tsx`) as the display.
- **Checks** (concept, §7.9):
  - fields without names, and duplicate names;
  - image fields not replaceable;
  - required fields inside hidden items;
  - fields on parent pages;
  - tags that match no frame, tags unreachable inside groups, and frames sharing a tag;
  - unresolved links.
- **Tests.** One fixture per finding.

### F4 — Author overlay

- D3's overlay draws all fields for the author, with problem markers from F3.

### F5 — Open as template

**Done (engine half and the command).** `RequestDerivedTemplateFields` / `OpenAsTemplate`
(one batch, author only); `paged.template.openAsTemplate` (File ▸ Open as template…) lists the
derived fields and the skipped tags for confirmation; `paged-node template ingest <doc> -o
<out>` runs the same messages. Not done: listing differences when re-deriving on a document
that already has a policy (the new fields are merged into it).

- **Steps.** A command `paged.template.openAsTemplate` (File menu) runs `derive_fields` (C9),
  shows the derived fields for confirmation, and writes the policy. On a document that already
  has a policy, it offers to re-derive from tags and lists the differences.
- **Tests.** A journey with the tagged fixture of C9.

### F6 — The CLI

- **Files.** `engine/core/crates/paged-cli/src/cli.rs` (a `Template` subcommand group, like
  `Library`), new `paged-cli/src/template.rs`, `main.rs` dispatch.
- **Subcommands.**
  - `template fields <doc> [--json]` reads the `TemplateFields` collection.
  - `template fill <template> --values <json> [-o out] [--format paged|idml|pdf]` uses
    `SetSessionPolicy(filler)`, then `SetTemplateFields`, then export. Refusals exit non-zero
    with the typed errors in JSON.
  - `template check --template <t> --filled <f> [--json]` works as follows:
    1. read the field values from `f`;
    2. fill `t` with them in a filler session;
    3. compare the result with `f`, canonicalised through the native serialisation.

    Any difference is a change outside the fields, reported by item and property. The
    template, not the submission, is the authority.

  - `template ingest <idml|paged> [--resolve <dir|url>] --out <dir>` runs `derive_fields`,
    resolves links, runs preflight, writes the policy, renders a preview and thumbnails per
    page, and writes `fields.json` and `preflight.json`.
- **`paged-node`.** Mirror the verbs in `apps/cli/src/verbs.ts` (one `Verb` each, appended to
  `VERBS`) over the same engine messages, so the npm `paged` bin has them too.
- **Tests.**
  - `paged-cli/tests/it/template.rs`: fill, refused fill, check catching a moved logo, check
    passing a clean fill, ingest of the tagged fixture.
  - `apps/cli/test/cli-template.spec.ts` and the CLI surface `covers()`.

### F7 — Server rendering

- `paged engine-serve`'s `POST /run` gains an optional `template: { values, role }`, applied
  before the script and export (`paged-cli/src/engine_serve.rs`, server ADR 953). Deployment
  of the container stays the server's own track.

### F8 — Catalogues

- **Files.** `modules/data` (bundle UI and `data-core` binding reuse).
- **Steps.** In the data panel, a template's fields are offered as binding targets. A
  `RecordFlow` with the template as its record template produces the catalogue
  ([data ADR 554](../../../modules/data/docs/adr/554-record-flow-pagination.md)). The filler
  permission for "change the product list" is a session override (`document.pages` allowed for
  flow-generated pages only), decided in the data ADR.
- **ADR.** `modules/data` **560**, "Template fields are binding targets".
- **Done** (2026-10-23): [data ADR 560](../../../modules/data/docs/adr/560-template-fields-are-binding-targets.md).
  The filler permission is a page policy rather than a session override: the engine asks
  `document.pages` of the page removed or duplicated (engine ADR 1000's amendment of
  2026-10-23), so a template that opens its catalogue page opens its copies and no other page.
  Typed commands `media.paged.data.templateFieldTargets`, `bindTemplateField` and
  `runCatalogue`.

---

## 9a. Workstream G — Every module in templates

Goal: a template may contain a module's frame (a sheet, a doc frame, a drawing, an edited
image, a slide, a web frame, a data-bound region), and its open parts are fields like any
other: listed in `templateFields`, filled through the form, the host and `paged template fill`,
checked by the policy. Every built-in module takes part: draw, image, sheet, doc, slide, web,
data and publish (pdf), each for the content it owns.

### G1 — The contract: module field kinds

- **Files.** `platform/extensions/packages/plugin-api/src/` (a `templateField` contribution on
  `host.contribute`), `plugin-sdk/src/host-impl.ts` and the headless harness; a plugin-sdk
  version bump.
- **Shape.** A module registers field kinds of its own:
  `{ kind: "media.paged.sheet.cell", describe(item, def) → FieldInfo, read(item, def) → value,
write(item, def, value) → outcome }`. A field definition names the module kind and its
  module-specific address inside the item (a cell, a range, a block id, a shape, a layer).
- **Writes** go through the module's usual door (`host.document.mutate`, the module's parts),
  so the engine's policy check holds: the item must grant the permission the kind declares
  (`text.edit`, `image.replace`, or a module permission mapped onto one).

### G2 — The editor and the CLI route module fields

- The template form shows module fields with the control their kind declares (text, number,
  choice, picture), the overlay outlines them, and `setTemplateFields` hands a module field's
  value to its module instead of the engine's lowering. `paged template fields | fill | check`
  load the bundles (as `apply` and `merge` already do) and route the same way.

### G3 — Each module's field kinds

| Module        | Field kinds (first set)                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| sheet         | a cell's value, a range's values (a table of data), a chart's series source                                        |
| doc           | a block's text (a heading, a paragraph), a list's items                                                            |
| draw          | a shape's fill or stroke from an allowed list, a text-on-path's text, a symbol choice                              |
| image         | the picture of an edited image frame (replace, keeping the adjustments), an adjustment preset from an allowed list |
| slide         | a placeholder's text, a slide's visibility                                                                         |
| web           | a web frame's source text or URL                                                                                   |
| data          | a binding's record (choose which record fills the region)                                                          |
| publish / pdf | an imported PDF page's choice of page                                                                              |

Each module ships its kinds, a DOM test over the form, and a CLI fill test, and its docs say
which of its parts can be fields. A module's own panels honour the session's role: a filler
sees the module's editing UI only for the parts its fields open.

### G3a — The field kinds in detail (from the module audits)

| Kind                                 | Definition                                      | Read and write                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `media.paged.sheet.cell`             | `{ ref }` (a named range or `Sheet!A1`), a type | the cell's `value` through the object model's write door; a list validation makes it a choice                                                   |
| `media.paged.sheet.range`            | `{ ref, columns?, rows: fixed or { max } }`     | `range.values`; a growable range inserts or deletes rows first                                                                                  |
| `media.paged.sheet.chartSource`      | `{ chart, allowed }`                            | the chart's series through `updateChart`                                                                                                        |
| `media.paged.doc.blockText`          | `{ frame, anchor }` (a bookmark or style + nth) | `block.text` planned like a merge field: the first run takes the text, the rest empty                                                           |
| `media.paged.doc.mergeField`         | `{ name }`                                      | `mergeField.value` (already writable)                                                                                                           |
| `media.paged.doc.listItems`          | `{ frame, anchor }`                             | needs list identity in the lowering and an insert that copies a paragraph's properties                                                          |
| `media.paged.draw.paint`             | `{ target, channel: fill or stroke, allowed }`  | the frame's fill or stroke, or the front layer of its appearance stack                                                                          |
| `media.paged.draw.graphicStyle`      | `{ targets, allowed }`                          | `appearance.graphicStyle`                                                                                                                       |
| `media.paged.draw.textOnPath`        | `{ path }`                                      | the attached story's text                                                                                                                       |
| `media.paged.draw.symbolChoice`      | `{ instance, allowed }`                         | re-place the instance with the chosen symbol in one batch                                                                                       |
| `media.paged.image.picture`          | `{ frame, layer }` (by layer name)              | `replaceLayerPixels`; adjustment layers above stay; reports a pending composite                                                                 |
| `media.paged.image.adjustmentPreset` | `{ frame, allowed: [{ name, rows }] }`          | creates or sets one named adjustment layer with the preset's rows                                                                               |
| `media.paged.image.layerVisibility`  | `{ frame, layer }`                              | `layer.visible`                                                                                                                                 |
| `media.paged.slide.placeholderText`  | `{ slide, placeholder: { type, idx } }`         | delegates to the engine's text lowering on the placeholder's story                                                                              |
| `media.paged.slide.visibility`       | `{ slide }`                                     | the slide's `hidden` flag; PDF export must skip hidden slides                                                                                   |
| `media.paged.web.value`              | `{ name }` (a `{{doc.key}}` value)              | `templateVar.value`: one field fills every web frame that uses it                                                                               |
| `media.paged.web.source`             | `{ frame, lane: html or css }`                  | `webFrame.html` or `.css`, sanitised on write                                                                                                   |
| `media.paged.web.cssVar`             | `{ frame, name, allowed }`                      | `cssVar.value`                                                                                                                                  |
| `media.paged.data.record`            | `{ query or binding, label }`                   | previews the chosen record; the choice must be persisted (it is in memory today)                                                                |
| `media.paged.data.bindingValue`      | `{ binding }`                                   | the control follows the binding kind; a write pins the value                                                                                    |
| `media.paged.data.dataSet`           | `{ allowed? }`                                  | applies a captured data set in one batch                                                                                                        |
| `media.paged.pdf.page`               | `{ frame?, allowed? }`                          | the frame's `framePdfPage`: a number from 1 to its `pdfPageCount`, or a choice of the `allowed` pages; grants `image.replace` (engine ADR 1003) |

Every write maps onto a core permission (`text.edit`, `image.replace`, `style.edit`,
visibility), so a module field is never a way around the policy. Template-level output
settings (a locked PDF standard, profile, bleed and marks) live in the template's own label
and are merged into `paged template fill` and the editor's export dialog for a filler.

### G4 — Module coverage: CLI, SDK and scripts

Audited per module: what the editor's UI can do that the Node CLI (`paged-node`), the Rust CLI,
the SDK (`host.objects` and typed commands) and scripts (`paged.*`) cannot. The shared gaps
first, since they unblock several modules at once:

1. **Bytes across JSON surfaces.** A typed command argument of kind `bytes` cannot be passed
   through `paged-node invoke` or a script. Accept `"@path"` (CLI) and `{ base64 }` (script
   bridge) for a `bytes` field, and write a `bytes` result to `-o`. Unblocks `importXlsx`,
   `placeDoc`, `importPptx`, `importPdf`, `importIdml`.
2. **An import path.** `paged-node` opens only `.paged` and `.idml`. Open any extension a loaded
   importer claims, and add `import <file>` for placing (SVG, raster, HTML, CSV).
3. **Per-module CLI tests.** No CLI spec loads draw, image, sheet or web; add one each.
4. **Headless rendering of module content.** Image composites with adjustments need a GPU and
   web frames are not stored as rendered content, so a headless PDF shows stale pixels or a
   fallback. Fail loudly (`pending` reported by `template check`), and bake web frames before
   export.
5. **The Rust CLI** has no plugin host; the module surface is `paged-node` only, and its docs say
   so.

Per module:

- **draw:** typed twins for the tool-only operations (knife, scissors, shape builder); a
  width-profile row; an update flag that rebuilds a recipe after its source changes.
- **image:** targeted crop, rotate, flip and canvas size; a typed `applyAdjustment`; filters with
  a region; the session-only commands refuse headless with a code instead of doing nothing.
- **sheet:** a placement kind (range, view, print, sizing) with `paginateToChain` and
  `placeName`; merge, borders, column widths and row heights; `importCsv`; chart delete.
- **data:** `apply` and `merge` rebased on typed commands (`importSource`); a batch verb per
  record or group; read-only inspection commands (preview, expression check, refresh diff).
- **doc:** the exporter works after reopening a saved document (today only in the importing
  session); `block.text` writable; table-cell runs; a heading kind; open standalone headless.
- **slide:** the typed `newSlide` places the layout's placeholders like the panel does; reorder
  and duplicate; a typed `exportPptx`; menus and commands.
- **web:** `importHtml`; turn an existing frame into a web frame; diagnostics as a row.
- **publish / pdf:** bookmarks and tagged PDF in the typed exporter; `template fill -o x.pdf` and
  `merge` through the typed exporter; a `preflight` command and verb; `paged-node package`.

## 9b. Workstream H — Demos

A demo gallery, built on the embedding API (E), deployed with the editor's demo build. Modelled
on what an embeddable editor's users expect to see:

- **Configured editors:** the full design editor; the focused module editors (draw, image,
  sheet, doc, slide, web, data); theming (light, dark, a partner's tokens); translation (English
  and German); a viewer.
- **Template editing:** design placeholders (a locked business card with fields); form-based
  template adoption (a postcard filled from a form beside a live preview); a custom host UI
  around the editor (host components, the actions bar, submit); a multi-page product (a
  photobook-style document whose picture fields fill page by page, with print checks); a
  template with module fields (a price list from a sheet, a doc text block, a drawing's colour).
- **Print and data:** print-ready PDF (PDF/X-4) with validation; automatic generation and batch
  (a set of cards from a data set, through `paged template fill` and the data module).
- **Embedding:** the same template through `createEditor` and through the iframe.

Each demo is one page under `apps/editor/apps/canvas/demos/`, listed on a gallery page, and
covered by a journey that opens it.

## 9c. Workstream I — Documentation and website

- The docs site (`paged-media/docs`): an "Embedding the editor" section (profiles, presets,
  features, roles, host actions, `createEditor` and the iframe), a "Templates" section (fields,
  policies, authoring in paged and in InDesign with tags, filling in the browser and with
  `paged template`, checking submissions, module fields), and the CLI reference for
  `paged template`.
- The website (`paged-media/website`): a page for the embeddable editor and template editing,
  linking the demos.

## 10. Milestones

| Milestone              | Contains          | An embedder or user can…                                                                                       |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| **M1** Profiles        | A1–A6             | start the editor as any preset by URL; presets replace solo; a chrome-less profile renders                     |
| **M2** Policy          | C1–C8, C11, B1–B3 | load a policy-bearing document in a filler session and have the engine refuse what it must, from every surface |
| **M3** Fill in-editor  | D1–D5, C9         | fill a template in the editor through canvas and form, and export a PDF                                        |
| **M4** Instance        | E1, E2            | mount the editor into any element, twice, with host save, upload and export                                    |
| **M5** Embed           | E3–E10, PM-0013   | `npm i @paged-media/editor` or an iframe; the full handle; a published release                                 |
| **M6** Author + server | F1–F8             | author templates (or open tagged InDesign files), preview as filler, fill, check and render on a server        |

M1 and M2 run in parallel (shell and engine), and E1 runs beside both. M3 needs M1 and M2.
M5 needs M3 and M4. M6's CLI part (F6) can start right after M2.

## 11. Testing strategy

| Tier             | What                                                                                                   | Where                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Rust unit        | policy resolution, envelopes, classifier exhaustiveness, field lowering, derive, preflight             | `paged-template`, `paged-mutate`                                                            |
| Rust integration | refusal per family, batches, undo exemption, parent pages, wire errors, gesture begin, hit filter      | `paged-mutate/tests/it/template_policy.rs`, `paged-canvas/tests/it/template_policy_wire.rs` |
| Round trip       | labels, names and policy through `.paged`, IDML, and (corpus, optional) InDesign                       | `idml-export/tests/it/template_policy_roundtrip.rs`                                         |
| Unit (TS)        | profile resolution and adjustment, feature store, handle methods                                       | `packages/shell/test/profile`, `test/features`, `packages/editor/test`                      |
| DOM              | regions, region items, feature gates per surface, form, Template panel, host actions, strings          | `packages/shell/test/*`, `apps/canvas/test/panels/*`                                        |
| Op sandwich      | `setTemplateFields` per kind: model, pixels, undo                                                      | `apps/canvas/tests/e2e/template-ops.spec.ts`, `capabilities.ts`                             |
| Journey          | solo unchanged, presets, fill via canvas and form, preview as filler, two editors per page, embed host | `apps/canvas/tests/journey/focused/*`, example host journeys                                |
| CLI              | fill, check, ingest                                                                                    | `paged-cli/tests/it/template.rs`, `apps/cli/test/cli-template.spec.ts`                      |
| Release          | tarball rules, consumer install, size budget                                                           | `tooling/release/*`                                                                         |

Every new surface id is covered at its required tier (ADR 227). A refusal path is tested from
the canvas, a script (`paged.*`) and a plugin, because "every caller" is the claim.

## 12. ADR ledger and numbering

| Record                                                                   | Range        | Number  | Lands with |
| ------------------------------------------------------------------------ | ------------ | ------- | ---------- |
| The editor profile is runtime data (amends 213)                          | editor       | 274     | A4         |
| Features gate what is offered                                            | editor       | 275     | B2         |
| Filling a template                                                       | editor       | 276     | D5         |
| The editor mounts as an instance                                         | editor       | 277     | E1         |
| Host actions are commands                                                | editor       | 278     | E2         |
| The embedding API and the iframe bridge                                  | editor       | 279     | E6         |
| The editor speaks through a string catalogue                             | editor       | 280     | E10        |
| Contribution titles may be message keys                                  | extensions   | 333     | E10        |
| The engine's ADR range                                                   | repository   | PM-0012 | before C1  |
| A template policy lives in labels, and operations are checked against it | engine       | 1000    | C1, C3, C4 |
| The session has a role; three doors; typed refusals                      | engine       | 1001    | C2, C5, C6 |
| The XML structure is model data and is written                           | engine       | 1002    | C10        |
| Template fields are binding targets                                      | modules/data | 560     | F8         |
| A fourth public package                                                  | repository   | PM-0013 | E8         |

**Decided:** the engine gets a new, non-overlapping range, set by **PM-0012** before C1 lands.
The proposed range is 1000–1099; no record in the repository uses a four-digit number today.
PM-0012 also records the existing collision of engine 200–209 with editor 200–209 and states
that those records keep their numbers, cited with their component ("core ADR 205").

## 13. Risks

| Risk                                                                  | Effect                                         | Mitigation                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1 is broad: dozens of singletons and global listeners                | long-running branch, regressions in the editor | behaviour-neutral steps on `main`, the instance guard script, full journeys per step; start in M1's time frame               |
| A permission gap: a write path that bypasses all three doors          | a filler can change what the template forbids  | exhaustive classifier; a test per wire `Mutation` kind in a filler session; server-side `template check` as the backstop     |
| Text-path enforcement needs story→frame resolution on every keystroke | typing latency                                 | cache the story→field map in `PolicyIndex`; measure with the existing perf lane before and after                             |
| Constraint checks that need layout (overset, shrink)                  | slow sets, layout re-entrancy                  | run after apply inside the batch; `shrink` bounded in steps; benchmark on long stories                                       |
| Package size: bundling every module                                   | slow first load for embedders                  | profile-driven bundle loading (ADR 222), DuckDB excluded by default, a size budget in the release checks                     |
| Surface ids become a public contract                                  | renames break hosts                            | the feature-id inventory (B3) with deprecation aliases; a check that a removed id is listed as deprecated for one release    |
| Cross-origin isolation for npm hosts                                  | partners cannot set COOP/COEP                  | the iframe path; document `credentialless` COEP; open question in the concept                                                |
| The XML writer (C10) changes exported packages                        | InDesign rejects or alters a written structure | unchanged imports keep the byte-identical copy path; the corpus round-trip lane; the writer follows InDesign 20's own output |
| Whole-editor string extraction (E10) touches nearly every file        | long tail, merge conflicts with feature work   | codemod per package, one commit each; the ratcheting guard; extraction scheduled per cockpit mode                            |
| Protocol churn                                                        | rebuilds and lockfile bumps for every consumer | batch wire changes (C2+C6+C8 in at most two bumps)                                                                           |

## 14. Decisions

Taken on 2026-10-21:

1. **Engine ADR numbering:** a new non-overlapping engine range, set by PM-0012 (proposed
   1000–1099), before C1 (§12).
2. **Engine wasm for `@paged-media/editor`:** a dependency on `@paged-media/paged`, not an
   inlined copy (E8).
3. **Tagged text ranges:** converted to a placeholder run when a file is opened as a template
   (C9).
4. **Writing XML tags on export:** yes, in this project (C10).
5. **The `editor` role and the policy:** only `author` writes the template policy by default;
   a host may allow it for an editor session through an override (C7).
6. **Strings:** the whole editor and its bundles, in this project (E10).
