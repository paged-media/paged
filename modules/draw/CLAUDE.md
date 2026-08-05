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
C-30), REPEATS v1 (the Illustrator §12.4 row, and the catalog's SIBLING
of pattern — read the difference before the code: a PATTERN is a
swatch-shaped FILL, a REPEAT is an object TRANSFORM with expand/release.
Radial / grid / mirror, one AFFINE per instance in
`draw-geometry/src/repeat.ts` because a repeat rotates and REFLECTS where
a tile field only translates. It is the FIRST feature in this repo that
builds in ONE UNDO STEP: plugin-sdk `bc52766` put C-15's `bindCreated`
in the contract, so one batch inserts, binds, paints, links and groups —
measured, 200 instances in ~12 ms, one undo removes all of them.
EXPAND and RELEASE are Illustrator's two verbs and mean different things
(expand keeps every instance as artwork; release removes them and keeps
the source) — note this is pattern v1's pair spelled the OTHER way
round. CLIPPING is real, over B-18's `pasteInto`, and costs the second
undo step plus four measured consequences that are all asserted: a
clipped repeat has NO GROUP (`pasteInto` refuses a grouped child), a
clipped instance is INVISIBLE to `document.tree()` while still answering
geometry and metadata by id (so the recipe is its only index, and
clipping DEGRADES OFF without a container writer), `deleteFrame` REFUSES
a pasted-in child, and deleting the container ORPHANS its children. The
recipe is the FIFTH `.paged` container part here. The on-canvas control
is REAL but bounded and the code says where: a drag steers ONE parameter
and the overlay draws a GUIDE, because `setToolPreview` takes ONE
polyline; the artwork is rebuilt once on RELEASE, because a re-plan per
pointer-move would be an undo step per sample),
BLENDS v1 (§16.2 — wave 2's v0 was ONE command and two undo steps; the
CATALOG ROW is the three SPACING MODES, and all three reduce to a step
count: Specified Steps IS the count, Specified Distance divides the
SPINE's arc length, Smooth Color divides the COLOUR distance — the
largest per-channel difference between the two key fills. A TYPED count
over the 200 ceiling REFUSES and a DERIVED one CLAMPS, because a typo is
not data. THE SPINE is the path the intermediates follow and its default
— the straight line between the two keys — is PROVABLY INERT: a
default-options v1 blend places exactly the lerp v0 placed, so the spine
offset and the orientation turn both vanish and every deviation is
opt-in. TWO DELIBERATE DIFFERENCES FROM ILLUSTRATOR, both named in the
code: a replaced spine KEEPS ITS OWN PAINT (clearing a stroke the user
drew, unasked, is a worse surprise than a visible spine) and is NOT put
in the blend's group (so it stays selectable — the whole reason to
replace one). The two REVERSES are different verbs and both are built:
reverse SPINE moves geometry, reverse FRONT-TO-BACK moves nothing and
costs no `reorderElement`, because insertion order IS paint order. Easing
has a STRENGTH that is a blend, not an exponent, so strength 0 is the
identity for every curve; colour gets its own curve only when
`colorEasing` is non-null — that IS "independent colour acceleration".
The catalog's "live Blend panel preview" is honest about its scope: the
panel previews the PLAN — the resolved count and where it came from —
not the artwork, because re-rendering per keystroke is an undo step per
keystroke. SECOND consumer of C-15, so make/update/replace-spine/both
reverses/expand/release are ONE undo step EACH),
OBJECTS ON A PATH (§16.3 — and read this before the code: IT MOVES YOUR
OBJECTS AND CREATES NOTHING, which is the opposite of every other
arranging row here. One `setElementProperty { frameTransform }` per
object, so the objects on the path ARE the selected ones: element ids
survive, a foreign plugin's metadata on them survives, TEXT IS NOT
REFUSED (nothing copies a story because nothing is copied), and RELEASE
is an exact restore rather than an inverse. Nothing is grouped, nothing
is scaled to fit, and the count mode's count IS the object count —
there is deliberately no way to ask for more slots than objects, because
that is what a Repeat is), OPACITY MASKS and TYPE ON
A PATH (the two protocol-58 rows — see the v58 seam note below), SVG
import/export, and the `vectorGraphic` EDIT CONTEXT
(double-click a path-bearing kind → anchor-editing tool-set focused,
stroke panel raised, Esc pops out). The bundle drives end-to-end through the real editor host:
the draw-plugin e2e (`editor` `apps/canvas/tests/e2e/draw-plugin.spec.ts`)
and a DTP journey (`tests/journey/plugins/draw.journey.spec.ts`) author a
path with the built-in Pen, then refine its anchors (add/delete/convert)
and stroke through the bundle. The three TS packages carry 938 passing
vitest (geometry 210, tools 126, bundle 602) and typecheck clean; the two
crates carry 26 `cargo test` (draw-trace 22, trace-js 4).

