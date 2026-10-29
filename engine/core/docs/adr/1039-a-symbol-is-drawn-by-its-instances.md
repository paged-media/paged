# ADR 1039 — A symbol is kept once and drawn by its instances

- **Status:** Accepted 2026-10-28.
- **Scope:** protocol v78 (five new Mutation kinds). `paged-model` (`FrameRef::Instance`,
  `Spread::instances`, `SymbolInstance`, `SymbolDefinition`, `NineSlice`, `SymbolTint`,
  `SymbolOverrides`); `paged-scene` (`Document::symbols`, the instances' cached bounds in
  `rebuild_indexes`); `paged-mutate` (`apply/symbol.rs`, the instance arms of remove,
  re-insert, set-property, duplicate, snippet, lock, permit, `NodeId::Instance`, the
  `SymbolInstanceTint` / `SymbolInstanceNineSlice` paths); `paged-compose`
  (`DisplayCommand::BeginSymbol` / `EndSymbol`, `DisplayList::symbol_forms`); `paged-renderer`
  (`pipeline/symbols.rs`, `SymbolCache`); `paged-gpu` (both lanes ignore the markers);
  `paged-export-pdf` (one form XObject per definition); `paged-svg`; `paged-wire`
  (`Mutation::{CreateSymbol, RedefineSymbol, PlaceSymbolInstance, BreakSymbolLink,
  DeleteSymbol}`, `ElementId::Instance`, `instance:<id>`); `paged-canvas` (lowering, hit test,
  geometry, scene tree, the `symbols` collection, IDML export and reopen, the losses);
  `paged-script` (`paged.symbols`, `paged.createSymbol`, …); `paged-introspect`. Gap D-48.

## Context

paged.draw's symbols (draw ADR 356) were a plugin construct: the library a container
part, an instance real page artwork re-emitted through `insertPath` and stamped with a link
on every leaf. That costs what its header lists — text, live corners, placed images and
gradients cannot go into a symbol (no op copies them into re-emitted geometry), a redefine
rebuilds every instance and mints new ids, the library is not on the undo stack, and there
is no 9-slice, no per-instance override and no PDF reuse. Illustrator's symbol is a
reference the renderer draws. The engine now has the copy machinery that makes the
reference cheap: the page-item snippet (ADR 193, ADR 1036) clones items whole, text and
images included.

## Decision

**A definition is page items in definition space.** `Document::symbols` holds
`SymbolDefinition { id, name, revision, items: Spread, stories, bounds, nine_slice }`:
the snippet copy of the source items (roots in `items.frames_in_order`, members and
pasted-in children in the kind vecs) moved so the centre of their box — the registration
point — is the origin. Its stories ride inside it; its swatches, styles and fonts are the
document's. Absent from the native encoding when empty, so a document without symbols
serialises (and hashes) as before.

**An instance is a page item.** `FrameRef::Instance(i)` indexes `Spread::instances`:
`SymbolInstance { self_id, symbol, item_transform, item_layer, visible, locked, overrides,
nine_slice }`. `item_transform` maps definition space to spread space (spread-absolute,
like every leaf's). The overrides are opacity and blend mode (the instance composites as
one object, a `BeginBlendGroup`) and a colour tint (every solid paint and gradient stop
moves `amount` towards the colour; images are not tinted). The definition's bounds are
cached on each instance (`#[serde(skip)]`, refreshed by `Document::rebuild_indexes` after
every load and mutation), so everything that sees only a spread — the hit test, snapping,
z-order, a group's box, selectors — measures an instance without the symbol store.

**Rendering replays the definition.** Before the frame pass, each definition an instance
names is built once into its own display list — a one-page document of its items and
stories with the host's palette, styles, layers and font table — and cached per
`(id, revision, environment)` in the caller's `SymbolCache` (the canvas keeps one; the
environment hashes the palette, styles, layers, render scale and colour context, so a
swatch edit rebuilds it). An instance splices that list into its page under
`page ∘ instance ∘ translate(bounds origin)`: paths, gradients, images and inks appended
to the page's pools, ids moved, transforms composed, group bounds mapped, glyph runs
carried. The copy is bracketed by `BeginSymbol { form, transform }` / `EndSymbol`; the
list keeps the definition once in `symbol_forms`. Both rasterizers draw the copy and
nothing for the markers, so GPU/CPU parity (ADR 146) is the parity of the commands
already there; the digest (ADR 101) changes only for a document with instances, through
the markers (deliberately: a replay is not the same list as loose items).

