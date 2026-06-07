# BREAKAGE_LOG — paged.draw vs. the plugin surface

Every place the de-facto plugin API (editor registries + catalog +
client, façaded by `@paged-media/plugin-api`) fell short of what
paged.draw needs. **This log is the API-v1 punch list** (concept
§12.3): entries drain as host/core work lands; nothing enters
`plugin-api@1.0` that didn't earn its place here.

Format: `B-NN · date · area · status`.

---

- **B-01 · 2026-06-06 · panel schema · OPEN** — the paper's
  `visibleWhen`/`enabledWhen` conditionals don't exist and are
  *rejected by design* (catalog binding ceiling: `literal |
  selectionProperty`, `editor/packages/catalog/src/types.ts`).
  Resolution direction: derived bound values from plugin state +
  expert leaves, not a conditional binding language. Until settled,
  `panels/*.panel.json` are design prototypes and real panels ship as
  expert-leaf React.

- **B-02 · 2026-06-06 · shell · OPEN** — no edit contexts (paper §5 /
  P0). Closest precursor: `useSelection().pathEditMode`. Needs an
  `EditContextRegistry` (enter on double-click via hit-test
  `groupChain`, panel/tool set swap, write-scope narrowing, breadcrumb,
  Esc pops). Tracked for the editor shell; draw's `manifest.json`
  already declares `editContexts: [{ type: "vectorGraphic" }]`.

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

- **B-07 · 2026-06-06 · overlays · OPEN** — `ToolPreviewShape` is
  rect-or-polyline only; in-progress pen cubics must be FLATTENED for
  preview (`flattenAnchorRun`). Fine at v0; a path/cubic preview
  variant (or the P2 retained overlay channel) removes the sampling.

- **B-08 · 2026-06-06 · pointer events · OPEN** — `CanvasPointerEvent`
  carries no pressure/tilt (Pointer Events expose them). Gates stylus
  input → variable-width strokes (§13.12, Tier B). Not a v1 blocker.

- **B-09 · 2026-06-06 · scripting/runtime · PARTIAL (2026-06-06)** —
  loop-iteration (10M) + recursion budgets now enforced via Boa 0.21
  RuntimeLimits (`paged-script`, incl. a fixed latent worker-abort
  when a limit tripped). Still open for the full §10 story:
  instruction metering / wall-clock interrupts and per-context memory
  caps (stock Boa has neither — upstream fuel or worker-level
  isolation). The open half stays a P7 gate, not a v1 blocker.

- **B-10 · 2026-06-06 · packaging · RESOLVED** — `@paged-media/sdk`
  npm name collision: it's core's WebGPU `ViewerSession`. Plugin
  runtime renamed `@paged-media/plugin-sdk` (sdk repo, 2026-06-06).

- **B-11 · 2026-06-06 · bundle surface · RESOLVED (2026-06-06)** — the
  editor's gesture-shim helpers were absorbed into
  `@paged-media/plugin-sdk` 0.2 as the gesture kit (`beginPageDrag`,
  `endLocalFor`, `pxToPt`, `commitAndSelect`); `draw-bundle` now
  registers its tools itself (D3, `src/activate.ts`).

- **B-12 · 2026-06-06 · engine ops · OPEN** — no dash-pattern
  `PropertyPath` (stroke panel's dash section, §13.5 stroke model).
  IDML carries it; the wire surface doesn't yet.

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
  headlessly; B-07). (3) one bundle per headless host in v1. (4) the
  IDML replay fixture is a minimal hand-authored package (the fidelity
  corpus stays private/LFS); a fixture CORPUS replay harness is the next
  step on this foundation.

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

- **B-16 · 2026-06-07 · engine ops / trust · OPEN** — the engine
  plugin-metadata gate has NO caller identity (audit P8). Per-plugin
  namespace isolation (`x-paged:<id>`) is enforced only in the SDK
  door (`host-impl.ts` `foreignMetadataKey`, recursive incl. batches);
  the engine op (`paged-mutate/src/apply.rs` `setPluginMetadata`)
  checks only the `x-paged:` prefix, the 64 KiB cap, and the JSON
  envelope — never WHICH plugin writes. A bundle holding the raw
  handle bypasses the door: `paged.client.mutate({ op:
  "setPluginMetadata", args: { key: "x-paged:<other>", … } })` writes
  another plugin's namespace directly. Benign for same-trust
  first-party bundles; a hard blocker for the P7 multi-vendor story.
  Real fix is caller identity at the engine boundary — only matters at
  the isolate boundary where `host.editor` dies anyway. Trust-line
  gate: `thoughts/docs/paged/plugin-trust-line.md`.

- **B-17 · 2026-06-07 · bundle surface / §4.9 · OPEN** — gesture
  handlers operate on the RAW spine handle, not the facades — the
  §4.9 API-gap detector firing unrecorded (audit P12).
  `draw-bundle/src/handlers/anchors.ts` reaches `paged.client.send`
  (hitTest, L103), `paged.client.pathAnchors` (L115),
  `paged.client.mutate` (L132), `paged.selection.elementSelection`
  (L111), `paged.camera.camera.scale` (L123) — all of which have
  facades (`host.document.hitTest/pathAnchors/mutate`,
  `host.selection.get`, `host.viewport.camera`/`pxToPt`), reached via
  the handle `onActivate(paged)` passes rather than through `host.*`.
  DESIGN.md §4.9: "any use of `host.editor` not reachable through a
  facade is a BREAKAGE_LOG entry." Benign in-process (same realm);
  the tool would NOT survive the isolate as written (synchronous
  `paged.*` reach, not the async facade). Resolution: migrate the
  handler onto `host.*` facades (the actual dogfooding test that the
  facade is sufficient for a real tool), or keep this entry until the
  isolate re-routes it. Trust-line gate:
  `thoughts/docs/paged/plugin-trust-line.md`.
