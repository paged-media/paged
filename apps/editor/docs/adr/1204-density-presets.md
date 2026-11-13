# ADR 1204 — Density presets

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/styles/theme.css` (the density tokens and the
  `[data-density]` presets), `packages/shell/src/state/density.ts` (the preference, the commands,
  Edit ▸ Settings ▸ Interface density), `packages/shell/src/state/editor-root.tsx`
  (`data-density`), the chrome that reads the tokens (header, context toolbar, the dock's tab
  strip, the document title bar, the mode bar, the cockpit kit), `scripts/theme-tokens.mjs` and
  `docs/theme-tokens.json`.
- **Implements:** the redesign strategy's §2.5.

## Context

Every bar of the chrome had its height written in its own inline style — the header 46 px, the
context toolbar 44, the dock's tab strip 36, the document title bar 34, the mode bar 48 — and the
kit's panel padding, section spacing and button heights likewise. A user could not make the
interface denser for long sessions or roomier on a touch-capable screen, and a design change meant
finding each number.

## Decision

Three presets, chosen in Edit ▸ Settings ▸ Interface density (`paged.view.density.comfortable`,
`.professional`, `.compact`) and remembered as the preference `paged.density`:

| Token                   | Comfortable | Professional (default) | Compact |
| ----------------------- | ----------: | ---------------------: | ------: |
| `--density-control-h`   |       36 px |                  30 px |   26 px |
| `--density-row-h`       |       34 px |                  28 px |   24 px |
| `--density-icon`        |       20 px |                  18 px |   16 px |
| `--density-pad`         |       18 px |                  14 px |   10 px |
| `--density-section-gap` |       18 px |                  12 px |    8 px |
| `--chrome-header-h`     |       52 px |                  46 px |   40 px |
| `--chrome-toolbar-h`    |       50 px |                  44 px |   36 px |
| `--chrome-tabstrip-h`   |       40 px |                  36 px |   30 px |
| `--chrome-titlebar-h`   |       38 px |                  34 px |   28 px |
| `--chrome-modebar-h`    |       54 px |                  48 px |   40 px |

The default block of `theme.css` holds Professional, which is the interface as it was; the other
two are `[data-paged-editor][data-density="…"]` blocks that re-point the tokens. The editor's root
element carries `data-density` (like the theme's class, never the page's `<html>`), so two
editors on a page keep their own. The chrome's bars, pills and the cockpit kit's padding, section
spacing and buttons read the tokens instead of numbers.

Density is the interface's size only. The canvas's zoom, the document's geometry and the
overlays drawn over the document read none of these tokens, and a switch is no undo step.

`docs/theme-tokens.json` lists each density token's value per preset (`densities`), generated
by `scripts/theme-tokens.mjs`; a host that sets a token through `setTheme` overrides it in every
preset.

## Consequences

- The presets and the preference are tested on the root element and in storage
  (`packages/shell/test/settings/density.dom.test.tsx`); the e2e test switches each preset
  through the menu and asserts the header's height, the unchanged zoom, page sizes and history
  (`apps/canvas/tests/e2e/uxi-workspace.spec.ts`).
- A new bar or kit control takes its height and spacing from these tokens.
- Panels outside the kit keep their own spacing until they move onto it.
