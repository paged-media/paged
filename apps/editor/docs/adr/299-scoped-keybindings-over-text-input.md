# ADR 299 — Keybindings scoped to an edit context win over the text input

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/shell/src/registries/keybinding.ts` (`scope`, `SCOPED_BINDING_RANK`,
  `claims`, reserved combos, `space`), `apps/canvas/src/ui/useTextEditing.ts`,
  `packages/shell/src/tools/use-spring-loaded-tools.ts`. Contract: extensions ADR 348 (C2).
  Builds on ADR 234 (keyboard focus and text input).

## Context

With a caret in a story, focus sits on the text input surface and `useTextEditing` handles
Tab, the arrows, Enter and the chords in the capture phase; the keybinding registry skips keys
an editable target owns (letters, widget keys, Tab). Host bindings rank by guard and
`precedence`. A bundle's binding could therefore never take Tab from the text, and lost Cmd+E or
Cmd+= to host bindings on the same key: Word's keys were unreachable inside a Word document.

## Decision

- **Scope.** A binding with `scope: { editContext }` is a candidate only while that context is
  the active one (`activeScopeContext`: the frame context, else the document context, ADR 298),
  and then ranks `SCOPED_BINDING_RANK` (100), above every host rank.
- **Text input yields.** `claims(event)` answers whether a scoped binding wins the key; the
  registry fires it even when the target is the canvas text input, the canvas or the page, and
  `useTextEditing` and the spring-loaded tools return early for a claimed key. A panel's field
  or an input-method composition keeps its keys.
- **Reserved.** Cmd+S, Cmd+P, Cmd+\ and Cmd+Shift+P refuse a scoped binding at registration.
- **`space`.** A combo names the space bar `space` (Cmd+Space), since a combo string is trimmed.

## Consequences

- Inside a Word document Tab demotes a list paragraph and Cmd+B is bold; outside it the same keys
  are the host's and the text's again.
- Keys the browser keeps for itself (Cmd+1–9, Cmd+T, Cmd+W, Cmd+N, Cmd+Q, Cmd+M, Cmd+H) still
  never reach the page; a bundle offers those actions in its control-bar group.
