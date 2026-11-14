# ADR 1226 — An accessible object tree

- **Status:** Accepted 2026-11-14. Implements decision D-13 of
  [ADR 1201](1201-interaction-decisions.md) (plan tasks AP1, AP2 and AP4 of
  [`interaction-plan.md`](../interaction-plan.md)).
- **Scope:** `apps/canvas/src/ui/A11yObjectTree.tsx` (the tree), `panels/tree-panel.tsx` (the
  Tree panel, `paged.tree`, retitled "Object tree"), `a11y-commands.ts` (the reach command
  and the selection cycle), `reflect-commands.ts` (the rotate and scale steps),
  `insert-commands.ts` (`boundsInView`), `packages/shell/src/registries/keybinding.ts` (the
  brackets matched by their physical key), `modules/draw/packages/draw-bundle/src/handlers/brush.ts`
  (pen pressure only).
- **Requirements:** `UXI-A11Y-002`, `A11Y-003`, `A11Y-004`, `A11Y-006`, `A11Y-007`,
  `A11Y-008`, `A11Y-009`, `A11Y-010`, `A11Y-011`, `UXI-CAM-012`, `CAM-013` of the interaction
  specification (§13.3, §19.1–§19.3). Tests `UXI-T69` to `UXI-T73`.

## Context

The canvas is pixels. A screen reader found the chrome (landmarks, tabs and headings since
ADR 259) and nothing of the document, and the old Tree panel was a list of buttons that
rendered every row of the document at once, with no levels, no lock or visibility, and no
keyboard model. Objects stacked under others, or nested in groups, could be reached only by
a pointer. Inserts landed on the centre of the page in view even when the user was zoomed
into a corner of it, out of sight. There was no way to turn or size an object from the
keyboard but the inspector's fields.

## Decision

1. **The document as a WAI-ARIA tree.** `A11yObjectTree` shows the spreads (named after
   their page), and under each the page items front first: frames, groups with their
   members, a container's pasted-in content. Each row is a `treeitem` with `aria-level`,
   `aria-posinset`, `aria-setsize`, `aria-expanded` and `aria-selected`; the tree is
   `aria-multiselectable`. A row's name is its text — type, the name the user gave the
   object (else its id) — followed by words only a reader hears: the page, "locked",
   "hidden" (WCAG 2.5.3, label in name). Text is never mirrored: a text frame is one row;
   the caret's text input is the text surface (ADR 234).
2. **Virtualized.** Only the rows in view, and a margin, are in the DOM; focus stays on the
   tree and `aria-activedescendant` names the active row, which is always rendered. Lock,
   visibility, the item's name and its page are read for the rows in view only, once per
   document revision; a read in flight is not repeated, and an answer for an older revision
   is dropped.
3. **One selection.** Enter or Space selects the active row's item, Shift (or Cmd/Ctrl)
   with them toggles it, a click selects; each goes through the engine as a canvas click
   does (`setElementSelection`, then the shell's mirror with the engine's geometry), so the
   canvas, the inspector and the tree show the same accepted selection. A selection made
   anywhere else marks its row, opens the groups above it and scrolls it into view. Locked
   objects are selectable for inspection (D-08). No selection is an undo step (D-15).
4. **Keys** (the APG tree pattern): Up and Down move, Right opens a group or enters it,
   Left closes it or climbs to its parent, Home and End. Escape returns focus to the
   canvas through the Escape arbiter's `focused` tier (ADR 1207), so the press never
   reaches the selection tier that would clear the selection.
5. **Reach.** `paged.view.objectTree` (View ▸ Go to object tree, **Alt+Shift+O**) shows the
   Tree panel if it is not open and focuses the tree; pressed in the tree, it goes back.
   The panel's first line says so. The binding matches by the physical key (Option changes
   `key` on a Mac).
6. **Keyboard-only creation and transforms (AP2).** The insert commands
   (`paged.insert.textFrame`, `.rectangle`, `.ellipse`, `.line`, `.table`) land on the
   page's centre while it is on screen, else on the viewport's centre on that page, kept
   inside it (`boundsInView`): an insert always lands where the user is looking. Object ▸
   Transform gains Rotate 90° clockwise and counterclockwise, Rotate 15° either way, Scale
   up 10 % and Scale down 10 % (`paged.transform.rotate90Clockwise`, …, `.scaleDown`), about
   the selection's centre, one batch and one undo step each, remembered by Transform
   again. The arrow keys nudge (ADR 251's `paged.object.nudge*`, unchanged); X, Y, W, H and
   the angle stay the inspector's fields.
7. **Objects under objects (A11Y-008).** `paged.object.selectNextBelow` and
   `.selectNextAbove` (Object menu; ⌥⌘[ and ⌥⌘], Ctrl+Alt elsewhere, InDesign's keys) step
   the selection through the objects that overlap its box, top first, in the entered
   group's scope or among the top-level items, wrapping; with nothing selected, through the
   page in view. A step is a selection change only. The registry matches `[` and `]` with
   Alt by their physical key, as it already did for letters, digits, `=`, `-` and `'`.
   Track IC's object picker (IC6) reuses these commands.

8. **Touch and pen (AP4).** A pointer event carries the pen's pressure, tilt and pointer
   type to every tool's handler (B-08, unchanged); a tool declares pen support by reading
   them, and only for `pointerType === "pen"`: the Pencil tapers a pen stroke by its
   pressure and draws a mouse stroke plainly, and the brushes (paged.draw's Paintbrush, Blob
   Brush) now do the same — Pointer Events report a mouse's pressure as 0 on its release,
   which tapered the last anchor of every mouse stroke. Selection, navigation and the
   inspector treat a pen as a mouse. A second finger takes the touch over from whatever the
   first began — a press still waiting for its hit test included — rolls it back and pinches
   (ADR 294, the coordinator's preempting `pinch` session of ADR 1210): the camera changes,
   the document and the selection do not, no gesture is left open. In the fill shapes on a
   phone a finger fills and navigates (ADR 294); the authoring editor keeps selection
   explicit (no long-press).

## Consequences

- `UXI-T71`, `UXI-T72` and `UXI-T73` are claimed (`tests/e2e/uxi-touch-pen.spec.ts`, through
  the browser's own CDP touch and pen input: a pinch over a press held by fixture H's slow
  hit test; a probe tool that records what its handler receives, the Pencil by mouse and by
  pen, a pen click that selects; the fill shape on an emulated phone). The brush's pressure
  rule is held by `modules/draw/packages/draw-bundle/test/tool-gestures.spec.ts`.
- `UXI-T69` and `UXI-T70` are claimed (`tests/e2e/uxi-accessibility.spec.ts`), with the
  component layer in `test/panels/tree-panel.dom.test.tsx` (levels, names, virtualization,
  the keys, the selection both ways, no mutation) and the units in
  `test/unit/commands/a11y-commands.test.ts`, `reflect-commands.test.ts` and
  `insert-commands.test.ts`.
- The Tree panel's id stays `paged.tree`; its title is "Object tree". Its rows are no
  longer buttons.
- `@axe-core/playwright` (MPL-2.0, a development dependency of the canvas app) runs over the
  chrome, its menus and the palette in both themes; see
  [ADR 1227](1227-high-contrast-and-aa.md).
- A screen reader, an operating-system IME and a real pen remain manual checks before a
  release (gate G4, D-14).
