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
Compound-Path pair (Make / Release), PATTERN EDITING v1 (a re-editable
tile FIELD — and read this before the feature name: "save as a pattern
SWATCH" IS NOT BUILDABLE and is not faked. There is no pattern paint type
in IDML, none in `paged_model::Graphic` and none on the wire —
`SwatchSpec`/`GradientSpec` are the only two shapes
`createSwatch`/`createGradient` accept — so a field produces ARTWORK, not
a fill. Filed as RFI C-31: a new paint kind + renderer support in BOTH
backends + an IDML representation decision, i.e. core work. What v1 DOES
deliver is everything else the catalog row asks for, and each item was
one of v0's measured ceilings: real parameters — grid/brick/hex
lattices, tile size, spacing where NEGATIVE is a geometric overlap, copy
counts, dimming as a real `frameOpacity` on the copies, and `overlap` =
which copy paints in FRONT, expressible only because insertion order IS
paint order (so the vertical choice wins, being the outer sort, and the
SOURCE can never be lifted above its copies); an ARTBOARD-AWARE tile
count read from the `pages` collection's `sizePt`, so v0's off-page tiles
— created, grouped and unreadable, because `pathAnchors`/`elementGeometry`
are page-keyed (RFI C-23) — now happen only behind an explicit
`fitToArtboard: false` the spec still pins; and RE-EDITABILITY: re-plan
with new parameters AND fresh source geometry, release, un-bake, select
tiles. The recipe is a `.paged` container part — the fourth in this
repo, after graphic styles / symbols / live paint — with per-leaf links,
so Release and un-bake work even on a host with no container writer
(only the PARAMETERS are lost there). The Pattern Options React panel is
where the not-a-swatch boundary is put in front of the user, and its
wording is pinned by a test. A v0 `patternTile` stamp
reads as the legacy field `""`: releasable and un-bakeable, not
re-plannable. Two batch-ORDERING rules are measured and load-bearing —
a batch that deletes then inserts is refused, and a group must be
DISSOLVED before its members are deleted), IMAGE TRACE v0,
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
nine-slice / 3D mapping are named as unbuilt rather than implied), LIVE
PAINT v0 (the last unbuilt Illustrator Phase-2 row — and the third
library-in-a-container-part feature. Read the word REGENERABLE before
the word LIVE: the engine has NO `LivePaintGroup` node and no persistent
face/edge ids, only B-22's per-call planar QUERY whose ids
(`<signature>#<component>`) index into the REQUEST's own ordered
`elementIds`. So a group is a RECIPE — the ordered members plus a paint
per face id — and a painted face is REAL ARTWORK inserted over the
region; editing a member repaints nothing until Regenerate re-derives,
and a face id an edit retires loses its paint with a report. GAP options
and EDGE stroking are NOT built and the code says exactly why: the
arrangement door takes no tolerance, the kernel names gap detection as
out of scope, every input subpath is implicitly CLOSED, and the wire
carries no edge id at all. The 12-input / 256-face caps REFUSE with the
engine's own sentence on the pathfinder status binding. Filed as RFI
C-30), OPACITY MASKS and TYPE ON A PATH (the two protocol-58 rows — see
the v58 seam note below), SVG import/export, and the `vectorGraphic` EDIT
CONTEXT
(double-click a path-bearing kind → anchor-editing tool-set focused,
stroke panel raised, Esc pops out). The bundle drives end-to-end through the real editor host:
the draw-plugin e2e (`editor` `apps/canvas/tests/e2e/draw-plugin.spec.ts`)
and a DTP journey (`tests/journey/plugins/draw.journey.spec.ts`) author a
path with the built-in Pen, then refine its anchors (add/delete/convert)
and stroke through the bundle. The three TS packages carry 775 passing
vitest (geometry 162, tools 113, bundle 500) and typecheck clean; the two
crates carry 26 `cargo test` (draw-trace 22, trace-js 4).

**THE STRUCTURAL VERBS ARE NOT THIS BUNDLE'S.** Group / Ungroup /
Select parent group used to be `media.paged.draw.command.*`, which meant
a user without paged.draw loaded could not group — although `createGroup`
/ `dissolveGroup` have been wire ops the whole time. They are HOST
commands now (`paged.object.group` / `.ungroup` / `.selectParentGroup`
in `editor` `apps/canvas/src/object-commands.ts`, alongside the four
Arrange verbs the editor never had), and their conformance moved with
them to `apps/canvas/tests/e2e/object-commands.spec.ts`. Basic object
operations are what plugins BUILD ON, so exactly one implementation
ships and it is the host's. What stayed here is what draw's own features
compose: the wire shapes in `commands/group.ts` (Pattern's re-plan,
Symbols' instance grouping, Image Trace's contour grouping) and the pure
`parentGroupOf` walk in `commands/parentage.ts` (Appearance bake,
Symbols). Do not re-add a plugin-side Group command — `activate.spec.ts`
and `headless-conformance.spec.ts` both assert its absence.

