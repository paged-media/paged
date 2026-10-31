# ADR 312 — The Appearance panel lists every fill and stroke

- **Status:** Accepted 2026-10-31.
- **Scope:** `apps/canvas/src/panels/appearance-panel.tsx`, `apps/canvas/src/panels/appearance-layers.ts`
  (new), the panel's strings (`app.appearancePanel.*`) and their German. Reads and writes the
  engine's `frameAppearance` row (engine ADR 1043); no engine, wire or contract change. Amends
  [ADR 309](309-effects-transparency-and-appearance-panels.md)'s Appearance section. Plan WP6.3
  (the panel's part); gaps D-34, D-35 (their UI). paged.draw's own Appearance panel is retired in
  favour of this one (draw ADR 367).

## Context

ADR 309 made the Appearance panel a list of what draws an item — its stroke, its fill, the
object's effects and its opacity — and left room for the engine's multiple fills and strokes to
join it as rows of their own. The engine now has them natively (engine ADR 1043): text frames,
rectangles, ovals and polygons carry `frameAppearance`, a bottom-to-top list of fill and stroke
layers in which two placeholders, `frameFill` and `frameStroke`, stand for the item's own fill and
stroke; an empty list implies them in the order the item always drew. paged.draw kept a panel of
its own for its metadata appearance stack, which only draw's context could see and which drew
nothing the other modules, panels or exporters knew about. With the appearance in the engine, one
host panel can edit it in every edit context, and two panels for one thing would disagree.

## Decision

**The paint rows are the appearance.** The panel lists every layer of `frameAppearance`, front-most
first as Illustrator does (the reverse of the engine's bottom-to-top list), with the implied
placeholders made explicit exactly as the engine's `drawn_order` does. The placeholders are the
Stroke and Fill rows of ADR 309, unchanged in their controls — colour and weight on the frame's own
paths, the disclosure to their own target's effects — and in their hooks
(`data-appearance-section="stroke"` / `"fill"`), now wherever the appearance puts them. Every other
layer is a row of its own (`data-appearance-section="layer"`, with its kind and its index in the
list): its kind's name, its colour (a swatch or colour reference, the frame paths' vocabulary), its
opacity, its blend mode (the schema's members, as the Effects panel lists them) and, for a stroke,
its weight. Every row has a switch, move up and move down, duplicate and delete; a placeholder can
be switched off and moved — that is what the engine's order is for — but not deleted. The object's
effects and opacity follow, as before. An item the engine gives no appearance row (a line, a group)
shows its one stroke and one fill as ADR 309 did.

**Illustrator's actions.** The panel's foot offers Add new stroke, Add new fill and Clear
appearance. A new fill goes directly above the topmost fill-kind layer (an extra fill or the frame's
own), seeded with that layer's colour — the frame's fill colour for the placeholder — or black when
there is none; a new stroke likewise above the topmost stroke-kind layer, with the seed's weight or
1 pt. Duplicate puts a copy directly above its layer; a placeholder's copy is an extra layer of its
kind seeded from the frame's paint, since an item has one own fill and one own stroke. Clear
appearance writes the empty list: the item as it always was.

**One write per gesture.** Every gesture — add, duplicate, delete, move, switch, a layer's field —
is a pure function from the list read to the list written (`appearance-layers.ts`) and one write of
the whole list on `frameAppearance`, so one undo step; the engine normalises what it stores
(placeholders alone in the implied order come back empty). A selection whose items' appearances
differ shows the item's own rows and offers no layer gesture.

**The extension point stays.** The rows are still `APPEARANCE_SECTIONS`; the paint layers are one
section whose rows are the layers, before the effects and the opacity. Nothing in the panel is
draw's: paged.draw contributes no section and its own Appearance panel is retired.

## Consequences

- An item's several fills and strokes are made, ordered and edited from the host panel in every
  edit context — publish, doc, slide, sheet and draw — and each gesture is one undo step.
- The frame's own fill and stroke keep their single paths: the Swatches, Color and Stroke panels,
  object styles and IDML go on editing the placeholders' paint.
- Not in this decision: a layer's own effect stack (the engine has it; the row has no disclosure to
  it yet), a stroke layer's alignment, caps, joins and dash, gradient layers' angle and length, and
  a selected row that the foot's Duplicate and Delete act on (each row carries its own instead).
- Evidence: `test/unit/appearance-layers.test.ts` (the gestures and the implied order),
  `test/panels/appearance-panel.dom.test.tsx` (the rows, an add, a layer's fields, move, delete and
  Clear on the real engine) and `tests/fx-panels.spec.ts` FXP-LAYERS (Add new fill in the running
  editor and one undo), tagged with the feature row `frames-paths.native-appearance`.
