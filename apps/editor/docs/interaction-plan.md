# The interaction contract — Implementation plan

November 2026. Companion to the
[interaction specification](specs/ideas/paged_interaction_specification.md)
(`PM-UX-INTERACTION-001`, cited here as "the spec, §n") and the
[UX/UI redesign strategy](specs/ideas/paged_ux_ui_redesign_strategy.md) ("the strategy, §n"),
which [ADR 1200](adr/1200-the-interaction-contract-is-adopted.md) adopts, with the decisions of
[ADR 1201](adr/1201-interaction-decisions.md). This plan says **what is built, where, in which
order, and how each step is proven**. When code lands, ADRs record the decisions and
[`status.md`](status.md) records what ships. This plan is then amended or retired; it never
overrides either.

Paths are relative to the repository root, shortened by these abbreviations:

| Abbreviation | Path                                          |
| ------------ | --------------------------------------------- |
| SH           | `apps/editor/packages/shell/src`              |
| CV           | `apps/editor/apps/canvas/src`                 |
| UI           | `apps/editor/packages/ui/src`                 |
| ENG          | `engine/core/crates/paged-canvas/src`         |
| VC           | `CV/ui/ViewportCanvas.tsx`                    |
| TESTS        | `apps/editor/apps/canvas/tests`               |
| SCRIPTS      | `apps/editor/scripts`                         |
| SDK          | `platform/extensions/packages/plugin-sdk/src` |

Line numbers are as of the plan's date and serve as orientation only. `T07` is short for the
spec's test `UXI-T07`; `F-nn` is a finding of the October UX audit
([`design/ux-audit-2026-10.md`](design/ux-audit-2026-10.md)); `GF-n` and `GT-n` are findings of
[`reference/gestures.md`](reference/gestures.md).

---

## 0. How to read this plan

- **Wave 0** (§3) lands first: the decisions, the inventory, the coverage report and the test
  harness every later task relies on.
- **Tracks** (§4–§12) group the work by where it lives: keyboard and focus (KF), the interaction
  core (IC), the engine and the protocol (EN), the workspace and the camera (WS), documents,
  files and feedback (DF), fields, the inspector and commands (FI), contexts and modules (CM),
  accessibility, devices and performance (AP), and the strategy's Phase 3 concepts (PX).
- **Tasks** inside a track have ids (`KF1`, `IC4`, …). Each names what it builds, the files it
  touches, the tests that prove it, and the findings it closes. A task is one or a few commits,
  each green on its own gates.
- **Phases** (§13) cut across tracks and give the order; §14 says how each step is proven and
  which gate it raises.
- **§1 lists facts in the code the plan is built around.** Read it before any task.

## 0a. Progress (2026-11-13)

| Part                                                                                                                                                        | State                                                                                                                                                                                                                                                                                                    | Where                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| W0.1 the two documents                                                                                                                                      | Done: stored as written                                                                                                                                                                                                                                                                                  | `apps/editor/docs/specs/ideas/`                        |
| W0.2 the ADR ranges                                                                                                                                         | Done                                                                                                                                                                                                                                                                                                     | PM-0019 (editor 1200–1299), PM-0020 (engine 1300–1399) |
| W0.3 adoption and decisions                                                                                                                                 | Done: adopted and decided, nothing implemented                                                                                                                                                                                                                                                           | ADR 1200, ADR 1201                                     |
| W0.8 this plan and the status block                                                                                                                         | Done                                                                                                                                                                                                                                                                                                     | this file, `status.md`                                 |
| W0.4–W0.7 inventory, coverage report, harness, baseline                                                                                                     | In progress                                                                                                                                                                                                                                                                                              | §3                                                     |
| EN1–EN4, the engine and protocol 79                                                                                                                         | Done: a gesture holds the document; the marquee's mode, scope and canvas rectangle; snap hysteresis, current zoom, ranking and target kinds; the live duplicate preview                                                                                                                                  | §6; engine ADR 1300, amendments to 125, 193, 1011      |
| EN5–EN8, the engine and protocol 80                                                                                                                         | Done: the edit scope; losses on load and export; the press in one call; coalesced writes; copies all or nothing and paths following their box (GF-5, GF-6)                                                                                                                                               | §6; engine ADRs 1301–1305, amendment 2 to 193          |
| IC1–IC8 the coordinator, the terminal events, the stale guards, the adapters, the press in one call, the selection model, the geometry pressed, named snaps | Done; the coordinator is the one pointer path (the legacy path removed)                                                                                                                                                                                                                                  | ADR 1210                                               |
| CM1–CM4 contexts and modules                                                                                                                                | Done: one exit resolver over each module's `exitPolicy`, the resolve prompt, the stack as a reducer with an effect queue, the edit scope; Frame · Content · Edit (D-05); the trail in the fixed context toolbar; the module conformance suite; G2 enforced                                               | editor ADRs 1214, 1215; extensions ADR 1106            |
| DF1–DF9, documents, files and feedback                                                                                                                      | Done: save status, recovery, drop intent, compatibility report, new document, guided export, issues on the page, operation feedback, clipboard order; F-06 continuity                                                                                                                                    | ADRs 1203–1205, 1219–1224, 231 (amended)               |
| AP1–AP5 accessibility, devices, performance                                                                                                                 | Done: the object tree, keyboard-only inserts and transforms, the selection cycle, AA tokens, high contrast, axe, 200 % zoom; pen pressure for pens only, the pinch over a pending press; the performance budgets, a progressive CPU render, typing folded, the nightly suite (decoded images: `EXC-003`) | ADR 1230, ADR 1231, ADR 1232                           |
| Tracks KF, IC, EN, WS, DF, FI, CM, AP, PX                                                                                                                   | Not started                                                                                                                                                                                                                                                                                              | §4–§12                                                 |

## 1. Facts in the code that shape the plan

Read from the code on 2026-11-13. Each one changes a task.

**Pointer and gestures.**