**The planar arrangement has ONE seam.** `draw-bundle/src/handlers/planar-regions.ts`
owns the `requestPlanarRegions` escape hatch (the vendored contract still
has no `document.planarRegions` facade — RFI K-11 built it, unpublished),
the once-per-gesture-scope cache with its cold-start / face-cap point
queries, the raw↔page face mapping and the refusal reporter. Shape
Builder and Live Paint both ride it; a third region tool must too, and a
K-11 repin is a rewrite of ONE function plus deleting two local wire
types.

**PROTOCOL 58 has ONE seam too.** `draw-bundle/src/commands/v58-wire.ts`
owns the four C-28/C-29 ops (`applyOpacityMask` / `releaseOpacityMask` /
`attachTextToPath` / `detachTextFromPath`), their capability probes and
their refusal reader — so the skew lives in one file and the repin is a
pure deletion of four casts. The skew is NARROWER than the v56/v57 ones
were: plugin-sdk `f00d6dd` already added typed definitions for all four
to `@paged-media/plugin-api`'s hand-maintained protocol-ahead delta
(`packages/plugin-api/src/mutations.ts` → `PendingMutation`, plus a
`MutationInput = Mutation | PendingMutation`), so the cast points at a
contract that EXISTS and is COMMITTED and the arg shapes match it
field-for-field. It is still needed only because this repo installs the
PUBLISHED `0.2.25-canary.0`.

Two honesty facts these rows carry, and neither may be softened:
- **An opacity mask does NOT render on canvas.** Core honours it in the
  CPU rasterizer and in PDF export, but NOT in the Vello/WebGPU backend
  the editor draws through (`push_layer` takes a shape, not a coverage
  buffer). So there is deliberately no panel, no overlay and no preview:
  the command TITLE carries the gap (the `pattern.ts` precedent), the
  success log repeats it, and `OPACITY_MASK_CANVAS_NOTE`'s wording is
  pinned by a conformance test.
- **Type on a Path FLOWS AN EXISTING STORY.** No wire op mints a bare
  story (`insertTextFrame` mints one BOUND to its frame, and a flowed
  story is refused), so the attach resolves a FREE story — empty frame
  chain AND unclaimed by a path stamp, because a path-attached story
  reports an empty frame chain exactly like an unflowed one — and its
  refusal names the workflow that produces one (type into a frame,
  delete the FRAME). A "seed a story" command is deliberately NOT built.
  `PathEffect` is likewise not offered: only `RainbowPathEffect` renders.
  NOTE the editor already ships an INERT built-in `paged.tool.typePath`
  (a rail entry with no `gesture`, holding `shift+t`); a bundle cannot
  attach behaviour to a built-in id, so this tool joins the same `type`
  group beside it under `shift+h` — retiring the placeholder is an
  editor-side call. `shift+z` is now the ONLY free shift key.

**RFI C-15 has LANDED in core (b8e2b6b) but is NOT reachable from here
yet — and the two-batch floor is now provably a CONTRACT floor, not an
engine one.** Re-measured 2026-08-04 while building Pattern Editing v1,
and pinned by a conformance test in `pattern.spec.ts` so the claim stays
falsifiable: the booted v58 engine speaks C-15 END TO END. `{ op:
"bindCreated", args: { handle } }` placed AFTER a creating child makes
`$h:<handle>` address that child's minted id and the batch applies;
placed BEFORE it, the engine refuses with its own sentence ("has nothing
to name — no creating child ran before it in this batch"). It is a
SEPARATE op, not a field on `insertPath` — passing `bindCreated` inside
the insert's args is silently ignored and the later `$h:` reference then
fails with "node not found". What blocks the collapse is purely the
contract: `@paged-media/plugin-api`'s `Mutation` union carries no
`bindCreated` arm, and neither does the protocol-ahead `PendingMutation`
delta plugin-sdk HEAD maintains (re-checked at `f00d6dd`, and in the
published `0.2.25-canary.0`). So every insert-then-style flow here stays
at two batches by DISCIPLINE, and the "TWO batches ⇒ 2 undo steps" notes
in `pattern.ts` / `appearance-bake.ts` / `compound-path.ts` (release) /
`blend.ts` are still TRUE as shipped — but the reason has changed, and
core's own commit message listing exactly those four as collapsible is
now correct about the engine. Re-check when the contract bumps; the fix
is a regeneration, not a redesign.

**Two batch-ORDERING rules the engine enforces**, both measured and both
load-bearing for any bake-then-rebuild flow (Pattern v1's re-plan is the
first consumer of the second):
- A batch that DELETES and then INSERTS is refused — "position N out of
  range for parent Spread" — because the insert's z-position resolves
  against the spread length the batch STARTED with. Inserts ride batch 1,
  deletes ride batch 2. (Insert-then-delete in one batch is fine.)
- A group must be DISSOLVED BEFORE its members are deleted. Deleting
  first leaves the group holding a hole and the dissolve is refused with
  "group has an id-less member that cannot round-trip".

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
