# ADR 1309 — An item explains itself from the model

- **Status:** Accepted 2026-11-14.
- **Scope:** protocol v82. `paged-canvas` (`explain.rs`: `CanvasModel::explain`,
  `CanvasModel::explain_selection`, `CanvasModel::style_dependents`, `Explanation` and its facts;
  `channel.rs`: `RequestExplain`, `Explained`), `paged-canvas-wasm` (the dispatch arm),
  `paged-scene` (`applied_paragraph_style` is public), the editor's client (`CanvasClient.explain`).
  Implements the X-Ray half of task PX1 of `apps/editor/docs/interaction-plan.md` (the UX
  strategy's Concept A; the interaction contract's §25.1, "engine-backed facts, not speculative
  explanations"); the editor's side is editor ADR 1233.

## Context

The questions a designer asks of an imported document — why this text is red, which style sets
this spacing, where this picture comes from, why this frame will not move, why this frame is
overset, which pages change if this style changes, which field supplies this value, what happens
if this picture is replaced — all have answers in the model, but no read gave them. The style
resolvers (`StyleSheet::resolve_paragraph`, `Document::resolved_run_attrs`) fold the cascade into
one value per property and keep no record of the level that supplied it; ADR 206's read reports
the effective value, not its source. Locks are three mechanisms (the item's `Locked`, a locked
layer or container, the template policy's role, engine ADRs 1000 and 1001), each read in its own
place. Nothing counted where a style is used.

## Decision

**`RequestExplain { item, aspect?, selection? }` answers `Explained(Explanation)`**, a read built
from the model alone. `item` is a page item or a story range (character offsets, as every
`storyRange` address counts); `selection` is text the editor has selected, in its caret units
(UTF-8 bytes and one separator per paragraph, as `SetContentSelection` takes it), converted with
the mutation layer's own rule. The answer:

- **Text.** For the character the facts are about (a caret's is the character before it, as the
  inspector reads it), the paragraph style chain and the character style chain (the applied style,
  then its `BasedOn`, nearest first, with `broken` when a `BasedOn` names nothing), and per
  property (`font`, `fontStyle`, `pointSize`, `leading`, `fillColor`, `fillTint`, `strokeColor`,
  `tracking`, `horizontalScale`, `baselineShift`, `capitalization`; `justification`, the indents,
  `spaceBefore`, `spaceAfter`, `hyphenation`, `hyphenationZone`, `composer`, the word and letter
  spacing, `gridAlignment`, `autoLeading`) the **winning level** and the **levels it shadows**,
  walked in the order the renderer resolves them: the text's own value, the character style and
  its chain, the paragraph style and its chain, then the engine's default (`source: default`, the
  value InDesign's `[No paragraph style]` gives). A local override is a `character` or
  `paragraph` source with something shadowed; `overrides` counts them; `mixed` says a range holds
  more than one run. The conditions on the text, with whether each shows.
- **Item.** Its kind, name, page (0-based) and layer (its own flags through its parent layers).
  **Lock reasons:** `item`, `container` (pasted into a locked frame), `layer` (with the locked
  layer), `role` (the session's role and the permissions the policy denies it on the item:
  `select`, `item.move`, `item.resize`, `item.delete`, `text.edit`, `image.replace`).
  **Visibility reasons:** `item`, `layer`, `layerNonprinting`, `nonprinting`. The applied object
  style's chain, and the fill, stroke and stroke weight with their sources (the item, a style of
  the chain — a style whose category is switched off stops the walk, as `resolve_object` closes
  it — or the default); opacity, blend mode, and the effects of each target's stack.
- **Picture.** The link as the document names it, its status (`ok`, `missing`, `undecoded`, engine
  ADRs 198 and 207), embedded or not, colour space, actual and effective ppi as the document
  records them, the frame's fitting (what replacing the picture does: the frame keeps its size and
  place and fits the new picture by it), whether the session may replace it, and the other frames
  that place the same file (relinking changes them too).
- **Bindings.** paged.data's bindings in the item's label (`x-paged:media.paged.data`, read as the
  JSON the data module writes: kind, expression, query and the query's source), the template
  fields the item is, the placeholders and text variables in the text. The record a binding shows
  is chosen when the data runs; the document does not store it, and the answer says so.
- **Flow.** The thread's frames, this frame's place, the previous and next frames, whether the
  story is overset, how many characters do not fit and the first of them.
- **Dependents.** For the applied paragraph, character and object styles: the styles based on each
  (directly or further down, which change with it), the paragraphs, runs or items using any of
  them, the stories, the frames they are set in and the pages that would change (0-based), and
  the uses whose text is overset.
- **`unknown`.** What the model cannot answer, with the reason (the record of a binding, a table
  cell's text, a table).
- **`revision`**, the document revision the answer holds for (engine ADR 1301).

`aspect: overview` answers the kind, the layer, the lock, the visibility, the object style chain
and a text frame's first paragraph style — what the editor's X-Ray mode colours a page by — and
skips the appearance, the link, the bindings, the flow and the dependents.

## Consequences

- The cascade walk reads the same fields the resolvers merge, in their order; a property the
  resolvers learn is a row here to add. The defaults are named once, in `explain.rs`.
- The style usage count walks every paragraph and run of the document and the built lines once
  per explained style; an X-Ray read is on demand, not per frame drawn.
- paged-canvas does not link the paged.data crates (engine ADR 1014): the binding facts are the
  label's JSON as written, a kind this reader does not know passed through by name.
- Tests: `crates/paged-canvas/tests/it/document_xray.rs` (the winning style and what it shadows, a
  local override, a character style, a chain two levels down, the dependents, every lock reason,
  a hidden layer, an object style's fill, a missing link shared by two frames, a thread's
  neighbours and its overset count, a data binding without a record, the caret's units, a read
  changes nothing); the wire in `crates/paged-canvas-wasm/tests/it/dispatch.rs`.
