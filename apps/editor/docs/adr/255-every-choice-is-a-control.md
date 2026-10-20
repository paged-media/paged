# ADR 255 — Every choice is a control with its state

- **Status:** Accepted 2026-10-20.
- **Scope:** `platform/shared/panel-kit/src/controls.tsx` (`ChoiceGroup`, `ChoiceRow`),
  `packages/shell/src/registries/menu.ts` and `chrome/MenuBar.tsx` (`checked`),
  `packages/shell/src/catalog/leaves.tsx` (list-row rename), the Export Center, Outputs,
  Publication health and Library panels.

## Context

Root R22's one-off cases and their neighbours: rows a user picks one of were divs with a click
handler (Export Center PN-306, Outputs PN-307); a risk row with findings showed a "go there"
chevron but was no control (PN-301); a list row could be renamed only by a double-click
(PN-357); the View menu's toggles had no checked state (SH-4); Release asked for its name in a
`window.prompt` (PN-354). The panel kit's earlier pass (ADR 233) named fields and gave toggle
segments and tabs their state; these are the remaining shapes.

## Decision

1. **A row the user picks one of is a radio.** `ChoiceGroup` is a `radiogroup` named in words;
   `ChoiceRow` is a `radio` with `aria-checked`, a tab stop, Enter or Space to choose and the
   arrows to move. It is a div, not a button, because a row can hold its own controls (an
   Export… button); a key pressed on such a control stays that control's.
2. **A row that promises to go somewhere goes there.** A risk row with findings is a button
   that opens the panel listing them (Stories, Links, Fonts, Preflight).
3. **Rename has a key.** A list row that renames inline on a double-click starts the same
   rename on F2 (`aria-keyshortcuts`), as Windows and InDesign's panels do; Enter stays
   "select".
4. **A toggle in a menu is a menuitemcheckbox.** A menu item may declare `checked(state)`; it
   renders with a tick and `aria-checked`, as InDesign's View ▸ Extras items carry a check mark.
5. **A panel asks in the panel.** A name a panel needs (a release) is typed into an inline
   field beside the thing it names, with Release and Cancel; no `window.prompt`.

## Consequences

- PN-301, PN-306, PN-307, PN-354, PN-357 and SH-4 close.
- A clickable row added later should be one of these shapes; `bun lint` does not enforce it,
  the panel suites' keyboard tests do.
