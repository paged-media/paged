# ADR 1010 — A group can clip, and a group can be pasted into a frame

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`Group::clip`,
  `Group::clip_member`, `FrameRef: Hash`); `paged-mutate` (`GroupSpec::clip`,
  `PropertyPath::GroupClip`, `apply/nested.rs`, `apply/layer.rs`, `apply/remove_node.rs`);
  `paged-wire` (`Mutation::CreateGroup { clip }`); `paged-renderer`
  (`pipeline/build_engine.rs`); `paged-canvas` (`scene_tree`, the group's property read and
  extent); `idml-import` (`spread.rs`); `idml-export` (`clip_groups.rs`, `rewrite.rs`);
  `paged-introspect` (the `groupClip` row). Amends B-18 (paste-into) and
  [ADR 191](191-a-group-transforms-about-its-box.md)'s group frame for a pasted-in group.
  Gap D-13.

## Context

Illustrator's clipping mask is a group whose top-most object clips the rest; InDesign's is a
frame with content pasted into it (B-18). The engine had the second for single page items
only: `PasteInto` refused a group and a grouped item, the IDML reader flattened a
`<Rectangle><Group>…</Group></Rectangle>` to the top level, unclipped (counted in
`skipped_nested_frames`), and the editor's Make Clipping Mask therefore refused a group as
content and kept its own index of what it had pasted in, because `document.tree()` listed no
pasted-in content at all. paged.draw's clipped repeat could not group its instances for the
same reason.

## Decision

**A group can be pasted into a frame.** `PasteInto` takes a group as the child. A grouped
item stands for its OUTERMOST group, which is what moves, and the applied operation names
that group, so redo and the inverse act on it; `ReleaseFrom` resolves a member the same way.
Validation adds the cycle test through groups as well as containers (the container must not
sit anywhere inside the child) and refuses a clipping path (below) as the container. A group
keeps its stored transform: **a pasted-in group's frame is spread space**, as a top-level
group's is, so pasting and releasing stay pure bookkeeping, exactly as for a frame. Ungrouping
a pasted-in group is refused ("release it first"); deleting its container releases it and
deletes it leaf by leaf, so one undo puts all of it back; a pasted-in group whose last member
is deleted stays (empty) so that undo can put it back inside its container. Dissolving or
removing a group fixes the `FrameRef::Group` indices of the containers' children too.

**A native clip group.** `Group::clip: bool`. The TOP-most member (the last of `members`) is
the clipping path; the members under it paint inside its outline. Only a Rectangle, Oval or
Polygon clips (`Group::clip_member`); with any other member on top the flag is inert and the
group paints as a plain group. Following Illustrator, **the clipping path loses its paint**:
the renderer never paints it while it clips. Making one is `CreateGroup` with
`GroupSpec::clip` (the wire's `createGroup { memberIds, clip: true }`), refused unless the
top-most member is one of the three kinds and hosts no pasted-in content (that content would
surface inside the clip once the IDML writer lowers the group). `PropertyPath::GroupClip`
(`group.clip`, the catalog's `groupClip`, `Value::Bool`) turns the flag on or off on an
existing group, with the same refusal. `DissolveGroup`'s inverse carries the flag, so an undone
release brings the clip back. The `.paged` model part serialises the field (skipped when
false, so documents without clip groups are byte- and hash-identical to before).

**Rendering.** The group arm of the body pass pushes `PushClip` with the clipping path's
outline (the container-clip geometry paste-into uses: corner effects and fill rule included)
on every page one of the members reaches, emits the other members, and pops. A text frame's
glyphs, emitted later by the story pass, get the same clip through the generalised
`collect_nested_text_clips`, which walks every ancestor — containers and clip groups, through
any groups between — outermost first. A group pasted into a frame needs nothing new: the
container's bracket already wraps whatever `emit_one` emits. Both rasterizers and the PDF
writer see only `PushClip`/`PopClip`, which they already draw alike (ADR 146; the nested-clip
parity test below). On a master spread the clip bracket is not applied (masters walk leaves; a
residual shared with paste-into), but the clipping path is still not painted.

**The tree lists pasted-in content.** `SceneTreeNode::children` of a container row holds its
pasted-in children, as a group's row holds its members; a clip group's row carries
`clip: true` (absent elsewhere; additive). A clip group's extent (`frameBounds` on its
property read) is its clipping path's.

**IDML.** IDML has no clip group, so the writer LOWERS each to the paste-into that paints the
same, on a copy of the model, before any spread is written (`idml-export/src/clip_groups.rs`):
the clipping path takes the group's place in whichever list named the group, the group (the
path removed) becomes its one pasted-in child, the path's fill and stroke are written
`Swatch/None` and its shadow dropped, and the group's frame becomes spread space. The writers
then handle a container holding a group — which they had to learn anyway:

