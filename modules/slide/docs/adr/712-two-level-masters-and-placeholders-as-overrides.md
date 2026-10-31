# ADR 712 — Two-level masters, every layout, placeholders as overrides

- **Status:** Accepted 2026-10-29. Amends [ADR 700](700-pptx-opens-as-a-generated-idml-package.md)
  (one master page per used layout) and [ADR 704](704-pptx-export-regenerates-slides.md)
  (masters and layouts copied), part of the program of [ADR 711](711-powerpoint-parity-program.md).
- **Scope:** `pptx-core` (`preserve`), `slide-resolve` (masters and layouts), `slide-native`
  (master spreads, override lists, labels), `pptx-export` (`masters.rs`),
  `packages/slide-bundle` (`masters-model.ts`, `masters-commands.ts`, `views/slide-master.tsx`,
  the Slides panel, `newSlide`). Engine ADR 1026.

## Context

A deck has slide masters, and layouts based on them; a slide is made from a layout, and its
placeholders inherit their place and formatting from the layout's, which inherit from the
master's. The engine had one master level, so import flattened: one master spread per layout
a slide used, holding the slide master's art and the layout's. Editing the slide master meant
editing every copy; a layout no slide used was not imported, so New Slide offered only the
layouts in use, and made a slide by copying one that used the layout. Export copied the
masters and layouts as they were.

Engine ADR 1026 gives the engine masters based on masters, override lists and Override as
operations, and draws a master page as a page of its own.

## Decision

- **One master spread per slide master and one per layout, every layout.** The master spread
  `M<n>` holds the slide master's background and shapes, its placeholders included. The layout
  spread `m<n>` is based on it (its page applies `M<n>`) and holds the layout's background,
  shapes and placeholders. Ids follow the deck's order: masters, and each master's layouts in
  `p:sldLayoutIdLst` order.
- **A layout hides what PowerPoint hides.** Its override list names the master's
  placeholders (the layout has its own), and the master's art when the layout hides master
  shapes. A layout with a background of its own hides the master's background too; since the
  engine paints a master's items under the layout's, a layout that shows master shapes over
  its own background draws a copy of that art over it (an edit of the master's art does not
  reach such a layout).
- **Placeholders are layout items; a slide's placeholder is an override.** A master's and a
  layout's placeholders are drawn items with their prompt text, labelled as placeholders
  (`{type, idx}`) with their shape key (`<layout part>#<id>`, as a slide's shapes are keyed). A
  slide's override list names every placeholder of its layout: the slide's own placeholders
  (labelled the same) stand in for some, and the rest are not shown on a slide, as in
  PowerPoint. What a slide draws is what it drew before.
- **Labels.** A master page carries `{master: {kind, part, type, preserve}}`
  (`x-paged:media.paged.slide`): whether it is a slide master or a layout, its part, a layout's
  type and the Preserve flag. The master spread's name is the layout's name.
- **New Slide from any layout of any master** is one batch: `insertPage` on the layout,
  `overrideMasterItems` of its placeholders with their text emptied (the footers left out, as
  PowerPoint leaves them), the override list of all its placeholders, and the slide's label.
  It replaces the copy of a slide that used the layout.
- **Change Layout** applies the new layout, moves each placeholder of the slide that fills one
  of the new layout's (by index, else by type) to where that one sits, adds the new layout's
  other placeholders empty, and sets the override list. **Reset Slide** moves each placeholder
  back to its layout's place. Each is one undo step; the text stays.
- **The Slide Master view** (View ▸ Slide Master, a module view in place of the canvas) lists
  each master with its layouts under it, as thumbnails the engine draws; the one selected is
  shown large with its placeholders. Its bar inserts a placeholder (content, title, picture,
  chart, table, media, date, footer, slide number: a text frame with PowerPoint's prompt where
  PowerPoint puts one), deletes one, renames the layout, sets Preserve, and deletes a layout no
  slide uses (a master only once it has no layouts). A placeholder's text style (size, font
  style) is set on the layout and on every slide placeholder made from it that still has the
  layout's value: the slides follow the layout where they did not set their own, as in
  PowerPoint.
- **Typed twins.** `command.slideMaster` and `command.resetSlide` (palette commands), and
  `layouts`, `renameLayout`, `setPreserve`, `deleteLayout`, `insertPlaceholder`,
  `setPlaceholderStyle` and `changeLayout`, for scripts and the CLI.
- **Export writes masters and layouts** (`pptx-export/src/masters.rs`). A layout or master the
  document did not change keeps its bytes. A renamed one gets its `p:cSld name`; a changed
  Preserve flag its root's `preserve`. A layout's placeholders and shapes are written by the
  slide writer (ADR 711), as differences from what import made of them; a placeholder's text
  style becomes its `a:lstStyle` level 1 (`a:defRPr` `sz`, `b`, `i`), so the slides that
  inherit it follow in PowerPoint too. A layout deleted in the document is removed with its
  relationships, its `p:sldLayoutId` and its content type. A slide whose layout changed points
  its layout relationship at the new one. A slide's placeholders are written as differences
  from their layout's (ADR 711).

## Consequences

- Editing the slide master reaches every layout and slide that shows it, in the editor and in
  the exported deck.
- Unused layouts are in the document: New Slide and Change Layout offer every layout.
- A layout that paints its own background and shows master shapes holds a copy of the
  master's art (the engine's painting order). Editing the master's art does not reach it.
- Insert Layout, Duplicate Layout and a new slide master are not built; nor are placeholder
  edits on the canvas (the Slide Master view is a panel over thumbnails: insert, delete, text
  style; geometry edits of layout placeholders are written by export when made through
  `onMaster`).
- A placeholder's text style is followed by the slides at the moment it is set. A later change
  on the slide is the slide's own; the engine keeps no link from a slide's copy to its layout's
  item (engine ADR 1026).
