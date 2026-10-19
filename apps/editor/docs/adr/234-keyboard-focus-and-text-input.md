# ADR 234 — Keyboard focus belongs to the focused control; text arrives as input

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/focus/` (key ownership, `FocusScope`, roving focus, the canvas
  viewport surface, `tabbableElements`), `registries/keybinding.ts` (`targetOwnsKey`),
  `PagedShell.tsx` (the chrome toggle's guard, Cmd/Ctrl+\\), `chrome/MenuBar.tsx`,
  `ToolRail.tsx`, `PanelRail.tsx`, `ModeSwitcher.tsx`, `components/ui/dialog.tsx`,
  `styles/globals.css`; `apps/canvas/src/ui/useTextEditing.ts`, `TextInputSurface.tsx`,
  `usePathEditMode.ts`, `useKeyboardShortcuts.ts`, `useGestureSpine.ts`, the canvas app's
  dialogs

## Context

The editor listens for keys on `window` in several places: the keybinding registry, the text
editor, path editing, the gesture spine, the spring-loaded tools, the edit-context
controller, the page-navigation keys. Each asked one question of the event's target ("an
INPUT, a TEXTAREA or contentEditable?") and never "is focus in a dialog or an open menu?"
(root R9). Tab was bound to "hide panels" (InDesign's convention) and fired from anywhere a
field was not focused, so keyboard focus could never move: not across the chrome, not
inside the Export PDF dialog (SH-2, UX audit F-49, a WCAG 2.1.1 and 2.4.3 failure). With a
caret in a story, an open menu's arrows moved the caret behind it (SH-11); Enter that chose a
menu item also put the selected frame into path editing (SH-12).

Text entry read only one-character keydowns without Alt (root R10). While text was edited no
editable element held focus, so an operating system's input method had no target: IME
composition (all CJK input), dead keys, Option and AltGr characters (–, “ ”, @ € { [ on
European layouts), the emoji picker and dictation were lost (SH-3, F-36), and a composition
key could fire a single-key shortcut.

## Decision

1. **One answer to "whose key is it".** `focus/key-ownership.ts` names the canvas's two
   keyboard surfaces (`data-canvas-surface`: the viewport, and the text editor's input) and
   decides for every window listener. `canvasKeyYields(event)` is true for a composition key
   (`isComposing`, keyCode 229, `Process`), a key something upstream already took, a key in a
   form field, every key inside a dialog or an open menu, the moving and activating keys
   inside a composite widget (menubar, toolbar, tablist, listbox, tree…), Enter or Space on a
   focused button, and Tab on any focused control. The registry's `targetOwnsKey` applies the
   same facts, and keeps Cmd/Ctrl chords firing from fields and dialogs as before.
2. **Tab moves focus; the chrome toggle lives on the canvas.** Tab hides the chrome only on a
   canvas viewport the user clicked into (`data-pointer-engaged`, kept until focus leaves the
   viewport), with no caret in a story. Reached by Tab, the viewport passes Tab on, so it is
   never a keyboard trap (WCAG 2.1.2). Cmd+\\ and Ctrl+\\ toggle the chrome from anywhere,
   the keyboard user's chord. This follows the audit's recommendation; InDesign itself keeps
   Tab for the panels only while no text field has focus. A pointer click on a rail tool, or a
   menu opened and closed with the pointer, hands focus back to where the user was (the
   canvas, the caret), so the next arrow nudges and the next Tab hides the chrome, as before.
3. **Focus management.** A visible focus ring (`:focus-visible`, the theme's ring colour, at
   `:where()` specificity so components with their own focus state keep it). Toolbars and the
   menu bar are WAI-ARIA roving-tabindex groups (`useRovingFocus`): one tab stop each, the
   arrows, Home and End within, the tab stop on the selected item while focus is outside. The
   menu bar is a `menubar`: Left/Right walk it, and with a menu open switch to the
   neighbouring menu; inside a menu Radix keeps the arrows, Home/End, typeahead and Escape. A
   tool's flyout opens from the keyboard (Shift+F10, the context-menu key) and walks like a
   menu. Dialogs trap focus and restore it: `FocusScope` (a React 19.3 Fragment ref,
   `focus()` / `focusLast()` behind two focus guards) in the canvas app's own dialogs, and the
   shell's Radix dialog wrapper gives focus back to the element that opened it, not only to a
   trigger.
4. **Text arrives as input, not as keys.** While a caret is in a story, focus sits on the text
   input surface: a textarea at the caret, invisible except while an input method composes,
   when it shows the marked text and — sitting at the caret — puts the IME's candidate window
   there. Its `beforeinput` (insertText, insertReplacementText) and `compositionend` carry
   every character the operating system produces into the story; the textarea stays empty.
   Keydown keeps navigation, deletion and the chords. Where focus types nothing (the page, a
   button just clicked), a printable keydown, Option and AltGr included, still types and
   hands focus back to the surface. Focus that drops to nothing while the caret is live
   returns to the surface.
5. **The text keys InDesign gives.** Enter is a paragraph break, Shift+Enter a forced line
   break (U+2028) and Tab a tab character. In a table cell Tab is left to move focus until
   cell navigation exists (InDesign moves to the next cell there).

## Consequences

- SH-2 / F-49, SH-3 / F-36, SH-11 and SH-12 are fixed; their tests assert the fix. The DOM
  lane holds the rules in CI (`apps/canvas/test/shell/keyboard-focus.dom.test.tsx`,
  `text-input.dom.test.tsx`, the registry's unit tests); `tests/e2e/keyboard-focus.spec.ts`
  proves them in Chromium, its input-method path driven through the DevTools protocol.
- A real operating-system IME, a dead-key layout, the macOS character viewer and dictation
  cannot be automated. The tests synthesise the events they deliver; a manual check on each
  platform remains worth doing before a release.
- A Tab press on the page no longer hides the chrome: users who never click into the canvas
  first now get focus traversal. The toolbar's title says how to hide it.
- Any new window-level key listener asks `canvasKeyYields` first.
