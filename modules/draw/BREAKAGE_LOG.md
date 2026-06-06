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

- **B-03 · 2026-06-06 · engine ops · OPEN (verify first)** — gradient
  *assignment*. Gradients exist as swatches (`createGradient`) but the
  toolbar gap note says no op applies one to a frame. Verify whether
  `setElementProperty{ path: "frameFillColor", value: colorRef("Gradient/…") }`
  is accepted by `paged-mutate/src/apply.rs`; if not, add a path. The
  on-canvas annotator then rides `frameGradientFillAngle`/`Length`.

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

- **B-09 · 2026-06-06 · scripting/runtime · OPEN (P7 gate)** — Boa is
  synchronous, no time budget, no per-plugin isolate; §10/§11 safety
  guarantees unbuildable. Deliberately NOT on the v1 critical path —
  third-party-beta blocker only.

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

- **B-14 · 2026-06-06 · shell rail · OPEN (cosmetic)** — rail slot
  order is first-seen group order, so a bundle registered after mount
  lands its slot at the END of its section instead of the catalog
  position (pen slot now trails pencil/shape). Needs a slot-order hint
  on `ToolContribution` (per-section `order`) honored by
  `ToolRail.deriveSections`.

- **B-15 · 2026-06-06 · shell shortcuts · OPEN (worked around in SDK)**
  — the host builds tool activation commands + shortcuts only for the
  STARTUP tool set (`buildToolbarContributions` over the `tools` prop);
  late-registered tools get a rail slot but no shortcut.
  `@paged-media/plugin-sdk`'s `contributeTool` closes the gap
  bundle-side (tool + activation command + text-suppressed
  keybinding); the host-side fix is to derive shortcuts from the
  registry instead of the prop.
