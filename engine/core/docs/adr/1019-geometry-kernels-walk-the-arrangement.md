# ADR 1019 — The planar arrangement is a face walk; offsets and variable width work on whole paths

- **Status:** Accepted 2026-10-25.
- **Scope:** protocol v76 (additive; no bump). `paged-mutate` (`planar.rs`, the new
  `planar_dcel.rs`, the new `stroke_kernel.rs`, `kurbo_kernel.rs`,
  `apply/path_topology.rs`, `apply/planar_ops.rs`, `Value::OffsetPath.side`); `paged-wire`
  (`Mutation::OffsetPath.side`); `paged-canvas` (its translation); `paged-script`
  (`paged.offsetPath(…, side?)`); `paged-introspect` (the catalog row); `paged-perf` (the
  planar workload, budgets and bench). Amends the offset half of
  [ADR 004](004-kurbo-geometry-kernel.md). Gaps D-7, D-9, D-11 and D-15.

## Context

Four geometry kernels of `paged-mutate` stopped short of the paths documents hold.

- **Offset (D-7).** `offset_closed_path` offset ONE closed contour. Anything else — a compound
  path with holes, an open path, several subpaths — was sent to `outline_stroke` at `2·|δ|`
  with butt caps: the two-sided BAND around every contour. A ring offset outward came back as
  two 20 pt bands, not a bigger ring with a smaller hole. An open path had no one-sided
  offset.
- **Variable width (D-9).** `variable_width_outline_stroke` outlined a single open contour,
  took `cap`, `join` and `miter_limit` and ignored all three: butt ends, and every corner
  pinched to `cos(φ/2)` of the width. A multi-subpath input was refused.
- **Planar arrangement (D-11).** `planar.rs` built `flo_curves`' collided `GraphPath` once,
  then materialised EACH face with a ray-casting pass over the whole graph
  (`set_edge_kinds_by_ray_casting` → `heal_exterior_gaps` → `exterior_paths`), discovered the
  faces by ±ε probes off every edge, and fell back to `(∩ signature) − (∪ rest)` boolean
  chains when the healing failed. That is O(F·E), and it is why the caps were 12 inputs and
  256 faces. Shape Builder, Live Paint and the six Pathfinder region verbs all sat behind
  those caps.
- **Robustness (D-15).** `flo_curves`' `exterior_paths` point sort is not a strict weak
  ordering (C-21); the arrangement called it once per face.

## Decision

**The arrangement is a doubly-connected edge list, walked once** (`planar_dcel.rs`).

1. `flo_curves` still SPLITS: `from_merged_paths` + `self_collide` cuts every input curve at
   every crossing (a bounding-box sweep plus curve clipping; the one numerically hard step,
   unchanged, on the same 1/64 pt grid).
2. The collided graph is read ONCE into a DCEL. Points closer than 1/512 pt are one vertex;
   zero-length edges and loops no wider than the grid (what `flo_curves` leaves when it merges
   the ends of a grid-step edge) go. `flo_curves` works to the 1/64 pt grid, so an edge can run
   through another's vertex without being split there; every edge is split at each vertex
   lying on it (within half a grid step — a vertex a whole step away is a neighbour, and
   splitting at it would make two edges cross). Coincident edges — judged GEOMETRICALLY, each
   curve's quarter points on the other within two grid steps, because two pieces of one
   straight edge with collapsed handles trace it at different speeds — collapse into one edge
   carrying the SET of inputs it toggles (the symmetric difference of theirs); an edge that
   toggles nothing separates nothing and is dropped, with the dangling chains that leaves.
3. Each vertex sorts its outgoing half-edges by where each curve first LEAVES a circle around
   the vertex (half the shortest incident reach). Curves that do not cross leave any such
   circle in their true cyclic order, so tangent curves — where the tangents tie — sort
   correctly too.
4. `next(h)` is the half-edge clockwise-adjacent to `twin(h)` at its end vertex; following it
   walks every cycle once, each face on its left. Bounded faces have positive area; each
   connected component has one negative cycle, its outer boundary, which becomes a HOLE of the
   smallest bounded face (of another component) containing one of its vertices.
