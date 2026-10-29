# ADR 719 — Document styles: placeholders, table styles and shape styles as the document's styles

- **Status:** Accepted 2026-10-29. Part of the parity program ([ADR 711](711-powerpoint-parity-program.md)),
  wave W3, with [ADR 713](713-live-theme.md).
- **Scope:** `slide-resolve` (`paragraph_styles`, `shape_style_look`), `slide-native`,
  `packages/slide-bundle` (`design.ts`, `panels/design-panel.tsx`).

## Context

PowerPoint formats text through its masters' text styles (title, body and other, nine list
levels each), tables through table styles, and shapes through shape styles (`p:style`:
references into the theme's fill, line, effect and font schemes). Import resolved all of it
into local values. The document had paragraph styles by name only (`Title`, `Body L1` …, with
no properties), the table styles of [ADR 700](700-pptx-opens-as-a-generated-idml-package.md)'s
native tables, and no object styles: the styles panels showed nothing a user could apply or edit
as PowerPoint's styles.

Masters with layouts as `basedOn` children (layout and placeholder `lstStyle`) need two-level
masters in the engine (engine ADR 1026), which another wave builds.

## Decision

- **Placeholders ↔ paragraph styles.** Import writes the paragraph styles `Title`, `Body`,
  `Body L1`–`L9` and `Other L1`–`L9`, from the master whose theme is the deck's first:
  - `Title` and `Body` are roots with the theme's major and minor font ([ADR 713](713-live-theme.md));
  - the list levels are based on `Body`;
  - `Title` and every level carry their master text style's look: size, colour (a theme swatch when
    the colour is a theme colour), alignment, indents, space before and after.
  
  A placeholder's paragraphs take their level's style, as before.
- **Table styles ↔ table and cell styles.** The native table styles and region cell styles stay
  as [ADR 700](700-pptx-opens-as-a-generated-idml-package.md) wrote them; their fills now name
  theme swatches, so a table style recolours with the theme.
- **Shape styles ↔ object styles.** A shape with a `p:style` (not a placeholder) takes an object
  style named after its fill colour and references (`Shape Style: Accent 1 (fill 1, line 2,
  effect 0)`), one per distinct set of references, whose fill and line are what the references
  give a shape with none of its own: theme swatches (or the theme's gradient). The shape keeps its
  own fill and line, which win, as `spPr` wins over `p:style` in PowerPoint.
- **Missing references.** The theme binds document resources: the twelve slot swatches, the root
  paragraph styles and the theme-font character styles. One the document no longer has (the user
  deleted it) is counted in the Design panel as "N references missing · Remap", the sheet module's
  pattern (sheet ADR 524). Remap picks a resource the document has; the choice is kept in the deck
  label's `theme.remap` (one undo step), a remapped slot's stand-in takes the slot's colour when a
  theme is applied, and export reads the slot's colour from it.

## Consequences

- The styles panels list PowerPoint's styles with real properties; applying `Body L2` to other
  text gives it the level's look, and a shape style can be applied to a shape made in the editor.
- Paragraphs and shapes keep their own values, so what the document draws is what it drew before.
  A change to a style's size or colour therefore reaches new text and text without that local
  value, not every existing paragraph; the theme (colours, fonts) reaches everything because it
  goes through swatches and the root styles.
- Approximations: one set of placeholder styles for the deck (the first master's); layout and
  placeholder `lstStyle` overrides stay local values until masters and layouts are two-level
  (engine ADR 1026). Object styles carry fill and line, not effects or the font reference; export
  writes a shape's own fill and line, not its `p:style`.