1. **No single owner holds a pointer sequence.** VC keeps six gesture refs of its own beside the
   gesture spine (`SH/tools/gesture-spine.ts`), and three controllers claim the pointer through
   window capture: `SH/cockpit/canvas-frame/GuideDragController.tsx`,
   `SH/cockpit/canvas-frame/ThreadingController.tsx` and `SH/state/pending-placement.ts`.
2. **A lost capture ends nothing.** `lostpointercapture` and unmount are not handled, so an
   engine gesture can stay open; the next drag gets `AlreadyActive` and falls back to a pan
   (VC:639-645).
3. **Hit tests carry no epoch.** A click, a double-click (VC:1022, 1430-1475, 1696-1788) and the
   context menu (`CV/canvas-context-menu.tsx:102-135`) apply the reply whenever it comes. The
   client's `seq` already correlates replies; no engine change is needed to guard them.
4. **The spring-load has one slot.** The gesture spine keeps one `current` handler
   (`gesture-spine.ts:37`); holding Space swaps it, which deactivates a drawing tool mid-drag.
5. **Duplicate-drag disagrees with its preview.** The modifiers are read at different times for
   preview and commit (`ENG/gesture.rs:761-981`, VC:1060); GF-2 and GF-3 fail at commit.

**Keys and focus.**

6. **About ten listeners answer Escape, in no order:** `SH/state/edit-context-controller.tsx:160-166`,
   `CV/ui/useTextEditing.ts:281`, `GuideDragController.tsx:420`, `ThreadingController.tsx:538`,
   `pending-placement.ts:196`, `CV/panels/canvas-panel.tsx:303`, and more in VC, the gesture
   spine's bridge and path editing. One press can cancel a drag and climb a group.
7. **Tab hides the chrome** on a canvas the user clicked into (ADR 234;
   `SH/PagedShell.tsx:707-725`, `:810-845`, `SH/focus/canvas-surface.ts`), through the public
   ids `paged.chrome.toggleAll` and `paged.chrome.togglePanels`.
8. **Issue #32:** Escape in the command palette does not restore focus on real Chrome with a GPU;
   `TESTS/journey/focused/command-palette.journey.spec.ts:28-29` works around it.

**Contexts.**

9. **An edit context ends three ways with three meanings:** Escape cancels, a press outside
   commits (VC:709-721), the breadcrumb pops. `SH/state/edit-context-stack.tsx` runs the
   context's hooks inside `setStack` updaters, and `isInScope` recognises the entered root only
   (`:306-319`).

**Selection and geometry.**

10. **Shift adds, Cmd toggles** (`CV/panels/canvas-panel.tsx:318-322`); the marquee takes what it
    intersects, in either direction, page by page (`ENG/hit.rs`, `marquee_hits`). A click and a
    marquee pick group members differently (`canvas-panel.tsx:340-343`, `:443-465`). There is no
    hover preselection.
11. **The body hit is not the oriented box** (VC:2301-2339); resize cursors ignore rotation
    (`SH/overlays/resize-handles.tsx:124-131`). Cursors are written in many places
    (`SH/tools/cursor.ts` is one).
12. **Snapping has no hysteresis and no target labels** (`ENG/snap.rs`, whose header is stale);
    its bypass key is Ctrl in one path and Cmd in another
    (`apps/editor/packages/tools/src/handlers/snapper.ts:32-33`).

**Camera and workspace.**

13. **The camera keeps no anchor** when a dock resizes, ignores reduced motion
    (`CV/ui/useAnimatedCamera.ts`) and keeps no navigation history. The current page is computed
    in four places. Two inputs still carry zoom bounds of their own (VC:1403, `CV/ui/layout.ts:147`),
    and 100 % is one point per CSS pixel.
14. **The docks are fixed** at 262 and 320 px (`SH/cockpit/CockpitLayout.tsx`); there is no
    density setting. Drop handling lives inside the layout (`CockpitLayout.tsx:168-193`).

**Fields and documents.**

15. **Numeric fields are six components** (NumberInput, LengthInput, BoundsInput, SmartDialMicro,
    the catalogue's leaves, the control bar's NumField) **and 78 raw `type="number"` inputs.**
    Units are parsed in `UI/inputs/document-unit.ts:131-143`; there are no expressions.
16. **The save state is dirty or saved** (`CV/app/mount.tsx:820-890`); there is no autosave and
    no crash recovery. A drop shows no intent (`CV/insert-commands.ts:946-963`). The IDML `lost`
    list is dropped at `client.exportIdml` (`apps/editor/packages/client/src/client.ts:1374`);
    there is no import report. New document has no dialog.
17. **29 of the 57 findings** of the October UX audit are open.
18. **ADR ranges:** the editor's 200–299 was full and its records overflowed into the extensions'
    300–349 (300, 301, 303–315); the engine reached 1099. PM-0019 and PM-0020 give both a new
    range.

## 2. Rules that hold for every task

- **Gates.** Before each push: the workflows of the affected projects
  (`moon ci --base origin/main --head HEAD` lists them), `tooling/js/fmt.sh --check` and
  `tooling/js/bun-canary.sh lint`. The full suites run in CI; locally, the formatter, lint, the
  targeted tests and the wasm build those tests need. `main` stays green, workflow by workflow.
- **Tests.** A test names its scenario in its title (`UXI-T07 — …`, with `@uxi:` tags for further
  ids; a Rust test `uxi_t60_*`) and asserts the model and the undo history (`modelSnapshot`,
  `undoDepth`), never a screenshot alone (ADR 1200). `covers()` names real surface ids only
  (ADR 227).
- **Parity.** A migrated path keeps its model, undo and render outcomes, compared on recorded
  pointer tapes (`UXI-MIG-001`); only the TARGET CHANGEs of ADR 1201 differ.
- **One owner.** Every new owner (the coordinator, the Escape arbiter, the cursor controller, the
  numeric field) comes with a single-owner rule (`tooling/single-owner.json`, PM-0017) whose
  baseline only shrinks. No legacy handler stays active beside a new owner of the same event
  class (`UXI-MIG-002`).
- **Instances.** State is per editor instance (ADR 277, `SCRIPTS/instance-guard.mjs`): the
  coordinator, the arbiter, the cursor controller and the recovery journal included.