5. **Signatures by toggling.** Crossing an edge flips membership of exactly the inputs it
   toggles (even-odd, `flo_curves`' convention), so one breadth-first pass from the outside
   (signature `{}`) labels every face. Each face is then checked by ONE point-in-path test per
   input whose box holds an interior point of the face; where the two disagree the point test
   wins and `PlanarStats::signature_corrections` counts it (0 on every recorded input).
6. Adjacent faces with the same signature are one face. Every face's outline — and every union
   of faces Shape Builder, Trim, Merge and Minus Back ask for
   (`PlanarArrangement::union_of`) — is read off the walk: the half-edges with the face on the
   left and something else on the right, chained around each vertex. Shared boundaries
   dissolve without a boolean.

What stays: the face model (a face is a connected component of one signature's region, holes
as extra subpaths), the face ids (`"<signature>#<component>"`, components ordered by their
top-left anchor), `face_at_point` answering the same id the full enumeration does,
`arrangement_edges` for Outline, and `complete` as the honest tiling check (the summed face
area against the area the walk's outer boundaries enclose minus the faces nothing covers).
The existing arrangement and region-verb tests pass unchanged.

**The Shape Modes are face selections** (`pathfinder::pathfinder_boolean`). Unite is every
face, Intersect the faces inside all inputs, Minus Front the faces inside the top input only,
Exclude the faces inside an odd number of inputs — each read off the walk as a union of faces
and turned counter-clockwise (C-81). The boolean property suite found `flo_curves`'
per-operation sweeps losing area where two inputs are tangent or a grid step apart (an
Exclude of a circle and a rectangle against its tangent answering 1849 pt² where Unite minus
Intersect is −244, and the Unite of a rectangle with its copy one grid step over answering
nothing); the face walk does not. The sweeps stay as the answer when the arrangement refuses an input (over its
budget). Every recorded Pathfinder case — the 8 booleans, the 9 region verbs, the compound and
direction cases — answers as before.

**Caps and a budget.** `MAX_PLANAR_INPUTS` is 1000 and `MAX_PLANAR_FACES` 100 000. Behind
them, `PlanarLimits` is an OPERATION budget, not a clock: the curve pairs whose boxes overlap
are counted by a sweep BEFORE the collision pass runs (4 M by default), the collided edges are
capped (1 M), and past either the build stops with `PlanarError::OverBudget { stage, work,
budget }` — "planar arrangement is over its budget in the collision stage (…); refine the
selection". It is deterministic (the same input is refused on every machine) and needs no
clock, which the wasm worker does not have. `build_arrangement_with` reports progress per
stage (collide, walk, faces) through a callback. The wire has no progress channel for a read
(`RequestPlanarRegions` answers once), so the editor sees the refusal, not a bar; a progress
door is future work.

**Offset works on whole paths** (`stroke_kernel::offset_path`).

- One closed contour: `offset_closed_path`, unchanged.
- A compound of closed contours: each contour's ROLE comes from its nesting depth (even = it
  bounds filled area from outside, odd = a hole). Growing the shape outsets the even ones and
  insets the odd ones, shrinking it the other way round; the pieces are folded depth by depth
  with the Pathfinder booleans (depth 0 united, every odd depth subtracted, every even depth
  united back). A hole that shrinks past nothing vanishes, outer contours that grow into each
  other merge, an island in a hole stays an island. Outer contours clockwise on the page,
  holes the other way (C-81).
- An open contour, `side` absent or `"both"`: the two-sided band of width `2·|δ|`, its ends
  following the join — butt for miter and bevel, ROUND for round — because that is what
  Illustrator answers (recorded below).
- An open contour, `side: "left" | "right"`: ONE open parallel path on that side of the
  direction of travel on the page (a negative δ lands on the other side). Each segment is
  offset exactly (`flo_curves`' parallel curves, the bevel offset's own); where neighbouring
  offset segments part the gap gets the join (miter while `1/cos(φ/2) ≤ limit`, round as a
  cubic arc of radius `|δ|`, bevel), where they cross they are trimmed at the crossing. A
  crossing between segments that are NOT neighbours (an offset wider than a whole segment) is
  left in place: an open path has no fill to resolve it against.

The wire carries `side` as an additive `#[serde(default)]` field of `Mutation::OffsetPath`
and `Value::OffsetPath`: absent is the old behaviour, so no protocol bump.

**Variable width is built per vertex** (`stroke_kernel::variable_width_outline`). The
centreline is flattened per segment so the path's own anchors are known. A smooth vertex is
pushed along the normal of the chord between its neighbours, as before. An anchor where the
path turns gets the JOIN on its outer side (the miter rule above, round as a cubic arc, bevel)
and meets at the crossing of the two offset chords on its inner side (or loops through the
centre when that crossing lies off both chords — correct under non-zero, like the stroker's
own inner joins). Open ends get the CAP (butt, square = extended by the half-width, round = a
half disc). Every subpath is outlined; a closed one becomes a ring (its two edges). Contours
run clockwise on the page, holes the other way.

**C-21.** The face walk calls neither `exterior_paths` nor ray casting, so the comparator is no
longer on the arrangement's path at all; `union_faces` (kept for callers outside an
arrangement) and the Pathfinder booleans still end in it. The fork the workspace patches in
(`drietsch/flo_curves@6196f18`) already carries the `exterior_paths` fix (x quantised into
tolerance buckets: an equivalence relation, so the sort is a total order). The second
comparator of the same defect class, `ray_collisions`' in `bezier/path/ray.rs`, is NOT changed
here: fixing it means a new fork revision, and the arrangement no longer reaches it. The
1/64 pt grid snap stays as defence in depth.

