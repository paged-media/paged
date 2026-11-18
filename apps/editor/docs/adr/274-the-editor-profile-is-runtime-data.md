# ADR 274 — The editor profile is runtime data

- **Status:** Accepted 2026-10-22. Amended 2026-11-18 (the rail decides the start tool, the
  modifier hints and the fill and stroke wells).
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

## Amendment — 2026-11-18: the rail decides the start tool, the hints and the wells

The viewer preset ([ADR 276](276-filling-a-template.md): "a hand and zoom rail, nothing else")
showed more than its rail. The tool provider started every editor on Selection, and the rail never
hides the tool in hand, so a viewer showed Selection, active, above Hand and Zoom. The modifier
hints followed the tool in hand, so its first-use strip (Shift, Alt, Cmd, Space) covered the
bottom of the stage. The rail's foot drew the fill and stroke wells in every editor that had a
rail. The docs' scripting lab mounts the viewer with `role: "editor"` so its scripts can write
([ADR 212](212-one-automation-surface.md), amendment 1), and it showed all three.

**What the rail offers is one question.** `ChromeRegions.offersTool(id)` answers it from the
profile's `tool-rail` region (`railOffersTool`: a list's ids and globs, `@bundles` for a tool the
host did not register, nothing when the region is removed). `PagedShell` passes the host's tools
to `chromeRegionsOf` for `@bundles`. The rail draws what it offers and the features allow, as
before. Three things now follow the same answer:

- **The start tool.** `ToolProvider` starts on the first of Selection, Hand and Zoom the rail
  offers (`startToolOf`): Selection in the full editor, the solo presets and `template-fill`, as
  before; the Hand in `viewer`. An editor whose rail offers none of them, or that has no rail
  (`form`), starts on the Hand: panning is the one thing every canvas does, and each of the
  three is registered in every editor (`ALWAYS_IN_PALETTE`).
- **The modifier hints.** The strip shows only for a tool the rail offers, and only such a tool
  counts a use. A tool the profile does not show is not one the user is learning: Selection
  reached by a shortcut in a viewer, Direct Selection spring-loaded on a rail that leaves it out,
  any tool in an editor without a rail. This rule was chosen over "no hints without a context
  toolbar or menu bar", which would be a proxy: the hints describe the tool in hand, and the rail
  is where the profile says which tools the user has. In the full editor every tool is offered, so
  nothing changes there.
- **The fill and stroke wells.** They colour what the rail's tools select and make (the
  selection, or the defaults of what is drawn next), so they follow the profile's rail, not the
  session's role: the foot draws them only while the rail offers a tool other than the ones you
  look with (`VIEW_TOOL_IDS`, Hand and Zoom). The role says what the engine permits; the regions
  say what the chrome shows. A viewer with an editing role (the lab) still has nothing on its rail
  to colour with. Soft proof and the screen mode stay at the foot: they are ways of looking. The
  wells came with the tool rail itself and no record chose them for a look-only rail.

The viewer preset keeps its page thumbnails (`canvas.thumbnails: true`). A host that wants the
canvas alone turns them off in the profile it passes:
`{ profile: { extends: "viewer", canvas: { thumbnails: false } }, role: "editor" }` (or
`features: { "chrome:thumbnails": false }` in the same profile object).

Evidence: `apps/canvas/test/embed/viewer-quiet.dom.test.tsx` mounts the app's canvas over the
engine as the lab does and finds Hand and Zoom on the rail with the Hand in hand, no hint strip
and no wells, with role `viewer` and with role `editor`, the thumbnails gone with
`canvas.thumbnails: false`, and the full editor unchanged; `packages/shell/test/stores/tool-state.dom.test.tsx`
(the start tool), `packages/shell/test/overlays/modifier-hints.dom.test.tsx` (the hints),
`packages/shell/test/profile/profile.test.ts` (`railOffersTool`); the journeys
`tests/journey/focused/demos.journey.spec.ts` (the lab's frame) and
`tests/journey/focused/template-fill.journey.spec.ts` (`?profile=viewer`).