- **Settings.** A new stored setting (the Tab preference, dock widths, density, …) is claimed in
  `SCRIPTS/settings-inventory.json` and read with a shape check (ADR 247).
- **Contract.** An edit under `platform/extensions/packages/{plugin-api,plugin-sdk}/src` bumps the
  plugin-sdk canary and plugin-api's with it. This plan touches the contract in W0.6, IC10, CM2,
  FI1, FI4 and DF8, batched into at most two canaries per phase.
- **Protocol.** A wire change bumps `PROTOCOL_VERSION` (`ENG/channel.rs`, 78 today), updates the
  package versions and `bun.lock`, and lands with the editor change that consumes it. EN groups
  its changes into two versions: EN1–EN4, then EN5–EN8.
- **React.** New components compile under the React Compiler; registries are read through
  `useRegistryView`, stores through `useLive`; no new `useMemo` or `useCallback`.
- **Dependencies.** A new dependency (`@axe-core/playwright` in AP1) passes the supply-chain and
  licence checks (PM-0011).
- **Exceptions.** A gap that stays is an entry in the inventory's `exceptions` with its contract
  ids, why, an issue, an owner, a severity and an expiry (`UXI-MIG-004`). Scope is never dropped
  silently.
- **ADRs.** A decision is recorded when it lands: editor records in 1200–1299, engine records in
  1300–1399, contract records in the extensions' 1100–1199.
- **Public repository.** No private paths, no private corpus names, no names of people, no
  business terms.

---

## 3. Wave 0 — documents, decisions, inventory, coverage, harness

Lands before the tracks. Exit: PM-0019, PM-0020, ADR 1200 and ADR 1201 on `main`; the inventory
guard and the coverage report run in CI (report mode).

- **W0.1 The documents.** Both are stored in `apps/editor/docs/specs/ideas/`, kept as written,
  with an entry in [`README.md`](README.md). Their adoption is recorded in ADR 1200, not in them.
- **W0.2 The ADR ranges.** PM-0019 (the editor continues at 1200–1299; 200–299 and 300–315 keep
  their numbers, the collision with the extensions' 300–315 recorded) and PM-0020 (the engine
  continues at 1300–1399), with rows in `docs/adr/README.md` and the range notes of the
  component READMEs.
- **W0.3 ADR 1200 and ADR 1201.** The adoption (TARGET CHANGEs, the one exception ledger, no
  screenshot-only gate, the strategy as direction) and the decisions D-01…D-16 with the Escape
  order, amending ADRs 234, 235, 246, 250 and 282. Later records are written as each task lands.
- **W0.4 The interaction inventory.** `SCRIPTS/interaction-inventory.json` with its schema and a
  guard, `SCRIPTS/interaction-inventory.mjs`. Sections: `requirements` (the spec's ids, kept in
  sync), `tests` (T01–T76 with group, gate, fixture, layers and requirements), `interactions`
  (owner from `SH/interaction/owners.ts`, adapter, states, permission, cancel, real `surfaceIds`
  checked against `SCRIPTS/surface/enumerate.mjs`, status `legacy`, `migrated` or `exception`),
  `exceptions` (the one ledger: contract ids, why, issue, owner, severity, expiry) and
  `enforcedGates`. The guard fails on an id that does not resolve, an expired exception, two
  owners for one event class (`UXI-MIG-002`), and a count below its floor.
- **W0.5 The coverage report.** `SCRIPTS/uxi-coverage.mjs`, reusing the walk and layer
  attribution of `SCRIPTS/surface/covers-reader.mjs`: tests claim scenarios in their titles,
  `covers()` stays for surface ids. A two-way ratchet against `SCRIPTS/uxi-acknowledged.json`
  (a test that starts passing must be un-acknowledged; a scenario without a test must be
  acknowledged with its target task). `--summary`, `--json`, `--gate`; two steps in the
  `surface` job of `.github/workflows/editor-tests.yml`.
- **W0.6 The harness** (`TESTS/e2e/harness/`): `history.ts` (`undoDepth` through
  `client.undoLog()`, `expectHistoryUnchanged`); `modelSnapshot` and `selectionSnapshot` in
  `model-dump.ts`; `chaos.ts` (fixture H: the client's `delayReply` and `reorder` hooks, present
  only under the `chaos` flag of `CV/debug-flags.ts`, reached as `__chaos` in
  `CV/app/dev-handles.ts`); `interaction.ts` (the spec's §23.3 helpers, and
  `data-gesture-preview` on transient overlay layers); `two-instances.ts` (fixture G);
  `uxi-fixtures.ts` with fixtures A–F built by `build-min-idml.ts` and described in
  `FIXTURES.md`. `SDK/gesture-invariants.ts` gains `checkLiveness` (INV-8) and
  `checkNoInterleave` (INV-7), one canary.
- **W0.7 The baseline.** Pointer-tape goldens in `TESTS/e2e/tapes/` for the legacy Select, Text,
  Hand and Zoom paths (the parity reference of `UXI-MIG-001`); the T-tests that already pass are
  written; the rest are acknowledged with their target task.
- **W0.8 This plan** and the status block in [`status.md`](status.md).

---

## 4. Track KF — Keyboard and focus authority (spec wave 1)

- **KF1 The Escape arbiter.** `SH/interaction/escape-arbiter.ts`: one capture listener per
  editor root through `listenForEditorKeys` (`SH/state/editor-root.tsx`), with prioritised
  handlers in the order of the spec's §12.1. The shell's Escape listeners move onto it
  (`edit-context-controller.tsx:160-166`, `CV/ui/useTextEditing.ts:281`,
  `GuideDragController.tsx:420`, `ThreadingController.tsx:538`, `pending-placement.ts:196`,
  `canvas-panel.tsx:303`); VC's, the gesture spine's and path editing's follow in IC4. A
  single-owner rule `escape-listener`. Tests: T30, T31.
- **KF2 Raw window key listeners** go through `ownsEvent` (ADR 277); a single-owner rule
  `raw-window-key-listener`. Tests: T33.