## Evidence

- **Illustrator 30.1, new probes** (`modules/draw/scripts/illustrator/probes/`):
  `offset-compound.jsx` (14 cases: rings in all three joins both ways, a vanishing hole, an
  island, a merging pair, open L and S paths) and `divide-many.jsx` (Divide over 20, 50 and 100
  generated rectangles and circles: 30, 199 and 1057 pieces, of which 1 and 9 are
  Illustrator's own slivers under 0.01 pt², below the grid; every other piece is matched by
  owner and area, the circles' pieces within a few tenths of a pt² because Illustrator measures
  its own subdivision of the arcs). Replayed through the headless
  engine by `offset-compound.spec.ts` and `divide-many.spec.ts`, and by the kernel alone in
  `paged-mutate`'s `offset_compound_oracle` and `divide_many_oracle` (every piece, one for one:
  owner and area). The 54 recorded cases of the earlier probes pass unchanged.
- **Properties** (`paged-mutate/tests/it/geometry_fuzz.rs`, 250 + 150 + 120 seeded cases;
  `PAGED_GEOMETRY_FUZZ_CASES` for more): booleans conserve area on
  coincident, partly coincident, tangent, self-intersecting, sliver, hairline and identical
  pairs; the arrangement of such sets tiles the Pathfinder Unite of the same inputs (a
  different kernel) and every face's interior point lies in a face of its own signature; huge
  coordinates do not panic; compound offsets are monotone.
- **Work budget** (`paged-perf/tests/planar_budgets.rs`): Divide over the 100 shapes stays
  within its measured work (2391 collision pairs, 2508 edges, 1061 elementary faces), answers
  1049 faces with no signature correction, and reports progress per stage; a 1000-input lattice arranges; 600
  near-identical circles are refused in the collision stage before any clipping.
  `benches/planar.rs` trends the wall clock (native release: 0.52 ms, 2.6 ms and 13.1 ms for 20, 50 and 100 shapes).

## Consequences

- Shape Builder, Live Paint and the region verbs accept up to 1000 inputs. The draw module's
  mirrored constants (`MAX_PLANAR_INPUTS`, `MAX_PLANAR_FACES`) and its refusal texts follow.
- A Pencil stroke's variable-width outline now has the round ends and joins the Pencil asks
  for; a closed pencil loop becomes a ring instead of an open band.
- An open path's Offset Path with a round join now has round ends, as in Illustrator.
- Pathfinder Unite / Minus Front / Intersect / Exclude answer from the arrangement too, so a
  Unite of N inputs is one collision pass, not N − 1 sweeps, and is bounded by the same budget.
- The arrangement keeps its edge list (`PlanarArrangement` holds it behind an `Arc`), so a
  union of its faces needs no second kernel.
