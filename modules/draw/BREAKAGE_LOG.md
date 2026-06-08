# BREAKAGE_LOG — paged.draw vs. the plugin surface

Every place the de-facto plugin API (editor registries + catalog +
client, façaded by `@paged-media/plugin-api`) fell short of what
paged.draw needs. **This log is the API-v1 punch list** (concept
§12.3): entries drain as host/core work lands; nothing enters
`plugin-api@1.0` that didn't earn its place here.

Format: `B-NN · date · area · status`.

---

- **B-01 · 2026-06-06 · panel schema · RESOLVED (2026-06-07, W3.1)** —
  the paper's `visibleWhen`/`enabledWhen` conditionals don't exist and
  are *rejected by design* (catalog binding ceiling: `literal |
  selectionProperty`, `editor/packages/catalog/src/types.ts`). The
  recorded resolution direction — *derived bound values from plugin
  state + expert leaves, not a conditional binding language* — is now a
  CONTRACT. The v1 declarative panel-schema mechanism (plugin-sdk
  DESIGN.md §12):
  · a bundle registers a `SchemaPanelContribution` through the new
    `host.contribute.schemaPanel` door (gated identically to
    `contribute.panel`: namespace rule, then `contributes.panels[]`).
    The `PanelSchema` is PURE DATA — sections → rows → widgets, each
    widget a CATALOG id from the existing vocabulary
    (`paged.input.numeric-scrub`/`color-swatch`/`toggle-group`/
    `paged.readout`/…), each row's `value` a `WidgetValueBinding` on
    the §11.5 ceiling UNCHANGED (`literal | selectionProperty` +
    coerce). NO React crosses the boundary — this is the panel/overlay
    isolate exit the trust line needs (DESIGN.md §6).
  · DYNAMIC visibility/enablement comes from a `SchemaGate`
    (`boolean | {bind, negate?}`). `{bind:"name"}` names a value the
    plugin PUBLISHES through the new `host.bindings` door
    (`publish/get/delete/onDidChange`, per-bundle, JSON); the host
    LOOKS IT UP and re-renders (`resolveGate` — absent→true,
    literal→itself, `{bind}`→`Boolean(lookup)`, missing→false,
    `negate`→NOT). There is NO expression language: the plugin computes
    the boolean in ITS OWN realm (tool/selection/document state) and
    publishes the RESULT — the derived-bound-value resolution this
    entry recorded. `negate` (a NOT) is the only transform.
  · the host renders: `createBundleHost` synthesizes a registry
    `PanelContribution` whose component delegates to a host-injected
    `SchemaPanelRenderer` (`createBundleHost({ schemaPanelRenderer })`).
    The editor's renderer (`@paged-media/shell`
    `catalog/schema-panel-renderer.tsx`) walks the schema through the
    catalog's `CompositionRenderer` and subscribes to the bundle's
    bindings; no renderer injected → a visible "needs a host renderer"
    SEAM (never a throw, never fake UI). The headless harness records
    each schema panel VERBATIM (`schemaPanel` recorded contribution +
    `schemaPanelsContributed()`).
  ADOPTION (this repo): `draw-bundle/src/panels/stroke-panel.ts` is the
  REAL stroke panel as a `SchemaPanelContribution`, contributed in
  `activate.ts` via `contributeSchemaPanel`. Its dash SECTION's
  visibility is gated on a published `media.paged.draw.dashControlsVisible`
  binding the bundle derives from real selection state
  (`installStrokePanelBindings`: a path element exposes a `pathAnchors`
  table → true; a bounds-based rectangle → false), and the weight/color/
  cap rows' enablement on `media.paged.draw.hasSelection`. This is
  exactly the paper's `visibleWhen strokeType == "dashed"` case,
  re-expressed as a derived bound value. Proof: `draw-bundle`
  `test/activate.spec.ts` + `test/headless-conformance.spec.ts` (the
  schema recorded verbatim, the bindings react to real selection);
  editor `apps/canvas/tests/e2e/draw-schema-panel.spec.ts` (the panel
  renders from the catalog on :5180; the dash section flips
  visible/hidden as selection moves rect↔polygon).
  HONEST LIMITS (DESIGN.md §12.4): the widget set is the curated catalog
  leaves — NO list primitive (layer/style lists stay expert-leaf React;
  `layers.panel.json` therefore can't adopt the schema yet) and NO
  custom canvas; the gate evaluation is a host-side LOOKUP keyed by
  name, NOT an expression language; a widget's `value` still binds only
  to the selection (or a literal), never to a published binding, in v1.
  The other prototypes stay prototypes with notes pointing here:
  `stroke.panel.json` is SUPERSEDED by the live `stroke-panel.ts`;
  `fill.panel.json` can adopt the schema once gradient assignment is
  verified (B-03); `layers.panel.json` is the recorded list-widget
  limit (ships as expert-leaf React when needed).

- **B-02 · 2026-06-06 · shell · RESOLVED (2026-06-07, W3.2)** — edit
  contexts shipped (paper §5 / P0), un-reserving `contribute.editContext`
  (the door no longer throws `PluginApiNotImplemented`). MECHANISM, the
  three layers:
  · **plugin-api / plugin-sdk:** `contribute.editContext` is now a real
    door. A bundle registers an `EditContextContribution`
    (`{ type, entry, matches?, toolIds?, panelIds?, onEnter?, onExit? }`).
    Capability-gated like every other door, but keyed on the OBJECT array
    `contributes.editContexts[]` (the `type` must be declared — NOT a
    namespaced id, since a content-type name carries no manifest prefix;
    the namespace rule does NOT apply, the capability gate is the only
    gate). The SDK adapter STAMPS the bundle's own `x-paged:<id>`
    `metadataKey` onto the contribution so the host resolves the
    candidate's metadata from THIS plugin's envelope only. The headless
    harness records every registration (`editContextsContributed()`) — so
    conformance asserts the matcher/sets without a UI.
  · **editor shell (the `EditContextRegistry` B-02 named):**
    `registries/edit-context.ts` (registry + the pure `resolveDoubleClick`
    router), `state/edit-context-stack.tsx` (the STACK — enter PUSHES a
    frame {type, scopeRoot, toolIds, panelIds}; `pop()` removes the TOP
    frame so Esc pops ONE level; `exitAll`; `isInScope`), the
    `EditContextController` (Esc-pop, panel emphasis + first-tool focus on
    enter, selection-driven auto-exit), and `EditContextBreadcrumb` (the
    root→top trail; the active crumb is selection-magenta; renders ONLY
    while a context is active). The canvas double-click ENTRY
    (`ViewportCanvas.onDoubleClick`) consults `useEditContextEntry`
    BEFORE group descent.
  · **adoption (this repo):** `draw-bundle/src/edit-context.ts` —
    `vectorGraphicEditContext` (kind-claimed: the Track-J path kinds —
    polygon/graphicLine/rectangle/textFrame). Double-clicking a path now
    ENTERS anchor-editing: the three anchor tools focused (Add first), the
    stroke panel raised, the breadcrumb shows "Vector graphic", Esc pops.
  WRITE-SCOPE LINE (documented honesty): the stack carries the entered
  element as `scopeRoot`; `isInScope` is the SELECTION-SPACE guard at the
  gesture/mutation entry — the SAME depth `SELECTION` enforces today, NOT
  kernel-level isolation. A mutation addressed at an out-of-scope id is
  NOT rejected by the engine; true subtree isolation is the isolate's job.
  Proof: `draw-bundle` `test/activate.spec.ts` (the vectorGraphic context
  registers with its tool/panel sets + stamped key + kind matcher) +
  `test/headless-conformance.spec.ts` (recorded verbatim in the log);
  plugin-sdk `test/edit-context.spec.ts` + `test/harness.spec.ts` (door,
  gate, recording, no-more-throws); editor Playwright
  `tests/e2e/edit-context.spec.ts` AC-EDITCTX-1 (double-click a path →
  breadcrumb shows + Esc pops, on :5180).
  RESIDUALS (not blockers): (1) the tool-set restriction is FOCUS-the-
  first-tool depth — the rail does not yet GRAY OUT non-context tools
  (a ToolRail derivation change, deferred); (2) write-scope is the
  selection-space line above — engine subtree rejection is the isolate's;
  (3) NESTED contexts: the stack supports depth N (Esc pops one), but no
  first-party flow nests yet, and `isInScope` v1 matches only the
  entered element itself (descendant membership needs a subtree query);
  (4) when paged.draw AND a metadata-claiming objectType both could
  claim one element, the objectType wins (resolveDoubleClick checks it
  first) — a webFrame never falls through to the vectorGraphic kind
  matcher; multi-plugin contention policy proper ships at P7 (manifest
  `priority` reserves the shape).

- **B-03 · 2026-06-06 · engine ops · RESOLVED (2026-06-06)** — gradient
  assignment needs NO new engine op: verified by core test
  (`paged-mutate/tests/gradient_fill.rs`) — `setElementProperty{
  frameFillColor, colorRef("Gradient/…") }` round-trips to a
  `LinearGradient` paint through `build_document`, inverse restores.
  Editor follow-up: the toolbar/panels just send the colorRef. Sharp
  edges pinned in the test: a stop referencing a missing swatch
  silently drops the whole fill; the legacy single-page
  `pipeline::build` is solid-only.

- **B-04 · 2026-06-06 · engine ops · RESOLVED (2026-06-06)** —
  `CreateGroup { memberIds }` / `DissolveGroup { groupId }` Mutations
  landed (protocol v32; `paged-mutate` `Operation::CreateGroup` /
  `DissolveGroup`). Flat groups v1, one spread, leaf members only;
  fully validated before mutation (atomicity), minted group id echoed
  as `createdId`. Z-order: members contiguous in paint order group
  NEUTRALLY (group ref takes the earliest member's
  `frames_in_order` slot — INV-tested as identical `build_document`
  command streams); scattered members deterministically collect at
  the earliest slot (InDesign semantic) and undo restores the exact
  pre-group z-order via inverse-side `restore_slots`. INV suite:
  `core/crates/paged-mutate/tests/group_ops.rs`. Wire re-vendored
  (plugin-api 0.2.4-canary.0). Nested groups + group transforms
  remain v2 (dissolving a parsed nested group rejects cleanly).

- **B-05 · 2026-06-06 · geometry kernel · RESOLVED (2026-06-06)** —
  kernel (`paged-mutate/src/kurbo_kernel.rs`) AND wire ops landed:
  `outlineStroke` / `offsetPath` / `simplifyPath` Mutations
  (protocol v30, snapshot-inverse undo, kind-generic over the
  Track-J path kinds; outlineStroke is geometry-only — paint
  transfer composes as a caller Batch). Editor d.ts + plugin-api
  wire re-vendored (0.2.3-canary.0). v1 scopes recorded in the
  kernel docs: offset = single closed contour, bevel-ish gap joins;
  outline keeps kurbo's raw expansion (correct under nonzero fill).

- **B-06 · 2026-06-06 · hit-testing · RESOLVED (2026-06-06)** —
  `requestNearestPathPoint { id, point } → nearestPathPoint` worker
  query landed (protocol v30, element-local space like PathAnchors).
  Follow-up (not a contract gap): migrate the TS `closestTOnCubic`
  copies (shell overlay, draw-tools planner) onto the query where a
  round-trip beats local math — the local copies stay legitimate for
  sync interactive paths.

- **B-07 · 2026-06-06 · overlays · RESOLVED (2026-06-07, W3.3)** —
  `ToolPreviewShape` was rect-or-polyline only, so in-progress pen
  cubics had to be FLATTENED for preview (`flattenAnchorRun` — sampling
  artefacts at high zoom + wasted work per pointermove). The
  path/cubic variant LANDED end-to-end:
  · **contract** — `ToolPreviewPath` is now a third member of the
    `ToolPreviewShape` union in `@paged-media/plugin-api`
    (`editor.ts`, re-exported via `contributions.ts`): `{ pageId,
    anchors: PathAnchorSpec-shape[], close?, dashed? }` — the SAME
    anchor/handle run `insertPath` commits and `draw-tools`'
    `AnchorTriple` produces, so one run feeds both preview and commit.
  · **shell renderer** — `tool-preview.tsx` discriminates on
    `"anchors" in p` and emits ONE real SVG `<path>` of `C` commands
    (closing cubic + `Z` when `close`), exact at any zoom, no
    sampling. Strokes the same `var(--overlay-snap)` token as the rest
    of the preview family (no new token/class — the `overlay-tokens`
    guard already covers it); `dashed` opts into the existing
    dashed-vs-solid vocabulary.
  · **host door** — `overlay.setToolPreview` passes the variant
    through UNCHANGED, capability-gated as today
    (`overlay.toolPreview@1` / `rendering: ["overlay"]`); the headless
    host RECORDS it (`createHeadlessHost().lastToolPreview()`), closing
    B-13 residual (2) for the path channel.
  · **draw emitter** — `draw-tools` gained `penPreview(snapshot,
    pageId, { dashed? })`, the host-agnostic builder that frames a
    `PenSnapshot` as a `ToolPreviewPath` (live rubber-band → a trailing
    corner anchor = straight cubic; `closePreview` → `close` + no
    rubber-band). Replaces the flatten step; the editor shim / a future
    isolated bundle pushes its output straight through the overlay door.
  MECHANISM NOTE — there is NO separate feature flag: the variant is
  STRUCTURAL (the renderer keys off the `"anchors"` discriminant), so a
  host whose `ToolPreviewShape` predates the variant simply never
  receives it and a shim targeting such a host keeps `flattenAnchorRun`
  as the fallback. `flattenAnchorRun` is retained for that reason (and
  for the polyline-family tools — pencil/line/gradient).
  TESTS: plugin-sdk `host-impl.spec.ts` (door accepts the cubic shape
  verbatim) + `harness.spec.ts` (loaded bundle records the variant
  headlessly; the capability gate still bites); plugin-draw
  `pen-machine.spec.ts` (`penPreview` emits SEGMENT data — handles, not
  sampled points — `close`/rubber-band/dashed branches); editor
  Playwright `e2e/overlay-path-preview.spec.ts` (a real `<path>` of `C`
  commands renders in the overlay during an in-progress preview,
  Z-terminated when closed, snap-teal).
  RESIDUAL — the P2 RETAINED overlay channel (a plugin-owned persistent
  scene layer, distinct from the transient single-preview signal) stays
  reserved, not faked; it is a separate surface from this preview-lane
  fix and remains future work.

- **B-08 · 2026-06-06 · pointer events · RESOLVED (2026-06-08, W4.16)** —
  `CanvasPointerEvent` now carries `pressure` (0..1), `tiltX`, `tiltY`,
  and `pointerType` (`"mouse" | "pen" | "touch"`), all additive.
  ViewportCanvas reads them straight off the DOM `PointerEvent` in
  `buildToolPointer`, preserving browser semantics verbatim (a mouse
  reports `0` with no button and `0.5` while held; a pen reports
  physical pressure) — the host never synthesizes a value, only
  defaults `0.5`/`0`/`"mouse"` when a synthetic event omits a field.
  Plumbed through both contracts (`plugin-api/src/editor.ts` +
  editor `shell/src/tools/gesture-handler.ts`, kept in lockstep so
  `plugin-api-compat`'s `_PointerEventsFlowToContractHandlers` holds)
  and forwarded untouched by the plugin-sdk gesture kit (it passes the
  whole event object). On the draw side, `PenMachine` gained an
  OPTIONAL `sample?: { pressure?, tiltX?, tiltY? }` on its down/move/up
  events and records a per-anchor `pressures[]` profile parallel to
  `anchors` — the machine stays PURE (pressure never feeds geometry;
  unit-tested). `draw-tools` also exports the API seam
  `strokeWidthFromPressure(p, {min,max})` that maps a sample to a
  stroke width (mouse 0.5 → mid-range).

  **SAB verdict — NOT carried on the gesture SAB lane (by design).**
  The gesture SAB (`packages/client/src/sab/gesture.ts`, 32 bytes / 8
  u32 words) is a **wasm-coupled fixed-layout contract**: core owns the
  canonical layout (`crates/paged-canvas/src/gesture.rs` —
  `GESTURE_SAB_BYTES` + `GESTURE_OFFSET_*` + `GestureSabLayout`), the
  published `@paged-media/canvas-wasm` exposes `gestureSabLayout()`, and
  the worker's `assertSabContract` fires `protocolMismatch` on any
  drift. Adding pressure/tilt fields would grow `GESTURE_SAB_BYTES` and
  add offsets the installed wasm doesn't know — a protocol break needing
  a core change + republish, out of scope for an additive task. (Note:
  the wasm does NOT read the SAB memory directly anyway — the worker
  drains it in JS and passes scalar args to `updateGestureRaw(handleLo,
  handleHi, dx, dy, modifierBits)`. The fix-the-right-place answer is
  the event OBJECT, which the draw tools already receive.) So pressure
  rides the `CanvasPointerEvent` object spine, not the SAB.

  **CLOSED (2026-06-08) — engine op + editor consumer both landed.**
  Variable-width stroke RENDERING — turning a pressure profile into path
  geometry — now exists end to end. Core (protocol **v36**, published
  `@paged-media/canvas-wasm@0.36.0`) gained
  `kurbo_kernel::variable_width_outline_stroke` (flatten centreline →
  offset each vertex along its local normal by an arc-length-interpolated
  half-width → one closed filled contour, rendered under nonzero winding,
  no new GPU path) behind `PropertyPath::OutlineStrokeVariable` /
  `Value::OutlineStrokeVariable { widths, cap, join, miter_limit, prev_* }`
  with a snapshot inverse + kernel/apply round-trip tests, reachable over
  the wire via the generic `SetElementProperty`. The pressure→width seam
  `strokeWidthFromPressure` moved to `@paged-media/draw-geometry` (zero-dep,
  the editor's D1 import seam beside `simplifyRdp`). The editor's built-in
  **Pencil** (`editor packages/tools/src/handlers/pencil-tool.ts`) now
  captures per-sample pressure; a PEN stroke commits `insertPath` + the
  `OutlineStrokeVariable` bake in ONE undo step via a `batch` whose property
  child targets the minted path through the `$created` sentinel; a mouse
  keeps the plain smooth stroke. v1 residuals (non-blocking): caps/joins are
  not yet rendered as round end-caps (the kernel ignores `cap`/`join` —
  butt-like ends); the width profile is distributed uniformly across the
  fitted centreline's arc length (not re-mapped to the pre-fit sample arc
  positions). Editor: typecheck + build green at protocol 36.

- **B-09 · 2026-06-06 · scripting/runtime · RESOLVED (2026-06-07)** —
  the open half closed in core (W3.9, rides protocol v35).
  `paged-script` now combines Boa 0.21 `RuntimeLimits`
  (loop/recursion/**stack**) with a host-injected **wall-clock
  deadline** checked at every `paged.*`/`console.*` host-call
  boundary, plus a per-execution `ScriptBudget` config
  (`execute_script_with`) and a **typed** `ScriptBudgetKind
  {Iterations|Recursion|StackSize|WallClock}` surfaced over the wire
  (`ScriptResult.budgetKind`, additive on v35). Breaches raise Boa's
  non-catchable `RuntimeLimit`, so user `try/catch` can't swallow
  them and the worker survives (reusability tested). Honest wasm
  limit: a host-call-free pure-JS busy loop is still bounded only by
  the loop-iteration budget (single-threaded wasm can't preempt Boa's
  synchronous run loop, which has no instruction interrupt hook) —
  true preemption of such a loop needs main-thread Worker
  termination, an editor concern. Per-context memory caps remain out
  (stock Boa has none; the `max_buffer_size` host hook only caps
  ArrayBuffers).

- **B-10 · 2026-06-06 · packaging · RESOLVED** — `@paged-media/sdk`
  npm name collision: it's core's WebGPU `ViewerSession`. Plugin
  runtime renamed `@paged-media/plugin-sdk` (sdk repo, 2026-06-06).

- **B-11 · 2026-06-06 · bundle surface · RESOLVED (2026-06-06)** — the
  editor's gesture-shim helpers were absorbed into
  `@paged-media/plugin-sdk` 0.2 as the gesture kit (`beginPageDrag`,
  `endLocalFor`, `pxToPt`, `commitAndSelect`); `draw-bundle` now
  registers its tools itself (D3, `src/activate.ts`).

- **B-12 · 2026-06-06 · engine ops · RESOLVED (2026-06-08, W4.16)** — the
  dash-pattern `PropertyPath` was ALREADY on the published wire
  (`frameStrokeDashArray`, a `Value` `{type:"lengths"; value:number[]}`
  member — canvas-wasm@0.35.1, protocol 35); the gap was purely a missing
  draw-side consumer. It now ships as **command-driven presets** rather than
  an inline widget, because `frameStrokeDashArray` is a vector and the panel
  schema's binding ceiling is scalar (`literal | selectionProperty`, the
  B-01 honest-limit — no list/array widget yet). Four commands under the
  manifest id, category "Stroke" (`src/commands/dash.ts`):
  `…command.strokeDash{Solid,Dashed,Dotted,DashDot}` → `lengths`
  `[] / [6,3] / [1,3] / [6,3,1,3]` (Solid clears). Each handler reads
  `host.selection.get()` and commits `setElementProperty{
  frameStrokeDashArray, {type:"lengths", value:[…]} }` per selected element
  through `host.document.mutate`; no selection → debug-log no-op. Registered
  through `host.contribute.command` (no `contributeCommand` SDK helper
  exists — the direct door, the plugin-web pattern) in `activate.ts` and
  disposed on teardown; the 4 ids are declared in `manifest.json`
  `contributes.commands[]`; the stroke panel's dash section readout now
  points at them. The `DASH_PATH` literal-typed const keeps the mutation
  satisfying `PropertyPath` with no cast (the §12.3 wire-compat alarm stays
  live). Tests (`test/conformance/dash-commands.spec.ts`, 8): per-preset
  exact wire-shape on `dashMutationFor`, the 4 commands in the contribution
  log, each recorded handler landing `applied:true` on a selected stroked
  rectangle at the real engine, and the no-selection no-op.
  RESIDUAL (not a blocker): inline per-segment array EDITING (drag the dash
  lengths) awaits a schema array/list binding — the same ceiling as B-01.

- **B-13 · 2026-06-06 · testing · RESOLVED (2026-06-07)** — the
  headless conformance host LANDED (`@paged-media/plugin-sdk`
  `createHeadlessHost`, W3.5). It is no longer a throw / a mock: it
  boots the PUBLISHED `@paged-media/canvas-wasm` (0.34.0, Decision B) in
  Node via a small loader util (`src/wasm-loader.ts` — `initSync` over
  the `_bg.wasm` bytes; the wasm-bindgen `--target web` loader's
  synchronous entry needs no fetch and the only Node-hostile import the
  wasm reaches is `globalThis.crypto`, present on Node ≥ 19) and drives
  the SAME `handleMessage` JSON envelope the editor worker drives. So a
  bundle's document mutations round-trip through the true
  parse→apply→inverse engine path with real undo/redo. Doors:
  document.mutate/undo/redo/collection/meta/pathAnchors/hitTest/
  elementGeometry/tree/getMetadata/setMetadata + selection reads +
  diagnostics/storage are REAL (engine round-trip); the contribution
  surfaces (tool/panel/command/keybinding/overlay) are RECORDING no-ops
  capturing every contribution in an assertable log; editContext/
  objectType stay RESERVED (throw `PluginApiNotImplemented`). Protocol
  is PINNED — the loader reads the vendored wire's `Synced from …@<ver>`
  stamp, derives the expected protocol (the package minor), and asserts
  the booted wasm matches; a wasm/wire skew fails loudly. Consumer proof:
  `plugin-draw/packages/draw-bundle/test/headless-conformance.spec.ts`
  activates the real paged.draw bundle headlessly (3 anchor tools in the
  contribution log — pen is a core built-in per W2.5, panels are design
  prototypes per B-01, so the log holds 3 tools / 0 panels), runs a real
  `setPluginMetadata` round-trip, and proves dispose leaves the doc
  unchanged. SDK pins in `plugin-sdk/.../test/harness.spec.ts` (+
  `sync-wire.spec.ts`).
  RESIDUALS (not blockers; this is the replay FOUNDATION, not the whole
  §12.4 fixture corpus): (1) gesture REPLAY — driving a tool's
  `gesture()` machine event-by-event against the headless engine — is
  not wired; the harness records the tool but does not yet replay its
  pointer stream (couples to B-17's facade-vs-spine migration). (2)
  overlay PREVIEW assertions are recorded no-ops (no overlay surface
  headlessly; B-07). (3) one bundle per headless host in v1.
  RESIDUAL (4) — RESOLVED (2026-06-07, W4.15): the fixture CORPUS replay
  harness now exists. `draw-bundle/test/fixtures/` carries a pure-TS IDML
  builder (`build-idml.ts` — no `zip` CLI, deterministic bytes) + a named
  corpus (`corpus.ts`: F1 multi-shape rect+open-polygon+line, F2 closed
  quad, F3 curved-open). `test/replay.ts` records a `GesturePlan`
  (`{tool, click, tolerance}` — the deterministic OUTPUT of the anchor
  machines) and replays it through `host.document.mutate` via the
  bundle's OWN exported `mutationFor` (no second copy to drift from),
  asserting the resulting anchor table + that one undo restores baseline.
  Spec family (`test/conformance/*.spec.ts`, vitest, one wasm boot per
  file via the host's reload support): `corpus.spec.ts` (parse + geometry
  round-trips per fixture), `replay.spec.ts` (add / delete / convert plan
  shapes incl. closing-edge add + the delete min-anchors floor + the
  curve-preserving split), `metadata.spec.ts` (plugin-metadata persistence
  across mutate + undo + the namespace gate). Pointer-EVENT-level gesture
  replay (residual 1) is still the deeper step gated on B-17 — this proves
  the PLAN→engine contract, the load-bearing half.
  FINDINGS surfaced by the corpus (pinned-gap tests, present through the
  vendored protocol v35): (a) the plugin-metadata carrier round-trips on
  `<Rectangle>` leaves but a `<Polygon>` write reports `applied:true` and
  reads back `null` — so the corpus uses the rectangle as the metadata
  carrier and the open polygon as the anchor-plan target; (b) rectangles
  expose NO `pathAnchors` table (bounds-based), so anchor replay targets
  polygons / graphic lines only.

- **B-14 · 2026-06-06 · shell rail · RESOLVED (2026-06-06)** —
  `ToolContribution.slotOrder` (contract + editor): the rail orders
  slots by `min(slotOrder)` per section, first-seen for unhinted —
  late bundles can place their slot among the built-ins.

- **B-15 · 2026-06-06 · shell shortcuts · RESOLVED (2026-06-06)** —
  host-side fix landed: `installRegistryDerivedContributions` derives
  tool activation commands + guarded shortcuts and panel show/hide
  pairs from the LIVE registries (onChange) for every registration
  path; the SDK helpers dropped their bundle-side duplicates
  (plugin-sdk 0.2.2).

- **B-16 · 2026-06-07 · engine ops / trust · RESOLVED (2026-06-08,
  W4.16)** — the engine plugin-metadata op now enforces caller identity
  (audit P8). The prior gap: per-plugin namespace isolation
  (`x-paged:<id>`) was enforced only in the SDK door (`host-impl.ts`
  `foreignMetadataKey`, recursive incl. batches); the engine op checked
  only the `x-paged:` prefix, the 64 KiB cap, and the JSON envelope — so a
  bundle holding the raw handle bypassed the door
  (`paged.client.mutate({ op:"setPluginMetadata", args:{
  key:"x-paged:<other>", … } })` wrote another plugin's namespace). Fix
  (core, protocol **v36**, published `@paged-media/canvas-wasm@0.36.0`):
  an **additive** `caller: Option<String>` (`#[serde(default)]`) rides the
  wire `Mutation::SetPluginMetadata` → `Value::PluginMetadata`; when
  `caller` is `Some`, `paged-mutate/src/apply.rs` `apply_plugin_metadata`
  enforces the key namespace == `x-paged:<caller>`; when `None` (the
  editor / `paged.script` / pre-B-16 callers), the prior prefix-only
  behaviour holds, so nothing existing breaks. Enforcement test:
  `evid_plugin_metadata_caller_gate_blocks_foreign_namespace`
  (own-namespace ok, foreign-namespace rejected, `None` back-compat). The
  SDK door now names the caller (`plugin-sdk host-impl.ts` `setMetadata`
  passes `caller: manifest.id`) so the engine cross-checks even a raw-handle
  write — defense in depth, and the teeth the isolate boundary will rely on
  (where `host.editor` dies anyway). Trust-line gate:
  `thoughts/docs/paged/plugin-trust-line.md`.

- **B-17 · 2026-06-07 · bundle surface / §4.9 · RESOLVED (2026-06-08,
  W4.16)** — the anchor handlers now run entirely on `host.*` facades, the
  dogfooding proof that the facade is sufficient for a real tool. The
  handler factory took a host argument (`createAnchorEditHandler(mode,
  host)`); `tools.ts` became a `drawTools(host)` factory (with a host-free
  `DRAW_TOOL_IDS` for `edit-context.ts`), and `activate.ts` calls
  `drawTools(host)`. Per-reach migration in
  `draw-bundle/src/handlers/anchors.ts`:
  `paged.client.send({kind:"hitTest"})` → `host.document.hitTest(pageId,
  pagePoint, "any")`; `paged.client.pathAnchors` →
  `host.document.pathAnchors`; `paged.client.mutate` →
  `host.document.mutate` (failure check switched from `reply.kind ===
  "mutationFailed"` to `!outcome.applied`, reading `outcome.error`);
  `paged.selection.elementSelection` → `host.selection.get()`;
  `pxToPt(paged.camera.camera.scale, …)` → `host.viewport.pxToPt(…)`
  (verified semantically identical — both `px / (scale>0?scale:1)`).
  `onActivate` is now a lifecycle no-op (no captured raw spine); `mutationFor`
  is unchanged (tests import it). Tests
  (`test/conformance/host-handler.spec.ts`, 3): a real pointer-up routed
  through the host handler lands the inserted anchor at the real wasm; the
  handler's effect equals the bundle's own `mutationFor(plan)` (no drift); a
  structural source check asserts no `paged.client`/`paged.selection`/
  `paged.camera`/`.elementSelection` reach remains and the five facades are
  used. The §4.9 detector is now silent — the tool would survive the isolate
  (async facades, no synchronous `paged.*` reach). Trust-line gate:
  `thoughts/docs/paged/plugin-trust-line.md`.
