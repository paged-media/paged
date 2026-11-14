# ADR 1218 — Commands say why they do not apply

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/registries/command.ts` (`applicability`, on the contribution
  and the registry), `registries/command-reasons.ts` (new: `commandNeeds`, `whenNeeds`),
  `registries/types.ts` (`entryApplicability`), `chrome/applicability.ts` (`CommandState`,
  `CommandApplicability`), `chrome/MenuBar.tsx`, `chrome/CommandPalette.tsx` (the reasons, "Go
  to page …"), `apps/canvas/src/app-commands.ts` (`paged.view.goToPage`, the "Help: …"
  topics), the canvas command families that declare their needs (object verbs, arrange,
  insert, find, reflect, star, corner, appearance, pathfinder, barcode, stroke dashes),
  `scripts/applicability-guard.mjs`, and paged.draw's menu (one home per command). The
  interaction specification's `UXI-CMD-001`, `UXI-CMD-002`, `UXI-PNL-004` and decision D-16
  ([ADR 1201](1201-interaction-decisions.md)); the UX strategy's §5.7; task FI4 of
  [`interaction-plan.md`](../interaction-plan.md). Amends
  [ADR 249](249-offered-only-where-it-applies.md). Closes UX audit F-19.

## Context

ADR 249 made every entry onto a command ask the command's `when`, so the menus grey what the
registry would refuse. A `when` answers yes or no: the menus greyed a no with nothing to say,
the palette hid it (a user searching for "Group" with nothing selected was told "No
results"), and a key went quiet. The applicability vocabulary (`chrome/applicability.ts`)
named states for surfaces but not for commands. The palette could not navigate ("Go to page
14") or point to help, and paged.draw's menu repeated three host commands under other names
(F-19: Close path, Outline stroke, Type on path).

## Decision

1. **A command answers `applicability(state)`**: a state of the vocabulary (`here`,
   `elsewhere`, `absent`, and for commands `disabled`) and, when it is not `here`, a reason in
   words. The registry's `applicability(id)` is the one answer: unknown or not offered by this
   editor is `absent`; then the command's own applicability; then its `when`, which stays as
   the yes/no adapter (false without a reason reads "Does not apply here"). `invoke` runs only
   what reads `here`.
2. **Needs give the common reasons.** `commandNeeds(...)` builds an applicability from what a
   command needs, checked in a fixed order so the reason names the real obstacle: an open
   document ("Open a document first."), being outside an edit context (`elsewhere`: "Not
   while editing the web frame: press Esc to leave it."), no text caret, no point editing, a
   selection ("Select an object first."). The Object verbs, Arrange, Insert, Find, Reflect,
   Star, Corner, Appearance, Pathfinder, Barcode and Stroke dash commands declare theirs.
3. **Menus grey with the reason.** An entry that does not apply stays focusable and
   hoverable (`aria-disabled`, `data-disabled`, the reason as its tooltip and `data-why`);
   choosing it runs nothing and keeps the menu open. A seam stays the menu's `disabled`, with
   "soon".
4. **The palette lists a match it cannot run, with why** ("Not available here", greyed, the
   reason beside it), instead of hiding it. It navigates: "go to page 14", "page B-3" or "p4"
   (localized prefixes) offers "Go to page …" for a page by its name (folio) or its position,
   through the command `paged.view.goToPage` (`{ page }`), and says so when there is no such
   page. "Help: …" entries (scripting, templates, the built-in modules, keyboard shortcuts) are
   commands with keywords the palette also matches ("how do I script").
5. **One home per command** (F-19). paged.draw's menu no longer repeats Close path, Outline
   stroke and Type on path: they are the host's (Object ▸ Path, Object ▸ Type on a path); the
   draw commands stay for the palette and scripts. paged.image's Edit entries stay where they
   are: outside an image they raise the Image panel, which is an action, not a dead entry.
6. **The guard** (`scripts/applicability-guard.mjs`) counts the menu bar and the palette as
   participating surfaces, and fails when either renders commands without reading their
   reason.

## Consequences

- A plugin's command keeps `when`; its menu entries grey with "Does not apply here" until the
  contract carries a reason (a later contract change, not this record's).
- Tests: `packages/shell/test/registries/command-applicability.test.ts` (the registry's
  answer, the needs' order, `invoke` refusing), `packages/shell/test/chrome/command-why.dom.test.tsx`
  (the palette's reasons, "Go to page", the menu's tooltip), the canvas command families'
  reasons in `apps/canvas/test/unit/commands/command-reasons.test.ts`, and
  `tests/e2e/uxi-commands.spec.ts` in the running editor.
