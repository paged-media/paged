# ADR 1206 — Focus returns to the opener, else to the canvas

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/focus/focus-return.ts` (`focusReturnOf`, `useFocusReturn`,
  `canTakeFocus`, `canvasFocusTarget`) and its users: `components/ui/dialog.tsx` (every shell
  dialog, the command palette among them), `chrome/CanvasContextMenu.tsx`, `chrome/MenuBar.tsx`.
  Task KF5 of [`interaction-plan.md`](../interaction-plan.md); decision D-11 of
  [ADR 1201](1201-interaction-decisions.md); the specification's `UXI-KEY-009`, `UXI-KEY-010` and
  `UXI-A11Y-005`. Extends [ADR 234](234-keyboard-focus-and-text-input.md)'s decision 3.

## Context

Each surface that takes focus gave it back its own way. The shell's dialog wrapper remembered
`document.activeElement` and focused it again if it was still connected; a dialog opened with
nothing focused (a shortcut on the page) gave focus to `<body>`, where the next key belonged to
nobody. The menu bar did the same for a menu opened with the pointer. The canvas context menu
let Radix focus its hidden anchor, so after Shift+F10 and Escape focus was nowhere and the next
arrow did not nudge. A dialog closing as its editor unmounted could, a beat later, focus the
canvas of another editor on the page.

## Decision

1. **One service per editor.** `focusReturnOf(scope)`: `open(surface, opener?)` records where
   focus is as the surface opens (before focus moves in), `close(surface)` gives it back.
2. **Where it goes:** the opener, when it can still take focus (in the document, shown, not
   disabled, not `<body>`); else the canvas — the text input while a caret is live, else the
   viewport (`canvasFocusTarget`); else the editor's root. Whether focus really landed is
   checked after each move.
3. **Never as a click.** The hand-back focuses the viewport without marking it
   pointer-engaged (`UXI-KEY-010`): with the "Tab hides panels" preference on, Tab after a
   closed dialog moves focus, it does not hide the chrome.
4. **Only focus that dropped, only its own editor.** Focus is handed back only when it fell
   with the surface (to `<body>`, the root, or a node that left the document) and while the
   editor is still the page's active one: a click in another editor or in a panel's field that
   closed the surface keeps its focus. The fallbacks run only while the editor's root is
   connected: a surface that closes as its editor goes moves no focus, and never into another
   editor.
5. **Users.** The dialog wrapper (`onOpenAutoFocus` / `onCloseAutoFocus`, one surface per
   `useId`), so every shell dialog and the command palette; the canvas context menu (the opener
   is recorded by `openCanvasContextMenu`); the menu bar's pointer-opened menus. A
   keyboard-opened menu keeps Radix's return to its trigger.

## Consequences

- `UXI-T23` (the palette: back to the control it was opened from, else the canvas; the
  journey on real Chrome with a GPU is local evidence), `UXI-T30` (the context menu: back to
  the canvas, so the next Escape is the canvas's) and `UXI-T34` (a keyboard replacement keeps
  focus on the canvas) are tested in `tests/e2e/uxi-keyboard-focus.spec.ts` and
  `tests/journey/focused/command-palette.journey.spec.ts`.
- A new surface that takes focus calls `open` and `close` instead of remembering the opener
  itself.
