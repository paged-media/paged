# ADR 250 — Escape climbs out of a group one level at a time

- **Status:** Accepted 2026-10-19.
- **Scope:** `apps/canvas/src/panels/canvas-panel.tsx` (the Escape listener, `groupChainRef`),
  `apps/canvas/src/ui/ViewportCanvas.tsx` (`onDoubleClickGroup` passes the hit's group chain).

## Context

ADR 235 made a double-click on a grouped shape select that shape and enter the group, and
Direct Selection select the leaf (UX audit F-29). Escape then only left the group: the
child stayed selected, and a second Escape did nothing, so there was no keyboard way back to
the group (the audit's last open point under F-29). In InDesign, Escape with an item inside
a group selected selects the group that holds it, one level per press.

## Decision

1. **One level per press.** With a group entered, Escape selects the innermost group holding
   the selected member; with a nested group selected, the group holding it. Selecting the
   outermost group leaves the group (no active group), so the next click selects whole
   groups again.
2. **The chain comes from the hit.** The click or double-click that selected the item inside
   the group remembers its group chain (outermost first); Escape climbs that chain. A
   selection the chain does not describe leaves the group, as Escape did before.
3. **At the top level Escape changes nothing**, as in InDesign.
4. **Ownership.** The listener yields wherever the key-ownership rule says (ADR 234), and in
   path-edit mode, which owns its own Escape.

## Consequences

- F-29 closes (`selection-tools.dom.test.tsx`, "Escape after entering a group selects the
  group, one level up").
- Object ▸ Select parent group stays the menu way to climb without a group entered.