**9-slice.** With guides set (`[left, top, right, bottom]` insets in definition space, the
instance's own or the definition's) and an instance that is scaled, the definition is
replayed nine times, each copy clipped to one region: the corners keep their size, the
edges stretch along their axis, the centre in both. The scale is the instance matrix's
column lengths; what remains (rotation, translation) places the sliced result. An instance
at its own size is not sliced.

**PDF writes a definition once.** The exporter writes `BeginSymbol`'s form the first time
any page draws it — the definition's list walked into a form XObject with a resources
dictionary of its own, keyed by `SymbolForm::key` across the whole document — and every
instance is `q cm /Sy… Do Q`. Fonts are the document's pool, so a definition's text embeds
as text. The bracketed copy is skipped.

**Operations.** Each is one undo step, and its inverse is one `RestoreSymbolState` that puts
back the spreads it touched, the symbol store, and the stories it added or took (by id):
- `CreateSymbol { symbol_id, name, sources, replace, instance_id, nine_slice }` — refuses
  what a copy refuses, and an instance among the sources (symbols do not nest yet). With
  `replace` the sources leave (as Cut removes them, their stories with them) and an
  instance drawn where they were takes the top-most source's slot.
- `RedefineSymbol { symbol_id, sources, name, nine_slice, replace, instance_id }` — new
  artwork moves the revision; every instance draws it at once, its transform unchanged.
- `PlaceSymbolInstance { symbol_id, spread, transform, instance_id, nine_slice }` — on top.
- `BreakSymbolLink { instance, ids, story_ids }` — the definition's items pasted (fresh ids,
  stories copied) under the instance's transform, in the instance's slot: one root, or a
  group carrying the opacity and blend overrides when there are several roots or overrides.
  9-slice and tint are not baked (see Consequences).
- `DeleteSymbol { symbol_id }` — every instance is broken first, so nothing disappears.

An instance's transform, opacity, blend mode, visibility, lock and layer are the ordinary
element paths on `NodeId::Instance`; its tint and guides are `symbolInstanceTint` and
`symbolInstanceNineSlice`. Delete, move, duplicate, copy and paste work on instances; a
copy carries its definition in the snippet's resources, so a paste into another document
adds it.

**IDML has no symbol.** The export breaks every instance on its copy of the document
(`paged_mutate::expand_symbols_for_interchange`), labels each leaf of the artwork with the
instance it was (`paged:symbolInstance`) and puts the store in the document label
`paged:symbols`; the loss report says so for every instance (and names a tint or 9-slice
it does not draw). Reopening such a file in paged (`CanvasModel::load`) restores the store
and replaces every labelled set of leaves with its instance, in its slot
(`restore_symbols_from_labels`). InDesign shows the artwork and keeps the labels verbatim.

## Consequences

- Protocol 78: five new Mutation kinds an older worker cannot apply. Additive with them:
  `ElementId::Instance`, `CollectionName::Symbols` / `SymbolSummary`, the two element paths.
- paged.draw's Symbols panel and commands run on the engine when the host says
  `supports("document.symbols@1")` and keep the re-emitted lane as the fallback.
- Follow-ups, not built: nested symbols (an instance inside a definition); breaking a link
  bakes neither 9-slice nor tint (the artwork comes back plainly scaled and untinted); the
  per-instance overrides stop at opacity, blend and tint (no per-item colour or text
  overrides); instances on master spreads are not drawn; the `.paged` container's IDML twin
  parts do not carry instances (its native model part does); the SVG export draws instances
  inline, not as `<symbol>` / `<use>`; a definition's hyperlinks are not copied.