**ONE SHARED KERNEL, AND ONLY ONE.** §16.2 (blend spines) and §16.3
(objects on a path) landed together, so the "is there a common placement
kernel?" question had to be answered with facts. There is, and it is
`draw-geometry/src/along-path.ts`: BOTH rows need *point + tangent at a
fraction of a path's ARC LENGTH*, which means flattening, cumulative
lengths, a lookup and a tangent — ~150 lines that go wrong twice if
written twice — plus the same count/spacing distribution rule on top
(`endpoints: "interior"` keeps a blend's intermediates off its keys;
`"inclusive"` puts the first and last object on an open path's ends).
What is deliberately NOT shared is everything ABOVE the slot list,
because there the two rows need DIFFERENT facts: a blend interpolates NEW
geometry between two shapes and offsets it onto the spine; objects-on-a-
path moves EXISTING elements — their own geometry, their own ids — about
a pivot. Those are three lines each and share nothing but the word
"affine". One measured detail the kernel carries because it would
otherwise be silently wrong: a COUNT distribution survives a
ZERO-LENGTH path (two CONCENTRIC key objects give a blend exactly that,
and collapsing it to one intermediate would drop every step of an
ordinary concentric blend); only SPACING collapses, because a zero-length
path has no gaps to walk.

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

**THERE ARE FOUR WIRE SEAMS, and they do not overlap.**
`handlers/planar-regions.ts` (K-11's arrangement query),
`commands/v58-wire.ts` (the C-28/C-29 quartet, below),
`binding-provider/adr023-seam.ts` (the ADR-023 binding-provider door AND
the one protocol-59 `reorderElement` its Layers lane needs) and
`commands/v59-wire.ts` (C-15's `bindCreated` + B-18's `pasteInto` /
`releaseFrom`, added with Repeats). Each op has exactly ONE builder and
it lives with its consumer; every repin is a deletion of casts.

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
  NOTE the editor USED to ship an INERT built-in `paged.tool.typePath`
  (a rail entry with no `gesture`, holding `shift+t`); a bundle cannot
  attach behaviour to a built-in id, so this tool joins the same `type`
  group beside it under `shift+h`.

**SHORTCUT REGISTERS — the note above is out of date and this is the
correction.** "`shift+z` is now the ONLY free shift key" was true until
the editor's `2e6f835` ("no more dead rail entries — wire six, stub
five, retire four", 2026-08-03) RETIRED three inert built-ins and freed
their keys: `shift+t` (the placeholder Type on a Path), `i` (a dead
Eyedropper) and `k` (a dead Measure). The current global picture:
- editor built-ins hold `v a u b t \ p n f m l c e r s o g h z` plus
  `shift+p` / `shift+g`, and `w` as the preview toggle;
- paged.image holds `shift+x y shift+y shift+l shift+w q shift+f shift+e`;
- paged.draw holds `= -` plus
  `shift+c/u/n/a/m/b/r/j/k/i/d/s/q/o/v/h`.
So the free registers are exactly `shift+t`, `i`, `k` and `shift+z`. THE
FIRST THREE ARE EACH THE CANONICAL KEY OF A paged.draw TOOL CURRENTLY ON
A SUBSTITUTE — `shift+t` → Type on a Path (on `shift+h`), `i` →
Eyedropper (on `shift+d`), `k` → Live Paint Bucket (on `shift+o`) — and
the editor's own retirement note asks paged.draw to claim them for those
tools. `shift+z` reads as an undo variant on every platform and would be
a trap. That is why the §12.4 REPEAT tool ships with NO shortcut: a
keyless working tool is honest (`paged.tool.smooth` is one), a stolen
canonical key is not. Moving the three tools onto their canonical keys
is a separate, deliberate change — do it as one pass, not by taking one
key here. **The §16.2 and §16.3 rows changed nothing above**: they ship
as COMMANDS AND PANELS ONLY, with no new tool and therefore no shortcut
question at all. `shift+t`, `i`, `k` and `shift+z` are still the four
free registers, and the first three are still owed to the tools whose
canonical keys they are.

**`.paged` CONTAINER PARTS: there are now SEVEN** — graphic styles,
symbols, live paint, pattern, repeat, blend (`blend.json`) and objects-on-
path (`objects-on-path.json`). The last one is the only feature whose
recipe is NOT load-bearing: each object's HOME transform rides its own
metadata link, so release and update work on a host with no container
writer and only the distribution PARAMETERS are lost there.

**RFI C-15 IS NOW IN THE CONTRACT AND THE TWO-BATCH FLOOR IS BROKEN.**
This section used to say C-15 had landed in core but was unreachable
here, blocked purely by `@paged-media/plugin-api`. That changed:
plugin-sdk `bc52766` ("plugin-api: carry `bindCreated` — the op that
collapses two-batch flows") added `BindCreatedMutation` to the
protocol-ahead `PendingMutation` delta. This repo still installs the
PUBLISHED `0.2.25-canary.0`, which predates it, so the op rides ONE cast
seam — `commands/v59-wire.ts`, the `v58-wire.ts` precedent — and the
repin is a pure deletion.

REPEATS v1 is the first consumer and builds in ONE UNDO STEP. Everything
measured against the booted engine (protocol **60** — the local wasm
carries `LayerSummary.parentId`; the harness booted 60, not the 59 an
earlier note claimed while correcting a staler 58) and pinned in
`repeat.spec.ts`:
- the bind must come AFTER its creating child; before it the batch is
  refused BY NAME ("has nothing to name — no creating child ran before
  it in this batch");
- it is its OWN op — a handle inside a creating op's `args` is SILENTLY
  ignored and the later `$h:` then fails with "node not found";
- `"$h:<handle>"` resolves in every id position this repo uses: an
  `ElementId.id`, a bare-string `deleteFrame.frameId`, a
  `setElementProperty.elementId` (INCLUDING the `framePath` compound
  re-merge door), a `createGroup.memberIds` entry, and BOTH ends of
  `pasteInto`;
- 200 inserts + binds + property writes apply in one batch in ~12 ms and
  ONE undo removes all of them.

ONE MEASURED EDGE, recorded in `v59-wire.ts` because it is why repeats
never addresses a group it minted: with an EARLIER `bindCreated` present
in the same batch, a `bindCreated` placed after a `createGroup` resolves
inconsistently — `deleteFrame { frameId: "$h:g" }` reaches the GROUP
(and is refused, since deleteFrame refuses groups) while `dissolveGroup
{ groupId: "$h:g" }` refuses with "node not found: Group(<the earlier
insert's id>)". With no earlier bind, the dissolve resolves correctly.
Repeats reads the previous group out of the TREE before it builds.

BLENDS v1 is the SECOND consumer and is likewise ONE undo step for every
verb (`blend.spec.ts` measures make / update / both reverses / expand /
release). OBJECTS ON A PATH is one too, and for a different reason worth
keeping separate: it creates NOTHING, so it needs no `bindCreated`, no
batch-ordering rule and no group — just N `frameTransform` writes in one
batch.

THE OTHER SIX FLOWS ARE STILL TWO BATCHES — `pattern.ts`,
`appearance-bake.ts`, `compound-path.ts` (release), `symbols.ts`,
`image-trace.ts`, `live-paint.ts` — and each is now one mechanical edit
away from one, not a redesign. Their "TWO batches ⇒ 2 undo steps" notes
are still TRUE as shipped; the reason is no longer "the contract cannot",
it is "not yet converted".

**THE `frameTransform` DOOR, and three things measured about it** (the
§16.3 lane rides it; protocol 60):
- it REPLACES an element's item transform, it does NOT compose with it.
  Writing the same rotation twice leaves the object at 30°, not 60° —
  which is what makes an idempotent Update and an EXACT (not inverse)
  Release possible at all;
- `elementGeometry.bounds` is the frame box in the element's OWN space
  and is NOT recomputed by a transform, nor — separately measured — by a
  `framePath` write. The transform comes back beside it, so page space is
  `transformBounds(bounds, itemTransform)`. Anything reading `bounds` as
  if it were page space is wrong on any transformed element;
- N writes in ONE batch is ONE undo step.

**RFI C-23 IS NARROWER THAN "PAGE-KEYED" SUGGESTS, and two plausible
readings of it are FALSE.** Both were written into `objects-on-path.ts`
as fact and then deleted when they were measured:
- `getMetadata` is NOT page-keyed, and neither is `document.tree()`. An
  element moved off the page still answers its own link and is still
  listed in the tree. What goes silent is `elementGeometry` /
  `pathAnchors` — the GEOMETRY, which is exactly what a re-distribution
  needs. So an off-page element is never LOST, only unmeasurable, and a
  write BY ID still reaches it. (An earlier claim here that an off-page
  element "answers nothing, not even its metadata" came from a probe
  whose stamp had been refused for a NAMESPACE reason — the bundle was
  not loaded. Load the bundle before concluding anything about
  `setPluginMetadata`.)
- there is no simple "outside the rect" threshold. A 300 pt box hanging
  38 pt past the right edge AND 50 pt above the top still answers
  everything; the same box starting 500 pt across a 612 pt page does not.
  Where the engine draws that line is NOT modelled here and no guess
  about it is recorded — §16.3's artboard fit simply applies the stricter
  "fully inside" rule, so it never needs to know.

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

**B-18 NESTING IS REAL, and `commands/group.ts`'s old "a 'paste into'
cannot be expressed end-to-end" note was wrong — it is corrected in
place.** `pasteInto { containerId, childId }` nests a top-level item
inside a container Rectangle / Oval / Polygon, where it renders CLIPPED
by that container's outline; `releaseFrom { childId }` pops it back.
Repeats' clipping ships on the pair. FOUR consequences, all measured and
all asserted in `repeat.spec.ts` — read them before building anything
else on nesting:
1. a nested child CANNOT be grouped ("B-18: a grouped item cannot be
   pasted into a frame (ungroup first)"), so clip and group are
   mutually exclusive;
2. a nested child is INVISIBLE to `document.tree()` — the container
   reports NO children — while `getMetadata` / `elementGeometry` /
   `pathAnchors` all still answer for it BY ID. So nothing that walks
   the tree can enumerate nested artwork, and anything that nests must
   keep its own index;
3. `deleteFrame` REFUSES a nested child ("B-18: the item is pasted into
   a container — release it before removing") — release first;
4. deleting the CONTAINER does not delete its children, it ORPHANS them:
   they leave the tree and still answer `elementGeometry`. Delete the
   children first, the container last.
What is still NOT representable is a clip GROUP — an arbitrary clip path
over a set of items. The `GroupSpec` has no clip flag and core's parsed
`Group` has no mask member; that half stays in the RFI.

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
