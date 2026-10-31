# ADR 307 — The slide profile

- **Status:** Accepted 2026-10-25.
- **Scope:** `apps/canvas/src/solo/profiles.ts` (`paged.slide`), the slide bundle's
  `commands.ts` (`SLIDE_NORMAL_VIEW_KEYS`, `DECK_CONTEXT`), `activate.ts` (the deck's document
  context) and `panels/slides-panel.tsx` (Delete on a thumbnail). Builds on ADR 213 (solo
  mode), ADR 274 (the profile is runtime data) and ADR 299 (scoped keybindings). Slide ADR 711
  (the PowerPoint parity program, wave 1).

## Context

paged.slide imports and exports PowerPoint decks, but in the editor a deck was a run of pages in
a page-layout program. A presentation program shows one slide at a time in Normal view: the
slides as thumbnails on the left, the slide in the middle, the notes and the formatting panes
around it, and keys that work on slides (Ctrl+M new slide, Ctrl+D duplicate, PageUp and
PageDown). The editor had solo profiles for six bundles; it had none for slides. The slide
bundle's existing keys (Option+Cmd+N, Cmd+Up, …) avoided every host chord, because a bundle key
could not outrank the host's. ADR 299 has since given a bundle keys scoped to an edit context
that outrank the host's while that context is active.

## Decision

- **`?solo=paged.slide`** (preset `solo:slide`) boots the slide bundle alone, in its own storage
  scope. A new document is one slide at PowerPoint's default 16:9 size, 960 × 540 pt; an opened
  deck brings its own size.
- **Normal view.** The left slot is the Slides panel (thumbnails, sections, drag to reorder).
  The right dock opens on the slide's panels: Slide, Transition, Placeholder, Deck, Comments
  and Notes. The rail adds Properties and Problems.
- **Notes are a dock tab, not a pane under the slide.** The cockpit has no bottom dock
  (`ModeCockpitSlots` names a left panel, right tabs and a canvas override), and the Notes
  panel's `defaultDock: "bottom"` is not honoured by the host. A bottom slot is a shell change
  of its own; until it exists, Notes sits beside Comments in the right dock.
- **Menus.** The host has no Insert or Format menu: inserts live under Object and text formatting
  under Type. The profile keeps File, Edit, View, Type, Object, Window and Help; the bundle's own
  Slide menu (New, Duplicate, Delete, Move up and down, Previous and Next slide, New comment)
  arrives with it. Layout, Data and the page-layout panels (Pages, Masters, Spreads, Stories,
  Preflight, Separations) are not offered. The host tools kept are Type and the shape
  primitives; the bundle contributes no tools.
- **The deck's document context.** The bundle registers an edit context, `slideDeck`, that no
  frame is entered by (its matcher answers no). While the open document is a deck, the bundle
  holds it as the document context (`host.shell.setDocumentContext`, extensions ADR 348), and
  drops it for any other document. The host drops it when the document is replaced; the slide
  store says again whether the new document is a deck. This is the doc bundle's Word document
  context, applied to decks.
- **Normal-view keys,** scoped to `slideDeck`, each with its Ctrl twin:
  - Cmd/Ctrl+M: New slide after the current one, on its layout, in text too.
  - Cmd/Ctrl+D: Duplicate slide, only while nothing is selected and no caret is active. With a
    selection the key stays the host's (Place).
  - PageUp and PageDown: the previous and next slide, while no caret is active.
  Outside a deck these keys are the host's, unchanged. A frame-level edit context above the
  deck (a sheet entered on a slide) takes the scope away, as ADR 299 defines.
- **Delete on a thumbnail.** Delete or Backspace on the focused thumbnail in the Slides panel
  deletes that slide (not the last one) and goes to its neighbour. The panel stops the key, so
  the canvas's Delete (the selected object) never sees it.
- **Typed twins.** The new palette commands (Previous slide, Next slide, New comment) have
  typed twins of the same id in the manifest's object model (ADR 323), as the doc bundle's Word
  commands do. The comment verbs (add, reply, resolve, delete) are typed commands; the panel is
  their user surface.

## Consequences

- A deck can be worked on in the editor with PowerPoint's own keys, and those keys cost the
  host nothing outside decks.
- A browser keeps Cmd+M on macOS (it minimises the window) and never hands it to the page.
  There, Ctrl+M is the key that arrives; the journey presses Ctrl.
- Slide Show (F5, Shift+F5) and the Slide Sorter view are later work of the parity program
  (slide wave 2), not part of this profile.
- The bottom Notes pane waits for a bottom dock slot in the cockpit.
