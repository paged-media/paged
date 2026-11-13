# ADR 1200 — The interaction contract is adopted

- **Status:** Accepted 2026-11-13. This records the decision to adopt; nothing of the contract is
  implemented by it. What ships is in [`status.md`](../status.md).
- **Scope:** the editor (`apps/editor`): the canvas, the shell, the chrome and every built-in
  module's edit context, in every profile, and the interactions plugins contribute through the
  contract. The documents adopted:
  [`specs/ideas/paged_interaction_specification.md`](../specs/ideas/paged_interaction_specification.md)
  (`PM-UX-INTERACTION-001`, cited here as "the spec, §n") and
  [`specs/ideas/paged_ux_ui_redesign_strategy.md`](../specs/ideas/paged_ux_ui_redesign_strategy.md)
  ("the strategy, §n"), both kept as written. The decisions on the spec's open questions are
  [ADR 1201](1201-interaction-decisions.md); the work is planned in
  [`interaction-plan.md`](../interaction-plan.md).

## Context

The spec is a proposed normative contract for how the editor answers input: requirements
`UXI-<DOMAIN>-###` over ownership, state, geometry, hit testing, selection, gestures, handles,
snapping, text, contexts, keys, Escape, camera, overlays, feedback, panels, commands,
drag-and-drop, clipboard, files, mutation, asynchrony, accessibility, performance, plugins,
observability and migration; 76 acceptance tests `UXI-T01`…`UXI-T76` in six groups (§23.1);
gates G0–G4 (§23.4); a migration in waves through adapters at the arbitration boundary (§24); and
sixteen open decisions, D-01…D-16 (§25). It says of itself that it is a proposal, that a conflict
with the code is to be labelled a TARGET CHANGE, and that accepted ADRs are not superseded
without ADR review. The strategy is a product strategy: an adaptive, canvas-first cockpit,
predictable selection, dependable documents, module consistency, creative concepts, a three-phase
roadmap (§13) and evaluation journeys (§14).

Read against the code on 2026-11-13, the editor does not meet the spec's core invariants:

- No single owner holds a pointer sequence. `apps/canvas/src/ui/ViewportCanvas.tsx` keeps six
  gesture refs of its own beside the gesture spine, and controllers claim the pointer through
  window capture. `lostpointercapture` and unmount end nothing, so an engine gesture can be left
  open, and the next drag falls back to a pan.
- The hit tests of a click, a double-click and the context menu carry no epoch: a late answer
  can apply after a newer one.
- About ten listeners answer Escape, uncoordinated: one press can cancel a drag and climb a
  group. The Space spring-load swaps the gesture spine's single handler slot mid-drag.
- An edit context ends three ways with three meanings: Escape cancels, a press outside commits,
  the breadcrumb pops.
- Shift-click adds and Cmd-click toggles; the marquee takes what it intersects, in either
  direction, page by page. There is no hover preselection.
- The camera keeps no anchor when a dock resizes, ignores reduced motion and keeps no navigation
  history; the current page is computed in four places. Cursors are written in many places.
  Snapping has no hysteresis and no target labels, and its bypass key differs between paths.
- The docks are fixed (262 and 320 px) and there is no density setting. Numeric fields are six
  components and 78 raw `type="number"` inputs, without unit expressions.
- The save state is dirty or saved; there is no autosave and no crash recovery. A drop shows no
  intent before it lands. An import's losses are not shown (the IDML `lost` list is dropped at
  `client.exportIdml`), and New document has no dialog. Issue #32 (Escape in the command palette
  on real Chrome) is open, and 29 of the 57 findings of the October UX audit
  ([`design/ux-audit-2026-10.md`](../design/ux-audit-2026-10.md)) are open.

## Decision

1. **The spec is the editor's normative interaction target.** Its `UXI-*` ids are stable
   contract ids; its MUST, SHOULD and MAY mean what its §1.2 says. Where it conflicts with an
   accepted ADR, the ADR stands until amended: ADR 1201 decides D-01…D-16 and the Escape order
   of §12.1, and adds a dated amendment to each record it changes (234, 235, 246, 250, 282). The
   spec's approval table stays as written; this record is the adoption.