- **KF3 The chrome toggle (D-03).** The command `paged.view.toggleChrome` with Cmd/Ctrl+\\, the
  preference "Tab hides panels (InDesign)" (off by default, claimed in the settings inventory),
  and `paged.chrome.toggleAll` kept as a deprecated alias (`SCRIPTS/feature-ids.mjs`). Files:
  `SH/focus/canvas-surface.ts`, `SH/PagedShell.tsx:707-725`, `:810-845`, `CV/app-commands.ts`.
  Tests: T19.
- **KF4 Text input.** A composition session token for the IME, and `caretScreenBox` through the
  full camera transform, rotation included (`CV/ui/TextInputSurface.tsx`,
  `CV/ui/useTextEditing.ts`). Tests: T21, T22, T32.
- **KF5 Focus return (D-11).** `SH/focus/focus-return.ts` for the palette, menus and dialogs;
  fixes issue #32 and removes the workaround in `command-palette.journey.spec.ts:28-29`. Tests:
  T23 (local evidence on real Chrome with a GPU), T24, T34.
- **KF6 Key precedence.** Enter, Tab, Backspace and the arrows in the spec's §12.2–§12.4 order
  (`SH/focus/key-ownership.ts:219-236`); type-tool shortcuts. Tests: T20, T25–T28, T76. Closes
  F-34.

## 5. Track IC — The interaction core (spec waves 2 and 3)

IC is sequential: one change at a time touches VC.

- **IC1 The coordinator.** `SH/interaction/{coordinator,owners,epochs,trace}.ts` and an
  `InteractionProvider` in `SH/PagedShell.tsx`: per-instance sessions
  `{id, epoch, docRev, camRev, AbortSignal}`; `begin`, `end`, `abortAll`, `guard`, `whenIdle`;
  the spec's §3.4 owner table as data; a development trace ring buffer, `__interaction`, that
  records no user text. Behind the debug flag `coordinator`; one CI shard runs the UXI specs
  with it on.
- **IC2 Terminal events.** `pointercancel`, `lostpointercapture` (new), blur,
  `visibilitychange`, unmount, document switch and tool switch call `abortAll`. The orphan
  fallback (`AlreadyActive` → pan, VC:639-645) goes; Escape cancels a marquee or a press and never
  switches to pan (VC:1562-1592). Tests: T07–T10, T16, T61.
- **IC3 Stale guards** around VC:1022, 1430-1475, 1696-1788 and
  `CV/canvas-context-menu.tsx:102-135`, on the client's `seq`. Tests: T57, T59.
- **IC4 The adapters** (no rewrite; the spec's §24.2). `LegacySelectionAdapter` (VC's select,
  marquee and press); `RegisteredGestureAdapter` (the gesture spine gets a suspend and resume
  stack, and a rectangle clears its preview on suspend); `CameraNavigationAdapter` (a live
  `forcePan`, the deferral of D-09); `ContentContextAdapter` (one double-click path, through
  `SH/state/use-edit-context-entry.tsx`); `OverlayRevisionAdapter` (`SH/overlays/overlay-host.tsx`
  drops a contribution of a stale revision). The threading, pending-placement and guide-drag
  controllers become sessions; VC's six refs are replaced; the remaining Escape listeners (VC,
  the gesture spine's bridge, path editing) join the arbiter. The flag defaults on once the
  `UXI-MIG-001` tapes match. Tests: T01, T02, T05, T06, T10, T52, T71.
- **IC5 Drag before the hit.** Feedback starts from the down point with EN7. Tests: T58.
- **IC6 The selection model (D-01, D-15).** Shift toggles; the directional, scoped marquee over
  EN2; one group rule for a click and a marquee (`canvas-panel.tsx:340-343`, `:443-465`); hover
  preselection (`SH/overlays/hover-preselect.tsx`); an object picker and a cycle command; group
  promotion in the context menu; the locked indication (D-08). The legacy path is removed
  (`UXI-MIG-002`). Tests: T03, T04, T13, T29.
- **IC7 Handles and geometry.** The oriented-box body hit (VC:2301-2339), rotation-aware resize
  cursors (`SH/overlays/resize-handles.tsx:124-131`), zoom-stable tolerances, rotate zones, guides
  through the full transform. Tests: T11, T14, T15, T56.
- **IC8 Snapping.** Target-kind labels and spacing (`SH/overlays/snap-lines.tsx`) over EN3; one
  bypass key (`apps/editor/packages/tools/src/handlers/snapper.ts:32-33`). Tests: T12.
- **IC9 The cursor contract.** `SH/tools/cursor.ts` becomes a `CursorController` with one write
  site; a single-owner rule `cursor-write`.
- **IC10 Modifier hints.** `SH/overlays/modifier-hints.tsx`; `modifierHints` on gesture handlers
  (contract, canary).
- **IC11 Pen and path.** The Pen stays the Pen after closing a path; deleting points is one undo
  step. Tests: T17, T18. Closes F-35.

## 6. Track EN — Engine and protocol

Two protocol versions: EN1–EN4 in the first, EN5–EN8 in the second. Engine records in
1300–1399.

- **EN1 No interleaving (INV-7).** Mutations and script operations are refused with
  `GestureInProgress` while a gesture is active (`ENG/model.rs`, `ENG/channel.rs`); the client
  runs scripts through `coordinator.whenIdle()`. Tests: T60. **Done** (protocol 79, engine ADR 1300): the client orders its own writes after its gesture and offers `whenGestureIdle()` for the coordinator; `GestureInProgressError`.
- **EN2 The marquee query** takes `{mode: Contain | Intersect, scope}` and covers the spread's
  pages and the pasteboard (`ENG/hit.rs`). **Done** (protocol 79, engine ADR 1011 amendment 1): the rectangle is on the canvas, across spreads too; `scope` is `document` or `group`; the editor adopts it in IC6.
- **EN3 Snap hysteresis**: acquire at 4 and release at 6 CSS px, tolerance at the current scale,
  a `target_kind` on each snap; the stale header fixed (`ENG/snap.rs`). Tests: T12. **Done** (protocol 79, engine ADR 125 amendment 2), with margins and columns as targets.
