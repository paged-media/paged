# ADR 275 — Features gate what is offered, over surface ids

- **Status:** Accepted 2026-10-22.
- **Scope:** `packages/shell/src/state/features.ts`; the feature gate in
  `registries/command.ts` (`offered`, `invoke`), `registries/keybinding.ts`, `registries/types.ts`
  (`entryApplies`), `state/registries-context.tsx` (`ShellRegistries.features`); the surfaces that
  consult it: `chrome/MenuBar.tsx`, `chrome/CommandPalette.tsx`, `chrome/CanvasContextMenu.tsx`,
  `chrome/ToolRail.tsx`, `chrome/PanelRail.tsx`, `chrome/RegionItems.tsx`,
  `cockpit/PanelHost.tsx`, `cockpit/CockpitLayout.tsx`, `overlays/overlay-host.tsx`; the
  profile's `features` and `PagedShell`'s `features` prop. Follows
  [ADR 274](274-the-editor-profile-is-runtime-data.md). Tasks B1–B2 of
  [the composable editor's plan](../composable-editor-plan.md).

## Context

A profile decides what an editor registers (ADR 274). An embedding host also needs to switch
single things off and on while the editor runs: no Delete, no Layers panel, no rulers, a page
command only while the document has fewer than four pages. Doing that by re-registering would
churn every derived command and menu. The editor already enumerates every surface it offers
for conformance (ADR 227), with ids such as `command:paged.object.lock` and
`menu:Window/Layers`, and it already has one evaluator for "does this apply here" (`isEnabled`,
ADR 024) that every entry point reaches.

## Decision

A **feature store** lives in `ShellRegistries.features`. A feature id is a surface id,
`<kind>:<id>` with the kinds `command`, `panel`, `tool`, `menu` (by path), `keybinding`
(`<key>→<command>`), `overlay` and `chrome` (`rulers`, `title-bar`, `thumbnails`,
`context-menu`). A rule is a boolean or a predicate over the editor state and the answer of the
rules before it; rules apply oldest first, so the newest wins and a predicate may defer. A rule
may name a glob (`command:paged.object.*`). Everything is on until a rule says otherwise, and a
throwing predicate offers nothing.

**One gate per primitive, consulted by every surface.** The command registry's `invoke`
refuses a command the editor does not offer, silently, as it refuses one whose `when` is false;
`entryApplies` requires it; a keybinding onto it is no candidate for its key, so the key stays
the page's. A command switched off is not greyed but absent: the menu bar, the palette, the
canvas context menu and the region buttons leave it out. A menu entry is also gated by its
path, a tool by its id on the rail, a panel on the rail and wherever a slot or a tab hosts it,
an overlay by its id, and the canvas furniture by its chrome id. The overlay host now evaluates
an overlay's `when`, which was declared and never read.

A feature change notifies the command registry, so every view of commands re-reads, and the
surfaces read the store through `useRegistryView` (ADR 229). A profile's `features` are set
before the first paint.

**Features are not security.** A disabled command is still reachable from a script, a plugin or
the automation surface. What must not happen to a document is a permission, checked by the
engine ([the concept](../composable-editor.md) §7).

## Evidence

- `packages/shell/test/features/features.dom.test.ts`: the store's order, globs, predicates and
  throwing predicates; `invoke`, `entryApplies` and keybinding resolution consulting it.
- `apps/canvas/test/shell/features.dom.test.tsx`: the shell mounted over the engine; a command,
  a menu path, a tool, a panel and a chrome feature switched off and on, and a profile's
  switches from the first paint.
- `packages/shell/test/profile/profile.test.ts`: switches merge through the preset chain and
  are shape-checked.

## Consequences

A host can narrow a preset without rewriting it. The feature ids become a contract once hosts
use them; publishing them as a checked inventory is task B3 of the plan. The `chrome` and
`overlay` kinds are not yet surface kinds of ADR 227, so the conformance gate does not see
them.

## Related

- [ADR 274](274-the-editor-profile-is-runtime-data.md) — the profile that carries the switches
- [ADR 227](227-surface-conformance.md) — the surface ids features reuse
- [ADR 209](209-command-is-the-action-primitive.md) — the one door the command gate sits in
- [ADR 249](249-offered-only-where-it-applies.md) — applicability, which features extend