2. **It is implemented in waves**, the spec's §24.1, each closed by its tests:
   - **Wave 0, freeze semantics:** this record, ADR 1201, the ADR ranges (PM-0019, PM-0020), the
     interaction inventory, the coverage report, the test harness and a recorded baseline of
     today's behaviour.
   - **Wave 1, keyboard and focus authority:** one key-yield policy over menus, dialogs, IME,
     plugin frame surfaces and embedded editors (`UXI-T19`–`T34`, `T76`).
   - **Wave 2, the interaction coordinator:** one event-ownership layer over the legacy
     selection and text path and the gesture spine, with sessions, epochs and cancellation
     (`UXI-T01`–`T18`, `T57`–`T61`).
   - **Wave 3, selection and geometry:** hit selection, group traversal, handle geometry,
     snapping, across zoom and device-pixel ratio.
   - **Wave 4, context convergence:** frame and content, module commit and cancel, the scope
     query, stable camera and chrome (`UXI-T35`–`T46`, `T50`, `T51`; gate G2).
   - **Wave 5, commands, data, files and history:** applicability, errors, transactions, drop
     intent, import and persistence feedback (`UXI-T62`–`T68`; gate G0).
   - **Wave 6, devices, accessibility and performance** (`UXI-T69`–`T75`; gates G3, G4).

   The strategy's Phase 3 concepts follow once G2 holds. The tracks that carry the waves (KF, IC,
   EN, WS, DF, FI, CM, AP, PX), their tasks and their order are in
   [`interaction-plan.md`](../interaction-plan.md).
3. **TARGET CHANGEs.** These change what the editor does today, deliberately; ADR 1201 decides
   each. The migration's parity rule (`UXI-MIG-001`: a migrated tool's model, undo and render
   outcomes equal the old ones) excludes exactly these:
   - Shift-click toggles membership; Cmd (Ctrl) stays a toggle alias (D-01, amends 235).
   - The marquee is directional: left to right takes what it fully contains, right to left what
     it touches; it is scoped to the active group and starts on the pasteboard too (D-01,
     amends 235).
   - Tab moves focus, on the canvas too; the chrome toggle is the explicit command
     `view.toggleChrome`, and "Tab hides panels (InDesign)" is an opt-in preference (D-03,
     amends 234).
   - A double-click on an image frame enters content position first; an explicit "Edit image"
     enters the image module (D-05, amends 282).
   - A click outside a clean context exits it; outside a dirty one, the module's declared
     `exitPolicy` decides: commit if safe, otherwise ask (D-04, amends 250).
   - One Escape press resolves exactly one thing, the first applicable case of §12.1; at the top
     level that clears the selection (amends 250).
   - The live duplicate preview is the committed result (D-02; closes GF-2 and GF-3 of
     [`reference/gestures.md`](../reference/gestures.md)).
   - Space during a mutating drag waits until the drag settles (D-09).
   - One zoom range for every input; Actual size (an inch as 96 CSS px) and a calibrated size are
     named views, while 100 % keeps its meaning (D-12, amends 246).

   A further departure found while migrating is added to ADR 1201 by a dated amendment, or
   recorded by the task's own ADR, before it ships; never silently.
4. **One exception ledger.** Where the editor does not yet meet a requirement, the gap is an
   entry in the `exceptions` section of `apps/editor/scripts/interaction-inventory.json`
   (`UXI-MIG-004`), which Wave 0 introduces: the contract ids it violates, why, the affected tool
   or module, an issue, an owner, a severity and an expiry. Its guard fails on an expired entry.
   There is no second list: not a comment, not a plan's table, not an unexplained skipped test.
5. **No gate passes on a screenshot alone** (the spec's §23.4). Every `UXI-T` test asserts the
   authoritative model and the undo history (a model snapshot and the undo depth) beside what it
   shows; a pixel comparison is extra evidence, never the proof. Gates G0–G4 are raised one by
   one in the inventory's `enforcedGates`, and a raised gate is not lowered.
6. **The strategy is adopted as product direction**, not as a contract: Phase 1 (save state and
   recovery, selection, keyboard and focus, an adaptive canvas-first workspace, the inspector's
   hierarchy, operation feedback, loading feedback), Phase 2 (the frame and content model,
   inspector search, one numeric field contract, navigation history, connected publication
   health, the import report, the new-document flow, guided export, module UX) and Phase 3 with
   its concepts (Document X-Ray, the Typography Debugger, design constraints, visual action
   automation, layout variants, a trustworthy AI assistant, publication time travel, a living
   publication contract, shared module verbs). Each initiative lands with its own ADR. Where the
   strategy and the spec differ on an interaction, the spec and the ADRs decide. The strategy's
   evaluation journeys (§14) become journey tests.

## Consequences

- Until a task lands, the editor behaves as the sections of `status.md` and the existing records
  say; this record changes no code.
- A task is done when its `UXI-T` tests pass at their layer, assert model and history, and the
  task's ADR (1200–1299 here, engine records in 1300–1399, contract records in the extensions'
  1100–1199) records what it decided. Tests name their scenario in the title (`UXI-T07 — …`);
  `covers()` keeps naming real surface ids only (ADR 227).
- The behaviour changes affect users who come from InDesign (Shift, the marquee, Tab, the image
  double-click). Each ships with its release note, the modifier hints on the canvas, and for Tab
  a preference that restores the old key.
- Contract changes the programme needs (an `exitPolicy`, modifier hints, `host.notify`, the
  numeric field) are batched into as few plugin-sdk canaries as practical; protocol changes into
  two protocol versions.
- The two documents in `specs/ideas/` are not edited to track progress; this record, ADR 1201,
  later records and `status.md` do that.