- **EN4 Live duplicate (D-02)**: the modifiers at begin and update decide, and the commit equals
  the last preview (`ENG/gesture.rs:761-981`, VC:1060). Tests: T06, T11. Closes GF-2, GF-3. **Done** (protocol 79, engine ADR 193 amendment 1).
- **EN5 The scope query** `scopeContains(root, ids)`, answered per document revision, for
  `SH/state/edit-context-stack.tsx:306-319`. Tests: T44. **Done** (protocol 80, engine ADR 1301): `RequestScopeContains`; the client's `scopeContains` and `editScope` (a synchronous `contains`, cached until the document changes); CM1 wires `isInScope` to it.
- **EN6 Losses reach the editor.** `exportIdml` returns `{bytes, lost}`
  (`apps/editor/packages/client/src/client.ts:1374`); an IDML import reports its `LossEntry[]`
  on load. **Done** (protocol 80, engine ADR 1305): `exportIdml` answers `{ bytes, lost, links }`; `DocumentHandle.losses` (`idml.import.<what>`); the publish module's IDML diagnostics carry items and pages; DF4 builds the report.
- **EN7 Atomic begin.** `beginGestureAt {point, modifiers, selectPolicy}`, one round trip.
  Tests: T58. **Done** (protocol 80, engine ADR 1303): hit, selection (`replace`, `toggle`, `keep`), target rule and scope, gesture begin; IC5 adopts it in VC.
- **EN8 Undo coalescing.** A coalesce key, so an inspector scrub is one undo step (ADR 253 holds
  per action). **Done** (protocol 80, engine ADR 1304): `mutate(op, { coalesce })` and `endCoalesce()`; FI1 scrubs with it.
