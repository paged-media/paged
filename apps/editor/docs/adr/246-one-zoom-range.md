# ADR 246 — One zoom range, and the view chords in the keybinding registry

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/state/zoom-range.ts`, `CameraProvider.setCamera`,
  `apps/canvas/src/app-commands.ts` (`APP_KEYBINDINGS`), `apps/canvas/src/ui/ViewportCanvas.tsx`
  (the wheel), `apps/canvas/src/ui/ZoomField.tsx`.

## Context

Keyboard zoom ran to a camera scale of 634.8 (63,484 %), ctrl+wheel stopped at 16 (1,600 %),
the % field at 1,600 % (UX audit F-31). Cmd+0 and Cmd+1 lived in a canvas hook, so the View
menu showed no chord for Fit document or Zoom to 100 % and a bundle could not see or rebind
them (F-16, SH-9). Shift+wheel panned vertically (F-33). InDesign zooms from 5 % to 4,000 %,
and on Windows and Linux a Shift+wheel is the horizontal scroll.

## Decision

- One range, 5 % to 4,000 % (`ZOOM_MIN_SCALE`, `ZOOM_MAX_SCALE`), applied in ONE place: every
  camera write passes `CameraProvider.setCamera`, which clamps it (`clampCamera`) about the
  viewport centre. Keyboard zoom, the wheel, the % field, the fit commands, the navigator and
  a plugin's camera write therefore share it. A fit that would need less than 5 % stops at 5 %,
  as InDesign's does.
- Cmd/Ctrl+0 and Cmd/Ctrl+1 are registry bindings onto `paged.view.zoomFit` and
  `paged.view.zoom100`; the hook keeps only the page keys (Home, End, PageUp, PageDown).
- A wheel event with Shift held and no `deltaX` of its own pans sideways by its `deltaY`. A
  device that already reports `deltaX` (a trackpad, macOS's own Shift mapping) keeps its deltas.

## Consequences

SH-9, F-31 and F-33 close (`test/unit/keybindings.test.ts`, `tests/e2e/ux-audit-gestures.spec.ts`).
Fit page, Fit spread and Fit selection (the rest of F-31's recommendation) are not added here.

## Amendment 2026-10-20

Cmd/Ctrl+0 fits the page now and Fit document moved to Alt+Shift+Cmd/Ctrl+0; Fit page, Fit
spread, Fit selection, zoom presets and the page keys are added as commands
([ADR 257](257-indesigns-fits-and-page-keys.md)).
