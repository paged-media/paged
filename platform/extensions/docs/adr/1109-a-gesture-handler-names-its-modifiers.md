# ADR 1109 — A gesture handler names its modifiers

- **Status:** Accepted 2026-11-14.
- **Scope:** `ModifierHint` and the optional `GestureHandler.modifierHints` in
  `packages/plugin-api/src/editor.ts`. The editor half is the modifier hint strip (plan task IC10
  of the editor's interaction plan; `packages/shell/src/overlays/modifier-hints.tsx`). plugin-sdk
  and plugin-api `0.74.3-canary.104`.

## Context

The editor's interaction contract asks the canvas to say what the modifiers do with the tool in
hand (the interaction specification's §7.5 and §11.4), and four habits changed with ADR 1201 of
the editor (Shift toggles, the directional marquee, one snapping bypass, the Hand held back during
a drag), so the hints are how a user finds the new behaviour. The host knows its built-in tools'
modifiers; a bundle's tool had no way to say what Shift or Alt does with it, so the strip would
have been silent for every tool a bundle contributes.

## Decision

1. **`ModifierHint`**: `{ keys: ReadonlyArray<"shift" | "alt" | "primary" | "ctrl" | "space">;
   label: string }`. `primary` is the platform's primary modifier (Cmd on macOS, Ctrl
   elsewhere), the one the host also uses for the snapping bypass; `ctrl` is the Control key
   itself. The label is the bundle's, in the user's language (`host.strings`).
2. **`GestureHandler.modifierHints?: readonly ModifierHint[]`**, optional and static: what the
   handler does with each key while its tool is in hand. The host shows them in its hint strip
   for the tool's first uses, lights the hint whose keys are held, and keeps them visible when the
   user asks for it. A handler without the member shows the host's hints for a built-in tool and
   nothing for a bundle's.

The member is data on the handler rather than a contribution field because the handler is what
interprets the keys; a tool whose handler changes keeps its hints in one place.

## Consequences

- Additive: a bundle that does not name hints is unchanged; a host that does not read them
  ignores them.
- The contract's version moves (plugin-sdk and plugin-api `0.74.3-canary.104`).