- **EN fuzz findings** at `PAGED_GESTURE_FUZZ_N=200`: GF-5 (seeds 48, 141, 155, an Alt-drag across spreads) and GF-6 (seed 31, a resized path's copy moved on save → load) fixed by engine ADR 1302; the seeds replay as regression tests.

## 7. Track WS — Workspace and camera (the strategy's Phase 1 workspace; the spec's CAM)

WS0–WS7 landed on 2026-11-13 ([ADR 1208](adr/1208-docks-are-resizable-and-the-workspace-adapts.md),
[ADR 1209](adr/1209-density-presets.md)). Two choices the bullets below leave open: the classes
are measured on the cockpit's own element against canvas budgets beside the default docks (about
1575 / 1095 px of window with the editor's rails), and the browser suite boots with the adaptive
workspace off (its window is 1280 px) unless a spec is about the workspace.

- **WS0** Drop handling moves out of `SH/cockpit/CockpitLayout.tsx:168-193` into
  `SH/cockpit/drop-zone.tsx`; DF3 owns it from there.
- **WS1 Resizable docks**, 240–480 px, double-click to reset, widths per mode
  (`CockpitLayout.tsx`, new `DockSplitter.tsx` and `dock-sizing.ts`, `cockpit-persistence.ts`),
  `role="separator"` with the arrow keys.
- **WS2 An adaptive workspace** by usable canvas width: from 1600 px docked, 1100–1599 px rails
  and flyouts, narrower overlays (`SH/cockpit/workspace-class.ts`, with `SH/state/compact.ts`).
  Closes F-55.
- **WS3 A camera anchor on resize** (`SH/state/camera-context.tsx`, VC's `ResizeObserver`).
  Tests: T50. Lands before IC4.
- **WS4** The Focus workspace command, merged with the Focus pill and KF3.
- **WS5 Density presets** through `[data-density]` tokens (`SH/styles/theme.css`; hard-coded
  chrome heights become tokens; `apps/editor/docs/theme-tokens.json` regenerated).
- **WS6 The header.** A save-status slot, a quieter Share, placeholder modes hidden, the
  development HUD behind a debug flag (VC:2149), the Window menu's taxonomy, naming. Closes
  F-17, F-18, F-21, F-23, F-24.
- **WS7 Progressive loading.** Stages, a first-page fit, a `LoadingState` consumer. Tests: T49.
  Closes F-53.
- **WS8 Zoom and navigation (D-12).** One zoom range (the bounds at VC:1403 and
  `CV/ui/layout.ts:147` go), 100 % kept as a camera scale of 1, Actual size (an inch as 96 CSS px) and a calibrated size as named views, reduced motion
  (`CV/ui/useAnimatedCamera.ts`), navigation history (back and forward), an editable
  `ZoomField` with a fit menu and Actual size, and one `SH/state/current-page.ts` in place of four
  computations. Tests: T47, T48, T53, T54. Closes F-52. **Done**
  ([ADR 1211](adr/1211-navigation-history-and-one-current-page.md)): the history lives in the camera
  context and records explicit navigations only; Go back / Go forward are InDesign's
  Cmd/Ctrl+PageUp / PageDown; the field is the shell's `ZoomControl`; the calibration is
  `paged.view.calibration` in device pixels per inch; T55's navigation half is claimed (DF7 adds the
  issue markers). The Zoom tool's `zoomAt(…, 0.01, 64)` and the developer readout's page in VC are
  left to IC (the bounds are ignored already).
- **WS9 Editing aids.** One control for frame edges, margins, guides, the baseline grid, threads,
  overset, hidden characters and non-printing items, and a Proof view
  (`SH/state/view-toggles.ts`). **Done** ([ADR 1212](adr/1212-editing-aids-and-proof-view.md)):
  the overlay host applies one rule (`SH/state/editing-aids.ts`); Proof view is the Preview screen
  mode completed; hidden characters and nonprinting items wait for engine view options (recorded
  there).
- **WS10 Page lenses** (Pages, Structure, Layers, Issues, Data) and semantic zoom. Closes F-57.
  **Done** ([ADR 1213](adr/1213-page-lenses-and-semantic-zoom.md)): the lenses live in the
  document map (`CV/panels/cockpit/page-lenses.tsx`); the tiers in `SH/state/semantic-zoom.ts`
  join the overlay host's rule; the Issues lens is the page data DF7's markers draw on.

## 8. Track DF — Documents, files and feedback (spec wave 5)

- **DF1 The save-state machine (D-10).** `apps/editor/packages/repository/src/save-state.ts`
  (new, editing, saving, saved locally, syncing, synced, not synced with Retry, failed,
  read-only, recovered), wired in `CV/app/mount.tsx:820-890`; `SH/chrome/SaveStatus.tsx`.
  Tests: T67. Closes F-07.
- **DF2 Autosave and crash recovery.** `apps/editor/packages/repository/src/recovery.ts`: a
  per-instance OPFS journal written when idle and every N operations, purged on save and close;
  `SH/chrome/RecoveryPrompt.tsx`. Closes F-06.
- **DF3 Drop intent.** `SH/state/drop-intent.ts` and `SH/overlays/drop-intent-overlay.tsx`: place,
  place into the frame under the pointer, import, open, replace or reject, with a ghost label and
  the replace guard; fixes `CV/insert-commands.ts:946-963`; the picker accepts every importer.
  Tests: T62–T64. Closes F-40, F-10, F-02.
- **DF4 The compatibility report** for import and export, `CV/panels/import-report-panel.tsx`,
  from `LossEntry` (navigate to the object; module losses consolidated; IDML through EN6).
  Tests: T66.
- **DF5 The New document dialog**, `SH/chrome/NewDocumentDialog.tsx`: presets (Print, Digital,
  Structured, Custom), units, margins and columns, facing pages, bleed, a live preview. Closes
  F-04.
- **DF6 Guided export.** Prevalidation with blockers, page ranges, kit controls, no "soon".
  Tests: T68. Closes F-12, F-15.
- **DF7 Connected publication health.** `SH/overlays/issue-markers.tsx`, a page overview; a click
  navigates (with history), selects, offers the targeted fix and returns. Tests: T55. Closes F-09.
- **DF8 Operation feedback.** `SH/state/operation-feedback.ts`: the spec's §18.4 outcomes, an
  error as action, reason, whether anything changed, and a remedy; `host.notify` in the contract
  (canary). Closes F-02.
- **DF9 The clipboard** to the spec (ADRs 231 and 289): paste in place, paste into contexts.
  Tests: T65.

## 9. Track FI — Fields, inspector and commands

- **FI1 One numeric field.** `UI/inputs/NumericField.tsx` and `UI/inputs/expression.ts`: units,
  `+ - * /`, parentheses, relative `+=`, mixed units ("10 mm + 2 pt"), in place of
  `UI/inputs/document-unit.ts:131-143`; a scrub through `SH/gestures/use-scrub-gesture.ts` with a
  live preview and one undo step per scrub (EN8); validation, mixed values, a binding badge.
  NumberInput, LengthInput, BoundsInput, SmartDialMicro, the catalogue's leaves and the control
  bar's NumField become wrappers. A single-owner rule `raw-number-input` (baseline about 40 files,
  burned down per module). Exported through the contract (closes the panel audit's item).
- **FI2 The inspector.** Search, progressive disclosure, Frame / Content / Text grouping, a scope
  header for a multi-selection and relative batch edits (`CV/panels/properties-panel.tsx`).
- **FI3 The control bar as an accelerator.** "More…" focuses the inspector's field
  (`CV/cockpit/control-bar.tsx`).
- **FI4 Applicability with reasons (D-16).** `applicability()` in `SH/registries/command.ts:170-184`
  and `SH/chrome/applicability.ts` everywhere; the palette says why a command is disabled; "Go to
  page N"; Help entries; `SCRIPTS/applicability-guard.mjs` extended. Closes F-19.
- **FI5 Align's key object (D-07)** through `SH/state/align-scope.ts` on every align route.
- **Status (2026-11-13): built.** FI1 in [ADR 1216](adr/1216-one-numeric-field.md) (the rule
  `raw-number-input` keeps the modules' copies for CM5 and the standalone devtools inspector),
  FI2 and FI3 in [ADR 1217](adr/1217-inspector-search-and-disclosure.md), FI4 in
  [ADR 1218](adr/1218-commands-say-why-they-do-not-apply.md) (F-19 closed), FI5 in ADR 1201's
  D-07 amendment. A scrub's one undo step is EN8's coalesce key (engine ADR 1304).

## 10. Track CM — Contexts and modules (spec wave 4; the strategy's §7)

- **CM1 The context stack** (`SH/state/edit-context-stack.tsx`) becomes a reducer with a
  post-commit effect queue; hooks keyed by frame id; `isInScope` through EN5; the breadcrumb
  shows groups. Tests: T40, T44.
- **CM2 One exit resolver (D-04)**: reason × dirty × the module's `exitPolicy`, in
  `edit-context-controller.tsx` and VC:709-721; a document switch goes through the replace guard;
  `exitPolicy` in the contract (canary, an extensions record in 1100–1199). Tests: T41–T43.
- **CM3 Frame, Content, Edit (D-05).** `SH/state/frame-content.ts`: the image's content grabber
  first, the "Edit image" action, labels that name the module, a context toolbar of fixed height.
  Tests: T36, T51. Closes F-43, F-45, F-48.
- **CM4 Module conformance.** `TESTS/e2e/uxi-module-conformance.spec.ts` over every module context
  and the profiles of `CV/profiles/presets.ts`. Tests: T35, T37–T39, T45, T46; raises G2.
- **CM5 Module UX**, one change stream per module directory: draw (a precision magnifier, the
  pen's states), image (a before and after split, one tool set; F-43), sheet (frame, then edit
  cells, T38; a publication preview; F-42), doc (a story view and a story map), data (a record
  scrubber, an outlier finder, wording; F-46), web (source and render in sync), slide (the sorter
  as the default navigation; F-47), template fill (role-aware UX, forms on phones; T73).
  **Draw done** (paged.draw ADR 370): the Pen's named states with their cursors and hints, a click
  on the last anchor finishes the open path; a precision magnifier on Control; Points in the
  inspector for selected anchors; Shape suggestions; the Pathfinder says it applies on click and
  outlines its operands (no engine dry run exists for a result preview).
  **Image done** (paged.image ADR 487; closes F-43's two tool sets): the rail is the one tool set
  and the context toolbar names the tool in hand with its options (every module's context); what
  an edit changes is said in the layer rows and the toolbar (pixels, adjustment, mask, placement);
  the filter dialog's before/after split, its draft / rendering / full line; the pixels at 100 %.
  **Web done** (paged.web ADR 416): the element in focus inspected in the source panel (line,
  open tag, path, rendered size, the rules that reach it, its diagnostics), publication notes for
  what a page cannot show and why no script runs, the browser preview and the publication
  rendering named, sample data beside the source.
  **Built, part b (2026-11-14):** sheet — **Frame · Edit cells** (extensions ADR 1108), the bar's
  Editing cells and Done, the publication preview of the selection with overflow warnings, T38
  extended (sheet ADR 532; F-42 closed); doc — Story view (a module view writing the engine's
  story, no second text model) and the Story Map with overset and unplaced stories, Go to next
  overset story (doc ADR 630); data — the six workflow steps, the record scrubber, the outlier
  finder, the binding badges as the editing aid Data bindings, F-46's wording (data ADR 566);
  template fill — Required / Optional, progress, Next field, missing content, Finish with export
  and save, T73 on a phone (editor ADR 1225). The modules' raw number inputs of sheet, doc and data
  left the `raw-number-input` baseline.

## 11. Track AP — Accessibility, devices and performance (spec wave 6)

- **AP1 The object tree (D-13).** `CV/ui/A11yObjectTree.tsx`, virtualized and synchronised with
  the selection; `@axe-core/playwright` in the journeys. Tests: T69. **Done**
  ([ADR 1230](adr/1230-an-accessible-object-tree.md)): the Tree panel (`paged.tree`) is the tree;
  `paged.view.objectTree` (Alt+Shift+O) reaches it; axe runs in `TESTS/e2e/uxi-accessibility.spec.ts`.
- **AP2 Keyboard-only creation and transforms** as commands. Tests: T70. **Done** (ADR 1230):
  inserts land in view, Object ▸ Transform's rotate and scale steps, and
  `paged.edit.selectBelow` / `.selectAbove` (⌥⌘[ / ⌥⌘], IC6’s cycle with a keyboard half) for overlapping objects — the
  cycle IC6's object picker reuses.
- **AP3 High contrast**, the contrast fixes, 200 % UI zoom (tokens). Tests: T74, T75. Closes F-51.
  **Done** ([ADR 1231](adr/1231-high-contrast-and-aa.md)).
- **AP4 Touch and pen.** Pressure and tilt reach the draw tools; a pinch over a pending selection
  candidate changes the camera only. Tests: T71, T72. **Done** (ADR 1230, decision 8): pen
  pressure is read only for a pen (the brushes tapered every mouse stroke's end); the pinch
  takeover of ADR 294 and the coordinator's preempting session already held, now proven over a
  pending hit test through real CDP input; T73 (the fill shape on a phone) is claimed too. No
  change to VC was needed.
- **AP5 Performance.** Progressive first paint, cache and memory budgets, typing coalescing, p95
  and p99 budgets; performance probes in a nightly job; a stress suite (chaos and large files).
  Closes F-54, F-56; raises G3. **Done** ([ADR 1232](adr/1232-performance-budgets.md);
  [`reference/performance.md`](reference/performance.md)): the CPU render one tile per tick from
  the viewport's centre, a 64 MB tile budget, typing folded per round trip, the budgets suite
  and its nightly workflow. The engine's decoded-image cache stays unbudgeted as the inventory's
  `EXC-003`.

## 12. Track PX — The strategy's Phase 3 concepts

In scope. They start after G2, and each lands with its own ADR.

- **PX1 Document X-Ray.** An engine request `RequestExplain(item)` answers provenance facts (the
  style chain, the binding source, the link source, the lock reason, thread and overset, the
  dependents: "pages affected by this style") (`ENG/channel.rs`); `CV/panels/xray-panel.tsx` and
  an X-Ray overlay mode on the canvas. Deterministic facts only.
- **PX2 The Typography Debugger.** The composer's line-break evidence, `RequestLineEvidence`
  (available width, break opportunities, hyphenation, spacing ratios); an overlay and a panel; a
  preview through a sandboxed operation.
- **PX3 Design constraints.** Constraint records in the document's metadata (equal spacing,
  align to, maximum lines, minimum gap, fits), evaluated as DF7 health rules with suggested fixes
  and a preview; no solver.
- **PX4 Visual action automation.** Semantic commands recorded from the coordinator's trace
  (`UXI-MUT-013`) become a named action with parameters; a preview of the affected objects; one
  undo batch; export as a `paged.*` script (on `actions@1`, PM-0015).
- **PX5 Layout variants** as library branches (the repository package), compared side by side
  with a frame and typography diff; shared-style propagation explicit.
- **PX6 A trustworthy AI assistant.** Inspect, propose (a change set of operations), preview (in
  a sandbox), approve, apply through the normal batch and undo; consent, scope and permissions
  (extends `SH/components/cockpit/ai-assistant.tsx` and `platform/shared/ai`).
- **PX7 Publication time travel.** A timeline of named checkpoints (DF2 and the repository's
  commits), a read-only preview, a visual diff.
- **PX8 A living publication contract.** The contract in the document's properties (output
  standard, dimensions, bleed, profile, fonts, image resolution, data completeness, approvals),
  evaluated continuously through DF7 and preflight.
- **PX9 Shared module verbs** (the strategy's Concept J): inspect, transform, copy, bind, style,
  version, validate and export as host commands in every context; conformance through CM4.

---

## 13. Phases and the critical path

Tracks in one phase run in parallel on disjoint files.

| Phase | Tracks                                                                              | Notes                                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| α     | Wave 0: documents and ADRs; inventory, coverage and CI; harness, fixtures and chaos | One canary for the plugin-sdk invariants                                                                                               |
| β     | KF; IC1–IC3; EN1–EN4; WS0–WS7; DF1–DF3                                              | IC owns VC; KF owns `SH/focus` and the shell's Escape migration; WS owns the layout and the header, and DF supplies slotted components |
| γ     | IC4–IC11; EN5–EN8; FI1–FI4; CM1–CM3; DF4–DF8                                        | CM1 needs EN5; FI1's preview needs EN8; IC6 and IC8 need EN2 and EN3                                                                   |
| δ     | CM4–CM5 (one stream per module); AP1–AP5; WS8–WS10; DF9                             |                                                                                                                                        |
| ε     | PX1–PX9                                                                             | After G2; X-Ray and the Typography Debugger share their engine work                                                                    |

**Critical path:** the Wave 0 harness → IC1, IC2 → IC4 (`UXI-MIG-001` parity) → IC6 (EN2) →
CM1–CM3 (EN5) → CM4 (G2) → AP1, AP5 → G3, G4 → PX.

**Ordering hazards:** WS3 lands before IC4 (or IC4 takes it on); KF1 before IC4; the contract
changes (IC10, CM2, FI1, FI4, DF8) are batched into at most two canaries.

## 14. Verification and gates

The gates are the spec's §23.4: **G0** safety (cancel, rollback, document replacement,
permission and cross-document async tests), **G1** core input (selection, drag, marquee, resize,
rotate, keyboard navigation, focus, text composition, Escape), **G2** module conformance, **G3**
visual alignment and performance budgets, **G4** release (the browser matrix of D-14, the
manual accessibility tests, crash and recovery, every exception with an issue, an owner, a
severity and an expiry). A gate is raised in the inventory's `enforcedGates` and not lowered.

| Step                   | Proof                                                                                                                                                       | Gate raised  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Wave 0                 | the inventory guard and the coverage report in CI; the harness's self-tests; the tape goldens                                                               | —            |
| KF                     | T19–T34 and T76 on the CPU lane; T23 as local evidence on real Chrome with a GPU; the Escape and raw-listener ratchets shrink                               | —            |
| IC1–IC5, EN1, EN4, EN7 | T01–T10, T16, T57–T61; the `UXI-MIG-001` tapes equal; `checkLiveness` and `checkNoInterleave`                                                               | G0 (partial) |
| IC6–IC11, EN2, EN3     | T03, T04, T11–T15, T17, T18, T56; visual baselines across zoom and device-pixel ratio                                                                       | G1           |
| CM1–CM4                | T35–T46, T50, T51                                                                                                                                           | G2           |
| DF, FI                 | T55, T62–T68                                                                                                                                                | G0 (full)    |
| AP, WS8–WS10           | T47–T54, T69–T75; the nightly performance budgets; axe clean                                                                                                | G3, then G4  |
| PX                     | a journey per concept: X-Ray's answers equal the engine's facts; a recorded action replays as one undo step; an AI proposal changes nothing before approval | —            |

Every landing: the workflows of the affected projects, and `main` green workflow by workflow.
Every T-test asserts the model (`modelSnapshot`) and the history (`undoDepth`), never a
screenshot alone. The strategy's ten core journeys (§14) become
`TESTS/journey/ux-eval/*.journey.spec.ts`, measuring task success and p95 latency.

## 15. Risks

| Risk                                                                                   | Effect                                        | Mitigation                                                                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| VC is large (over 90 KB) and the refactor touches its core                             | regressions in the most used gestures         | a strangler behind the `coordinator` flag, one change at a time, sliced by event class, tape parity before the legacy path goes (IC6)              |
| The editor's test runtime grows                                                        | slow CI, shards over budget                   | prefer the engine, DOM and unit layers; group the UXI journeys into about six spec files; at most six minutes per shard, an eighth shard if needed |
| GPU and real-Chrome behaviour cannot gate in CI (T23, issue #32)                       | a focus regression on real Chrome goes unseen | an exception entry with an expiry; local evidence on real Chrome; a CPU focus proxy test that gates                                                |
| Contract churn                                                                         | canary bumps for every extension              | batched canaries; extensions records in 1100–1199                                                                                                  |
| Behaviour changes for InDesign users (Shift, the marquee, Tab, the image double-click) | users lose habits                             | ADR 1201, release notes, the modifier hints, the Tab preference                                                                                    |
| ADR ranges                                                                             | colliding numbers                             | PM-0019 and PM-0020 first (done)                                                                                                                   |
| Protocol versions cost wasm rebuilds                                                   | rebuilds and lockfile bumps for consumers     | two grouped versions                                                                                                                               |
| Instance safety                                                                        | one editor's keys or state reach another      | coordinator, arbiter, cursor controller and journal per instance; T33 and the instance guard                                                       |

## 16. ADR ledger and numbering

| Record                                                                              | Range      | Number    | Lands with          |
| ----------------------------------------------------------------------------------- | ---------- | --------- | ------------------- |
| The editor's records continue at 1200–1299                                          | repository | PM-0019   | W0.2                |
| The engine's records continue at 1300–1399                                          | repository | PM-0020   | W0.2                |
| The interaction contract is adopted                                                 | editor     | 1200      | W0.3                |
| Interaction decisions D-01 to D-16 (amends 234, 235, 246, 250, 282)                 | editor     | 1201      | W0.3                |
| One record per task as it lands                                                     | editor     | 1202 on   | each task           |
| The protocol changes of EN1–EN8                                                     | engine     | 1300 on   | EN                  |
| Contract additions (`exitPolicy`, modifier hints, `host.notify`, the numeric field) | extensions | 1100–1199 | IC10, CM2, DF8, FI1 |

## 17. Decisions

The open decisions of the spec (D-01…D-16) and the Escape order are settled in
[ADR 1201](adr/1201-interaction-decisions.md); this plan names where each is built (D-01 in IC6
and EN2, D-02 in EN4, D-03 in KF3, D-04 in CM2, D-05 in CM3, D-09 in IC4, D-10 in DF1, D-11 in
KF5, D-12 in WS8, D-13 in AP1, D-16 in FI4, the Escape order in KF1 and IC4). A decision taken
while building is recorded there or in the task's own ADR before it ships.
