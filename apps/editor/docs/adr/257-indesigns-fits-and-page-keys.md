# ADR 257 — InDesign's fit commands and page keys, in the registry

- **Status:** Accepted 2026-10-20.
- **Scope:** `apps/canvas/src/app-commands.ts` (the `paged.view.fit*` and page commands, their
  menu entries and `APP_KEYBINDINGS`), `apps/canvas/src/ui/fit-views.ts`, the handlers in
  `apps/canvas/src/main.tsx`, `packages/shell/src/chrome/ZoomControl.tsx` and
  `state/zoom-range.ts` (`ZOOM_PRESET_SCALES`, `zoomCameraTo`), the command palette's right
  column, the Keyboard shortcuts panel, `registries/keybinding.ts` (`codeMatches`).
  Supersedes the Cmd+0 binding of ADR 246 and ADR 237's "Fit whole document stays on Cmd+0".

## Context

UX audit F-31: Cmd+0 fitted the whole document where InDesign fits the page; there was no Fit
spread and no Fit selection, and the zoom drop-down had four entries. F-16: the page keys
(Home, End, PageUp, PageDown) lived in a canvas hook, so no menu showed them and no bundle
could rebind them; the palette's right column showed command ids where chords belong; the
shortcuts panel listed one chord twice with no context.

## Decision

- **The fits, on InDesign's chords and names.** View ▸ Fit page in window (Cmd+0), Fit spread
  in window (Alt+Cmd+0), Fit selection in window (Alt+Cmd+=), Fit document (Alt+Shift+Cmd+0,
  the chord InDesign gives its whole-pasteboard view), each with its Ctrl twin. The current
  page is the one at the viewport's centre; a spread is every page with that page's
  `spreadId`; the selection's box is its items' page boxes (a group's through its leaves) moved
  by their pages' place in the layout. All of them go through the one zoom range (ADR 246).
- **The zoom drop-down** lists the four fits, the zoom steps and presets (25 % to 800 %); a
  preset zooms about the viewport's centre.
- **The page keys are commands** (`paged.view.firstPage`, `previousPage`, `nextPage`,
  `lastPage`) bound to Home, PageUp, PageDown and End and listed in Layout, as InDesign's Layout
  menu lists them. A text caret keeps Home and End: the text editor takes them first. The
  canvas hook is deleted.
- **An Alt chord on `=` or `-` also matches by the physical key**, as letters and digits do:
  Option changes the character on a Mac (Option+= types "≠").
- **The palette shows chords, never ids**, through the menus' formatter (this platform's
  twin); a command with no binding shows nothing on the right.
- **The shortcuts panel is grouped by context**: one section per command category, so a chord
  two contexts share (Cmd+D: Place, and Fill down in a sheet) reads as two contexts.

## Consequences

- F-31 and F-16 close (`test/unit/fit-views.test.ts`, `test/unit/keybindings.test.ts`,
  `packages/shell/test/chrome/command-palette.dom.test.tsx`,
  `test/panels/keyboard-shortcuts-panel.dom.test.tsx`).
- Ruler label thinning at low zoom, also named in F-31, is not part of this record.
