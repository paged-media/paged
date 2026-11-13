# ADR 1207 — One Escape: an arbiter resolves each press once, in the specification's order

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/interaction/escape-arbiter.ts` (the arbiter, `useEscapeHandler`,
  `escapeArbiterOf`, `isEscapeKey`), its handlers in `state/edit-context-controller.tsx`,
  `state/pending-placement.ts`, `cockpit/canvas-frame/ThreadingController.tsx`,
  `cockpit/canvas-frame/GuideDragController.tsx`, `gestures/use-scrub-gesture.ts`,
  `chrome/CommandPalette.tsx`, `state/editor-root.tsx` (`useEditorEscapeGuard`) and the Radix
  wrappers in `components/ui/` (dialog, dropdown menu, popover); in the canvas app
  `ui/useTextEditing.ts`, `panels/canvas-panel.tsx` (path editing, the group climb, the
  selection) and the dialogs that answered Escape on their own window listeners; the
  single-owner rules `escape-listener` and `raw-window-key-listener`
  (`tooling/single-owner.json`, `allOf` in `tooling/js/single-owner.mjs`). Task KF1 and KF2 of
  [`interaction-plan.md`](../interaction-plan.md); the order is [ADR 1201](1201-interaction-decisions.md)'s
  §12.1 row. Amends [ADR 250](250-escape-climbs-out-of-a-group.md).

## Context

About ten listeners answered Escape, each on `window` or `document`, each deciding for itself
whether the press was its own: the edit-context controller (capture), the text editor
(capture), the threading cursor, the guide drag and the armed placement (capture, raw
`window`, any editor's key), the group climb, the viewport's gesture cancel, the gesture
spine, path editing, every canvas-app dialog (raw `window`), and Radix's own document listener
for the palette, the menus and the popovers. Their order was registration order. One press
could cancel a drag and climb a group, close a dialog and leave the text, and with two editors
on a page an Escape typed in one closed the other's dialog. The specification's §12.1 asks for
the opposite: the first applicable case wins, and no press does two things.

## Decision

1. **One listener per editor.** `escapeArbiterOf(scope)` is a per-editor store (ADR 277): one
   capture listener on `window` through `listenForEditorKeys`, so it hears only its own
   editor's keys. Whoever answers Escape registers a handler — `{ id, tier, isActive,
   resolve }` — with `useEscapeHandler` (a component) or `register` (anything else). At a press
   the arbiter walks the tiers in order and the first handler whose `isActive` holds resolves
   it; registration order breaks a tie only within a tier.
2. **The tiers** are §12.1's order, with the arbiter's own fallbacks:

   | Tier | Who | Resolves by |
   |---|---|---|
   | `ime` | an input method composing (`isComposingKey`) | nothing: the IME's key |
   | `menu` | an open popover of its own (the demo guide card) | its handler |
   | `modal` | the canvas app's dialogs, consent and secret prompts | its handler |
   | `palette` | the command palette | closing it |
   | `layer` | built in: a Radix menu, popover, select or dialog the DOM shows (tooltips excepted) | deferring to Radix |
   | `gesture` | a scrub on a field; the gestures track IC moves here | its handler |
   | `focused` | built in: the focused control owns the key (ADR 234's `canvasKeyYields`: a field, a composite, a frame surface) | deferring to the control |
   | `transient` | the loaded threading cursor, an armed placement, a guide drag, path editing | its handler (path editing defers to its own listener) |
   | `pointer` | built in: a pointer held down on the canvas | deferring to the canvas's gesture listener |
   | `context-dirty` | a context mid sub-edit | its `onContentKey`, or the tool in hand |
   | `context` | a clean edit context (not one with a header edited in place, ADR 301) | `cancel()`: one level |
   | `text` | a caret in a story | leaving the text for its frame (ED-1) |
   | `group` | an entered group (ADR 250) | climbing one level |
   | `selection` | a selection on the canvas | clearing it |

   Nothing active: a no-op, the key untouched (§12.1 case 9).
3. **Handled or deferred.** A handler that resolves the press makes the arbiter prevent its
   default and stop its propagation, so nothing later in the event's path acts on it too. A
   handler may instead return `"defer"`: the owner's own listener, later in the path, does the
   work (Radix's document listener for a layer, the canvas's listener for a gesture, path
   editing's), and the arbiter only guarantees that no other handler acts. `resolutionOf(event)`
   and `last()` say who resolved a press (tests, and the listeners that have not joined).
4. **Interim rules until the gestures join (track IC, IC4).** The viewport's drag cancel, the
   gesture spine and path editing keep their own listeners (the `escape-listener` baseline). A
   pointer held on the canvas is their gesture (`pointer` tier, after the transient modes, which
   own the press they drag). The `group` and `selection` tiers answer only while the tool in
   hand has no gesture handler: a drawing tool's handler hears every key (the Pen cancels the
   path it is drawing) and cannot yet say whether a gesture is under way, so its press stays
   its own. IC registers those gestures in the `gesture` tier and lifts both rules.
5. **The Escape order, refined.** A caret leaves the text before an entered group climbs
   (`text`, then `group`): the innermost thing the user is in goes first. ADR 1201's detail 6
   lists the entered group with the clean context; a group entered around a text frame with a
   live caret is the one case where the two readings differ, and this one keeps the caret's
   Escape the caret's.
6. **At the top level Escape clears the selection** (ADR 1201, amending ADR 250's decision 3):
   the canvas registers the `selection` tier. A selection change is not an undo step (D-15).
7. **Each editor's layers hear only its own Escape.** Radix listens on the page's document, so
   the shell's dialog, dropdown menu and popover contents take `useEditorEscapeGuard`: a press
   typed in another editor is refused (Radix dismisses only an unprevented event).
8. **Ratchets.** `escape-listener` (owner: the arbiter) fails on a new file that adds a key
   listener and spells out `"Escape"`; its baseline is the three files of track IC
   (`ViewportCanvas.tsx`, `useGestureSpine.ts`, `usePathEditMode.ts`). A rule line can only
   match one line, so the rule takes `allOf` (single-owner.mjs): a file is a copy only when it
   also matches every `allOf` pattern. `raw-window-key-listener` (owner: `editor-root.tsx`)
   fails on a `window`/`document` `addEventListener("keydown")`: listen through
   `listenForEditorKeys`. Its baseline is empty; the keybinding registry (it applies its
   editor's `owns` to every key) and `useModifierState` (it reads the modifier flags, acts on
   no key) are allowed with that reason.

## Consequences

- `UXI-T30` and `UXI-T31` hold (`tests/e2e/uxi-keyboard-focus.spec.ts`;
  `test/shell/escape-arbiter.dom.test.tsx`, `packages/shell/test/interaction/escape-arbiter.dom
  .test.ts`); `UXI-T32` and `UXI-T33` too (`text-input.dom.test.tsx`, `instance.dom.test.tsx`).
- Issue #32: Escape in the palette is the palette's handler, heard at the window wherever focus
  is, so it no longer depends on Radix's top layer (a tooltip or toast that opened after the
  palette took the press; `test/chrome/command-palette.dom.test.tsx` fails without the fix).
- A second Escape after leaving a context, the text or a group now clears the selection;
  InDesign users who pressed Escape at the top level for nothing will see it.
- New code answers Escape with a handler, never a listener; the ratchets say so in CI.

## Amendment 2026-11-13

[ADR 1211](1211-one-way-out-of-a-context.md): the `context` tier leaves through the one exit
resolver (`leave("escape")`): a clean context cancels, or commits when its module declares
`commit-if-safe`. The `context-dirty` tier is unchanged: a sub-edit resolves first.
