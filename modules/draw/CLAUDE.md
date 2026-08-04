# CLAUDE.md

Orientation for Claude sessions in **paged-media/plugin-draw** — the
paged.draw vector plugin (public; dual-licensed AGPL-3.0 OR PMEL, And The
Next GmbH; license headers on every source file).

## What this is

The distillation repo for draw capability during the
incubate-then-extract window (strategy:
`thoughts/docs/paged/plugin-draw/reality-check.md`). Three packages:
`draw-geometry` (pure math), `draw-tools` (host-agnostic state machines),
`draw-bundle` (manifest + `activate(host)`). The editor consumes
geometry/tools via pnpm `link:` and wraps the machines in thin
`GestureHandler` shims.

Since Image Trace (2026-08-04) there is ALSO a Rust half, in `crates/`:
`draw-trace` (the tracer kernel over the `visioncortex` crate — colour
clustering, boundary walking, spline fitting) and `trace-js` (its
wasm-bindgen surface). The built artifact lands in
`packages/draw-bundle/wasm/`, which is BOTH the manifest-relative path
declared under `capabilities.wasm[]` and the path `src/trace-engine.ts`
imports — one copy, so the manifest/package drift that bit paged.image
cannot happen here. `scripts/build-wasm.sh` builds it; the artifact is
COMMITTED so a fresh checkout tests and typechecks with no Rust
toolchain.

`draw-bundle` is past "skeleton" — `activate(host)` contributes a full
toolset via `contributeTool` (the Add/Delete/Convert anchor editors in
the pen flyout, plus the Curvature/Pencil/Gradient-Annotator/Measure/
Shape-Builder pro tools), the Stroke + Fill schema panels, the
Appearance/Dash/Path-Ops/Select-Same/Live-Corners commands, the
Compound-Path pair (Make / Release), the Pattern bake, IMAGE TRACE v0,
GRAPHIC STYLES (a named, LINKED complete appearance — the library is a
document-resident `.paged` container part written through `host.parts`
and declared in `contributes.partTypes`; the link is a reference on the
element's own metadata envelope, a direct appearance edit marks the
element OVERRIDDEN without breaking the link, and a redefine overwrites
that override), SYMBOLS v0 (its sibling, same shape: a named artwork
DEFINITION in a SECOND container part + INSTANCES re-emitted from it.
Core has no symbol/instance model, IDML has no such primitive, and the
`Mutation` union has no element-duplicate op — so an instance is
`insertPath` geometry + flat paint carrying a per-LEAF link, because a
group cannot hold metadata. Registration points are the §16.1 nine-point
grid; redefine and reset REBUILD an instance rather than re-point it.
TEXT is refused (no op copies a story), and the eight symbol-SET tools /
nine-slice / 3D mapping are named as unbuilt rather than implied), SVG
import/export, and the `vectorGraphic` EDIT CONTEXT (double-click a
path-bearing kind → anchor-editing tool-set focused, stroke panel raised,
Esc pops out). The bundle drives end-to-end through the real editor host:
the draw-plugin e2e (`editor` `apps/canvas/tests/e2e/draw-plugin.spec.ts`)
and a DTP journey (`tests/journey/plugins/draw.journey.spec.ts`) author a
path with the built-in Pen, then refine its anchors (add/delete/convert)
and stroke through the bundle. The three TS packages carry 643 passing
vitest (geometry 162, tools 102, bundle 379) and typecheck clean; the two
crates carry 26 `cargo test` (draw-trace 22, trace-js 4).

**RFI C-15 has LANDED in core (b8e2b6b) but is NOT reachable from here
yet.** A batch can now address an id an earlier child minted
(`bindCreated { handle }` + `$h:` references), and the locally-synced
engine wasm speaks it — but `@paged-media/plugin-api`'s `Mutation` union
carries no `bindCreated` arm (checked in the published
`0.2.25-canary.0` AND in plugin-sdk's unpublished HEAD source). Until the
contract package regenerates its wire types, every insert-then-style flow
in this repo stays at its two-batch floor, and the "TWO batches ⇒ 2 undo
steps" notes in `pattern.ts` / `appearance-bake.ts` / `compound-path.ts`
(release) / `blend.ts` are still TRUE, not stale — even though core's own
commit message lists exactly those four as collapsible. Re-check this
when the contract bumps.

## Hard rules

- **Host-agnostic means host-agnostic.** `draw-geometry` has zero deps;
  `draw-tools` may import ONLY `draw-geometry` + *types* from
  `@paged-media/plugin-api`. Never import `@paged-media/shell` /
  `@paged-media/client` / React here — that's the editor shim's job. If a
  machine seems to need host state, the missing piece is an event/option
  on the machine API or an RFI gap (the BREAKAGE_LOG was retired 2026-06-12, fully drained).
- **`@paged-media/plugin-api` is the only sanctioned contract import.**
  A need it can't meet goes to the cross-repo RFI (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`); the
  log is the API-v1 punch list — keep it current, mark entries RESOLVED
  with a pointer when host/core work lands.
- **Machines stay pure + unit-tested.** Page-local pt in, snapshots/plans
  out; tolerances are passed in (the host converts px→pt at zoom). Every
  behavior change lands with a vitest case (`packages/*/test/`).
- **Wire compatibility is asserted, not assumed.**
  `draw-tools/src/wire-compat.ts` type-asserts machine output against the
  engine wire types; a protocol break fails `pnpm typecheck` here. Don't
  delete those assertions to make a build green — they're the §12.3 alarm.
- **`panels/*.panel.json` are design prototypes.** Not interpreted by any
  host; keep them honest against the catalog's binding ceiling (no
  invented conditionals).
- **Install order:** editor → plugin-sdk → plugin-draw (`link:` chain).
- **The Rust half is the EXCEPTION, not the new normal.** `crates/` exists
  because Image Trace's kernel is computer vision, not path algebra, and
  `visioncortex` already is that kernel. Path math still belongs in
  `draw-geometry` — in particular the tracer does NOT decide winding: it
  reports contours, and `makeCompoundTable` (`mergeCompound` +
  `orientForNonZeroHoles`) re-winds holes by nesting depth, because the
  engine fills NON-ZERO. There is exactly one winding implementation in
  this repo and it is in TS.
- **`flo_curves` 0.3 (transitively, via visioncortex) is NOT the version
  the engine had to patch.** Core patches flo_curves 0.8 for a
  non-transitive comparator in `GraphPath::exterior_paths` that aborts
  under driftsort. visioncortex touches flo_curves only for
  `Coordinate`/`Coordinate2D` trait impls and `bezier::Curve::fit_from_points`
  — it never constructs a `GraphPath` — and 0.3.1 does not contain that
  comparator at all. Recorded in the workspace `Cargo.toml`; re-check it
  if the dependency is ever bumped.

## Commands

```bash
pnpm install && pnpm test && pnpm -r typecheck
node ../plugin-sdk/packages/plugin-cli/bin/paged-plugin.mjs validate packages/draw-bundle/manifest.json

# The Rust half (only needed when crates/ changes — the artifact is committed)
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
./scripts/build-wasm.sh   # → packages/draw-bundle/wasm/, enforces the size budget
```