- *The patch lane* triages a source `<Group>` like a frame: kept in place when the model
  still nests it in the same container, dropped (and written inside its container at the
  container's close) when the model pasted it in, dropped (and written by the insert lane)
  when the model released it. A pasted-in group's `ItemTransform` is written relative to its
  container, as the source spelling when it still composes to the model's frame; its members
  accumulate from the container's MODEL transform (`stack_accum`), the composition the reader
  performs, so an untouched member replays to its bytes.
- *The insert lane* writes a pasted-in group relative to its container and its members
  relative to the group's spread-space frame.

**The reader lifts `<Rectangle><Group>`** (and `<Oval>`, `<Polygon>`): the container is
parked until the group closes, its transform composes into the members and into the group's
stored frame, and the group registers in the container's `nested_children`. Only a host that
cannot hold content (one without `Self`) keeps the old flatten, counted in
`skipped_nested_frames`. A clip group written to IDML therefore reopens as a frame holding a
pasted-in group: the picture comes back exactly, the clip-group structure does not (IDML
cannot say it). An unmutated document with such content still saves byte-identically.

**No protocol bump.** Every wire change is additive (governance rule 1): a `serde(default)`
field on `createGroup`, a new property path, an optional field on the tree row, and inputs
`pasteInto` / `releaseFrom` used to refuse.

## Evidence

- `crates/paged-renderer/tests/it/clip_groups.rs`: the paste-into fixture rebuilt as a clip
  group and as a pasted-in group clips like paste-into (edge, rounded corner, glyphs); the
  clipping path's fill and stroke are not drawn; an inert flag paints everything.
- `crates/paged-canvas/tests/it/clip_groups.rs`: make, read (`groupClip`, extent, the tree),
  draw, undo exactly (canonical hash), release and undo, the flag alone, refusals, a grouped
  item pasting its group, delete-with-container and undo, duplicate, the `.paged` round trip,
  and the IDML export: the lowered spread, the re-import as a frame holding a group, and the
  same pixels after both trips.
- `crates/paged-export-pdf/tests/it/clip_groups.rs`: more `W n` clips and fewer paints than
  the unclipped control.
- `crates/paged-gpu/src/vello_rs.rs`: `nested_clips_match_the_cpu_lane__…`.
- `crates/idml-import/src/spread.rs`: `pasted_group_lifts_into_its_container__…` and the
  id-less residual; `crates/idml-export/tests/it/nested_group_roundtrip.rs`: the unmutated
  byte-identity of a pasted-in group holds with the lift.
- `crates/paged-mutate/tests/it/kernel_ops.rs`: a grouped child pastes its group.

All tests named `*__feat__frames_paths_clip_groups` are the evidence of the feature row
`frames-paths.clip-groups`.

## Consequences

- The editor's clipping mask is the native clip group (one `createGroup`), works on any
  selection whose top-most object is a closed outline, and needs no index of its own: the
  tree lists what a frame holds.
- paged.draw can group a clipped repeat's instances.
- Residuals: a master spread's clip group paints its members unclipped; the canvas hit-tester
  still hits a member outside the clip; the plugin scene-layer IR has no clip group;
  `paged.group()` in scripts has no clip option yet.
