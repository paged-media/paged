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

- **B-04 · 2026-06-06 · engine ops · OPEN** — no group creation.
  `NodeSpec` has no group variant; `NodeId::Group` exists read-side.
  Blocks clipping masks, boolean-result grouping, layers panel
  structure (§13.4/§13.8).

- **B-05 · 2026-06-06 · geometry kernel · OPEN** — no outline-stroke,
  offset-path, or simplify ops in core (`flo_curves =0.8` does
  booleans + Schneider fitting only). §13.3 Tier-A rows blocked.
  Direction: add kurbo (`kurbo::stroke()`), expose
  `outlineStroke` / `offsetPath` / `simplifyPath` Mutations.

- **B-06 · 2026-06-06 · hit-testing · OPEN** — no point-on-curve query
  across the boundary (`hit_path_anchor` is nearest-anchor only).
  draw-tools mirrors `closestTOnCubic` in TS (third copy of the math —
  core, shell overlay, here). A `nearestPathPoint` worker query would
  collapse them.

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

- **B-13 · 2026-06-06 · testing · OPEN** — no headless host
  (`@paged-media/plugin-sdk` `createHeadlessHost` throws by design).
  Conformance fixtures can't replay against a real engine outside the
  editor app; needs the engine wasm consumable headless (Decision B or
  a node loader). Until then: pure-machine unit tests + editor
  Playwright E2E.

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
