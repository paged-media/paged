# ADR 1231 — High contrast and AA

- **Status:** Accepted 2026-11-14 (plan task AP3 of
  [`interaction-plan.md`](../interaction-plan.md)).
- **Scope:** `packages/shell/src/styles/theme.css` (the token fixes and the high-contrast
  blocks), `styles/globals.css` (the high-contrast focus ring and overlay halo),
  `state/contrast.ts` (the preference, the commands, Edit ▸ Settings ▸ Contrast),
  `state/editor-root.tsx` (`data-contrast`), the chrome that faded its hints with opacity
  (`chrome/MenuBar.tsx`, `ContextToolbar.tsx`, `ToolRail.tsx`), `chrome/Header.tsx` (the
  search trigger's name), `chrome/ZoomControl.tsx`, `components/ui/dialog.tsx` (target
  sizes), `scripts/theme-tokens.mjs` and `docs/theme-tokens.json`,
  `platform/shared/panel-kit` (its fallback for `--pg-muted-fg`).
- **Requirements:** `UXI-A11Y-001`, `A11Y-002`, `A11Y-012`, `A11Y-013`; tests `UXI-T74`,
  `UXI-T75`; closes UX audit F-51.

## Context

The October audit measured the menus' shortcut hints at 2.94:1 (dark) and 2.30:1 (light),
the "soon" badges at 2.46:1 and 1.96:1, and the search placeholder at 4.35:1 (F-51). The
hints were drawn in the muted token and then faded again with `opacity: 0.6`. A token
script over theme.css found more: the light theme's muted text on its muted surfaces (4.3 to
4.4:1), the tool rail's labels in both themes (3.9 to 4.4:1), the draft status grey (2.6:1
light, 3.4:1 dark) and the destructive red as text (3.8:1 light, 4.4:1 dark). axe found a
search trigger whose name did not contain its visible words, a zoom-menu trigger and the
dialogs' close button under 24 px. There was no high-contrast mode, and `prefers-contrast`
was not read.

## Decision

1. **AA in both themes.** Every text token on every surface it is drawn on meets 4.5:1:
   light `--paged-muted-fg` 42 % (was 45 %), `--pg-muted-fg` #6b6b6b, `--chrome-label`
   #65656e, `--status-draft` #71717a, the destructive red 0 72 % 45 %; dark `--chrome-label`
   #92929e, `--status-draft` #8e8e98, the destructive red 0 80 % 66 % with dark text on it.
   Hints are drawn in their token, never faded with opacity (menus' accelerators, group and
   label rows, the tool rail's flyout shortcuts, the context toolbar's notes). The glyphs
   and the focus ring meet 3:1.
2. **High contrast**, `data-contrast="more"` on the editor's root, re-points the tokens of
   the theme in use (`[data-paged-editor][data-contrast="more"]:not(.dark)` and
   `[data-paged-editor].dark[data-contrast="more"]`): text 7:1 or more, field and panel
   boundaries and the focus ring 4.5:1 or more, status colours deepened (light) or lifted
   (dark), the overlays' print-cue hues kept and strengthened. In it the focus ring is
   3 px with a band of the surface between it and the control, and every overlay cue — the
   selection's edges and handles, guides, snap lines, targets — is drawn with a two-tone
   halo (`--overlay-halo`, `--overlay-halo-edge`) so it reads over white paper, a dark
   image and the surround alike.
3. **The preference** `paged.contrast` (Edit ▸ Settings ▸ Contrast: As the system, Standard,
   High; `paged.view.contrast.system`, `.standard`, `.high`), per editor, in its storage,
   claimed in the settings inventory. As the system (the default) follows
   `prefers-contrast: more` as it changes. Never the document, never an undo step.
4. **Status is never colour alone**: the kit's status language is a dot with words
   (`StatusPill`); the object tree says "locked" and "hidden"; the save state and the
   loading stages are words (ADRs 1203, 1208).
5. **Pointer targets of 24 px** (WCAG 2.5.8) for the zoom menu and the dialogs' close button;
   the search trigger's name is its visible words, with `aria-keyshortcuts` for ⌘K.
6. **Proof, two ways.** `packages/shell/test/styles/theme-contrast.test.ts` computes WCAG
   contrast from theme.css for the four variants (a token change that breaks a pair fails
   there), and `tests/e2e/uxi-accessibility.spec.ts` runs axe (WCAG 2.0–2.2 A and AA rules)
   over the chrome, three menus and the palette in dark, light and both high-contrast
   variants; `AXE_EXCEPTIONS` in that file is empty.
7. **200 % zoom.** At a 640 × 400 CSS-pixel viewport with twice the device pixels (200 % of
   1280 × 800) and reduced motion, nothing scrolls sideways, no header control is cut off
   by the window, Tab reaches the canvas with a visible ring, Alt+Shift+O reaches the
   object tree and Escape comes back, and a zoom is one camera step (`UXI-T75`).

## Consequences

- F-51 is fixed. `UXI-T74` and `UXI-T75` are claimed.
- The standard themes' hairlines (`--border`, `--chrome-divider`, `--input`) stay under
  3:1: they separate surfaces and are not the only cue that identifies a control (fields
  carry a fill and a label). High contrast brings them to 4.5:1 for whoever needs the
  boundaries; this is the one place the standard themes stop short of 1.4.11, and it is a
  decision, not an oversight.
- `docs/theme-tokens.json` lists each token's high-contrast values (`highContrast`), so a
  host that themes the editor sees them.
- The chrome screenshots of the journeys' `chromeCheckpoint` (skipped in CI) change with
  the muted tokens; their local baselines are regenerated when next run.
- A Windows "forced colors" mode is not specifically styled: the browser's forced palette
  applies, and the overlays keep their strokes; a manual check belongs to gate G4.
