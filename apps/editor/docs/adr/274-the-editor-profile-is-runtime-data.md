# ADR 274 — The editor profile is runtime data

- **Status:** Accepted 2026-10-22.
- **Scope:** `packages/shell/src/profile/` (the profile, its resolution, region edits, the shape
  check, the region filter), `packages/shell/src/state/chrome-regions.tsx`, the regions in
  `PagedShell.tsx`, `chrome/Header.tsx`, `chrome/MenuBar.tsx`, `chrome/ToolRail.tsx`,
  `chrome/PanelRail.tsx`, `chrome/RegionItems.tsx` and `cockpit/CockpitLayout.tsx`;
  `packages/shell/src/state/workflow-mode-context.tsx`; `apps/canvas/src/profiles/` and the
  profile wiring in `apps/canvas/src/main.tsx`; `scripts/profile-presets-guard.mjs`. Amends
  [ADR 213](213-solo-mode.md). Tasks A1–A6 of
  [the composable editor's plan](../composable-editor-plan.md).

## Context

Solo mode (ADR 213) showed that a different application on the same editor is configuration:
which bundle, which host panels, tools and menus, which mode, how big a new document is. It
was configuration the code could not hand around. A `SoloProfile` was TypeScript compiled into
the app and chosen by `?solo=`, `main.tsx` filtered by it in its own block, and the shell drew
every region of its chrome whatever the profile said: the header, the menu bar, the rails and
both cockpit columns were always there. The mode union was closed, so a solo app borrowed
`design`, and the guard that checked the profiles read their source with regular expressions.

An editor that a host embeds and shapes ([the concept](../composable-editor.md) §5) needs
the same idea as data: given at start, adjustable one entry at a time, and able to remove
parts of the chrome as well as filter registrations.

## Decision

An **editor profile** is data. A profile names a preset it `extends` and may set its title,
bundles, host panels, modes, regions, canvas furniture, start document size and storage scope,
and adjust regions by edits. `resolveProfile` expands the `extends` chain over a base that is
the editor as it was, layer by layer: a layer's field replaces its parent's, a region absent in
a layer inherits, `null` removes it, and the layer's edits (`remove`, `insert`, `set`, by exact
id, glob, `first`, `last` or index) apply after its regions. `validateProfile` reads a profile
from unknown data field by field, as stored settings are read (ADR 247). Neither throws: an
unknown preset, a cycle, a malformed field or an edit that cannot apply is a problem in the
result, and the editor still starts.

**Regions are optional.** `PagedShell` takes the profile's regions and canvas furniture and
publishes them through a `ChromeRegions` context. A removed region is not rendered and
reserves no space: the header, its menu bar and search, the context toolbar, the tool rail,
the left and right columns, the panel rail, the mode bar, the command palette, and the title
bar, rulers and thumbnail rail of the canvas column. Without a profile every region is there.
Tab and Shift+Tab still hide what a profile keeps.

**A region's list is an allow-list in order.** The menu bar keeps the top-level menus it
names, the tool rail the tools, the panel rail the launchers; a region that keeps everything
drops what it excludes. The entry `@bundles` keeps what the activated bundles contribute to
that region where it stands. A header list replaces the header's right-hand cluster, and the
new actions bar appears under the header when a profile gives it items; both render commands
as buttons that grey while they do not apply (ADR 249) and leave `host` slots for components
an embedding host supplies.

**The app applies the profile.** `main.tsx` resolves one profile at module scope from
`?profile=<preset>`, with `?solo=<name>` as the spelling of ADR 213, and `applyProfile`
decides which host panels, tools, rail launchers, modes and menus are registered and which
bundles are activated. The six solo profiles are the presets `solo:<name>`; `full` is the
editor. There is no solo-specific code outside the presets and the URL alias.

**Mode ids are open.** `WorkflowMode` is the six ids plus any string, so a preset declares its
own mode. The provider reads any stored id, and the shell falls back to the first registered
mode when the stored one is not this editor's. An editor with one mode shows no mode badge.

**The preset guard reads presets as data** and checks every id they name (bundles, panels,
mode slots and palette suggestions, rail tools and launchers, menus, header and actions-bar
commands) against the surface inventory of ADR 227, which reads plugin surfaces from each
bundle's manifest. It replaces the regular-expression guard.

## Evidence

- `packages/shell/test/profile/profile.test.ts`: resolution, edits, the shape check.
- `apps/canvas/test/unit/profiles/presets.test.ts`, `apply.test.ts`: every solo preset
  resolves to, and applies as, the surfaces its `SoloProfile` produced by hand.
- `apps/canvas/test/shell/regions.dom.test.tsx`, `modes.dom.test.tsx`: the shell mounted over
  the engine with regions removed, lists applied and open modes.
- `apps/canvas/test/unit/settings/url-flags.test.ts`: `url.solo` and the new `url.profile`.
- `scripts/profile-presets-guard.mjs`, run in the editor's `checks` job.

## Alternatives considered

A second entry point per shape, or a separate shell for the template shapes: rejected for the
reasons ADR 213 gave against a second document model. Hiding regions with CSS: rejected,
because a hidden region still registers, still takes keyboard focus and still reserves its
measured space. Deny-lists for presets: rejected for ADR 213's reason.

## Consequences

A host can describe an editor without code, and the template shapes of the concept (a canvas
with a form, a viewer) are profiles. Feature gates over the same ids come next (task B). The
`@bundles` entry is the one place where a list is not a pure allow-list; it exists so that a
solo preset need not know the menus and tools of its bundle.

## Related

- [ADR 213](213-solo-mode.md) — solo mode, now the presets `solo:<name>`
- [ADR 203](203-shell-is-a-registry-host.md) — the registries the region lists draw on
- [ADR 227](227-surface-conformance.md) — the surface inventory the guard checks against
- [ADR 247](247-stored-settings-are-shape-checked.md) — the shape check a profile follows
