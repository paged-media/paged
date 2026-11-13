# ADR 1211 — Navigation history and one current page

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/current-page.ts` and `use-current-page.ts` (the one current
  page), `navigation-history.ts` and `camera-context.tsx` (Back and Forward, `peekCamera`,
  `cameraRevision`), `zoom-range.ts` (Actual size, the calibrated scale, the zoom field's text),
  `zoom-calibration.ts` (`paged.view.calibration`), `chrome/ZoomControl.tsx` (the editable zoom
  field and its menu), `chrome/ModeSwitcher.tsx` (Back and Forward, the slider's range);
  `apps/canvas/src/ui/useAnimatedCamera.ts` (reduced motion, interruptible tweens, recorded
  jumps), `ui/layout.ts` (`fitCamera`, `zoomAt`), `ui/fit-views.ts`, `app/mount.tsx` (the fits,
  the page keys, the jumps, the named views, Back and Forward), `app-commands.ts`,
  `insert-commands.ts` (`pageTargetFor`), `cockpit/control-bar.tsx` (the page readout),
  `panels/zoom-navigator-panel.tsx`, `plugin-pages.ts`, `panels/screen-calibration-dialog.tsx`.
- **Implements:** the interaction contract's UXI-CAM-004, -005, -007, -015 and -016 and §13.2's
  zoom field and Actual size ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); D-12 of
  [ADR 1201](1201-interaction-decisions.md); the redesign strategy's §4.2. Amends
  [ADR 246](246-one-zoom-range.md) and [ADR 257](257-indesigns-fits-and-page-keys.md). Closes UX
  audit F-52.

## Context

ADR 246 gave the camera one range, 5 % to 4,000 %, applied in `CameraProvider.setCamera`, but two
inputs still computed with bounds of their own: the Zoom tool's click asked `zoomAt` for 1 % to
6,400 %, and `fitCamera` stopped at 1 %. The provider's clamp then corrected them about the
viewport's centre, so a Zoom click at the top of the range jumped away from the point clicked,
and Fit document on a long document asked for a scale the range refused. The bottom bar's slider
ran from 1 % to 800 %.

The camera's tweens (220 ms, cubic ease-out) ignored `prefers-reduced-motion` (F-52), and a tween
kept writing its frames after the user had taken the camera: a wheel zoom during a fit was
overwritten by the next frame of the fit.

Nothing remembered where an explicit jump came from: after a fit, a page key or a jump from a
search, a preflight finding or Go to page, the only way back was to find the place again.

"The page the user is on" was computed in four places, four ways: the control bar's readout
(the page nearest the viewport's centre, by distance to its edge, the later page on a tie), the
insert verbs and the active page plugins read (the containing page, else the nearest, the earlier
on a tie), the fits and the page keys (the page whose centre was nearest, ignoring the view's
rotation), and the Navigator panel (a fifth copy, also ignoring rotation). In a turned view or
over a gap they could disagree: the readout named one page while Fit page fitted another and an
insert landed on a third. The developer readout over the canvas keeps a sixth copy.

The zoom readout was a drop-down showing a percentage; it could not be typed into, and ADR 1201
D-12 asked for Actual size and a calibrated size as named views beside 100 %.

## Decision

**One current page.** `currentPageIndex(rects, camera, viewport)` in
`packages/shell/src/state/current-page.ts` is the rule, and every reader asks it: the control
bar's page readout and its arrows, Fit page and Fit spread, the page keys, the insert and object
verbs' "this page" (`pageTargetFor`), the active page a plugin reads (`client.setActivePage`,
`host.viewport.activePage`), and the Navigator. `useCurrentPage()` gives a component the same.
The rule:

1. No pages: −1.
2. An unmeasured camera or viewport: page 0, the page a document opens on.
3. The point judged is the viewport's centre, mapped into document points through the camera,
   **rotation included**.
4. The page whose rectangle contains it (edges included); when several do (pages touching at a
   spine, overlapping artboards), the first in document order.
5. Else the page nearest to it, by distance to the rectangle (not to its centre); on equal
   distances, the first in document order.

**One zoom range, every route.** `fitCamera` clamps its scale with `clampScale`, so a fit that
would need less than 5 % stops at 5 %, centred (Fit document on twenty Letter pages). `zoomAt`
holds its result inside the range for every caller and ignores the bounds a caller passes, so the
Zoom tool's click stops at 4,000 % about the point clicked; its last caller drops the argument
(the Zoom tool's `zoomAt(…, 0.01, 64)` in `ViewportCanvas.tsx`, which the interaction-core track
owns). `plugin-pages`' width fit and the bottom bar's slider use the range too (the slider maps
5 %–4,000 % on a log scale).

**The zoom field.** The bottom bar's zoom readout is an editable field: a typed percentage ("150",
"150 %", "33,5") zooms about the viewport's centre on Enter or blur, clamped to the range, and the
field then shows the normalised result (9,000 % reads 4,000 %); text that is not a positive number
changes nothing; Escape restores the live value. Its menu lists Fit page, Fit spread, Fit
selection and Fit document; Zoom to 100 %, Actual size and Calibrated size; Zoom in and out; the
presets; and Calibrate screen size…. Each entry but the presets runs its registered command.

**The named views (D-12).** 100 % stays a camera scale of 1: a point per CSS px, an inch as 72
CSS px, as in InDesign; no percentage changes meaning. **Actual size**
(`paged.view.actualSize`) shows an inch of the document as 96 CSS px, the browser's reference
inch (`ACTUAL_SIZE_SCALE`, about 133 %). **Calibrated size** (`paged.view.calibratedSize`) shows
an inch as an inch on this screen, from a calibration: View ▸ Calibrate screen size… asks the user
to hold a ruler to the screen and stretch a bar to 10 cm or 4 in. The bar's length in **device**
pixels over its length in inches is the screen's density, remembered as `paged.view.calibration`
(`{devicePxPerInch}`, 40–1,200, shape-checked as ADR 247 asks); the scale is that density over
`devicePixelRatio` over 72. Device pixels belong to the monitor, so the calibration holds when the
browser's zoom or the system's display scaling changes (both change `devicePixelRatio`); a window
moved to another monitor needs another calibration. Without one, Calibrated size opens the
calibration and applies the view when it is saved. Both are zooms about the viewport's centre,
not navigations. All three are in View, after Zoom to 100 %.

**Navigation history.** The camera context keeps, per editor, a Back and a Forward list of
camera places (`createNavigationHistory`, at most 50 places). An **explicit navigation** records
the place it leaves: the four fits, the page keys (First, Previous, Next, Last page), a page jump
from the document map, the thumbnails, the page list, the artboards, the outline, the stories, a
preflight finding or a separation (the cockpit's page navigator and the panels' jumps through
`useAnimatedCamera`), Go to page and a search hit (`host.viewport.goToPage` and `revealText`,
which plugins use too). A **free** move records nothing: the wheel, the Hand, the Navigator's
drag, the zoom keys, Zoom to 100 %, the presets, the field, the slider, Actual size, the
calibrated size and Rotate View. Back returns to the place the last navigation left, keeping the
live camera — wherever the user has panned to since — for Forward; a new navigation forgets the
Forward places, as a browser does. A navigation that does not move the view records nothing, and
two jumps in quick succession record where the first was going, not a frame of its tween. The
places are cameras (scale, translation, rotation): going back never changes the selection (D-15)
or the document, and is not an undo step. The lists empty when another document opens.

The commands are `paged.view.navigateBack` and `paged.view.navigateForward`, Layout ▸ Go back and
Go forward (InDesign's names and place, after the page keys), on InDesign's chords: Cmd/Ctrl+PageUp
and Cmd/Ctrl+PageDown (Fn+Cmd+↑ / ↓ on a Mac keyboard without page keys). The bare page keys
keep paging; Alt+← / → stays tracking in text and Cmd+[ / ] Arrange. Each command is disabled
while its list is empty, and the bottom bar shows a Back and a Forward button before the zoom
field, disabled the same way.

**Tweens.** With `prefers-reduced-motion: reduce` (read at each jump) a tween writes its target
in one step: the same final view, no motion (UXI-CAM-005). A tween yields to whoever moves the
camera next (UXI-CAM-004): `setCamera` counts its writes, and each frame of a tween checks the
count against the one after its own last write; a wheel step, a pan, a resize anchor or another
command in between owns the camera, and the tween stops where that write left it. A tween starts
from the camera last written (`peekCamera`), not from the last rendered one.

## Consequences

- UXI-T48 (the fits' bounds and the shared range, the field and the wheel at the limits), UXI-T53
  (reduced motion: one write, the animated jump's final view), UXI-T54 (the readout and the active
  page follow a pan by the rule, in a turned view too) and UXI-T55's navigation half (a Go to page
  and a Fit selection, Back and Forward by the buttons and the chords, the target still selected)
  are asserted on the camera, the selection and the history in
  `apps/canvas/tests/e2e/uxi-navigation.spec.ts`; the field's typed zoom in
  `packages/shell/test/chrome/zoom-field.dom.test.tsx` (UXI-T48); the rule, the history and the
  named views in `packages/shell/test/state/current-page.test.ts`, `navigation-history.test.ts`
  and `zoom-views.test.ts`; the chords in `apps/canvas/test/unit/keybindings.test.ts`. UXI-T55's
  issue markers (navigate from a publication issue, select, fix, return) are track DF's (DF7) on
  this history. F-52 closes.
- The developer readout (`ViewportHud` in `ViewportCanvas.tsx`, behind `?debug=hud`) still
  computes its running-header page on its own; it moves onto `currentPageIndex` with the
  interaction-core track, which owns that file, as does the Zoom tool's now-ignored bounds
  argument.
- The unused `apps/canvas/src/ui/ZoomField.tsx` (a NumberInput nothing mounted) is gone; the
  field is the shell's.
- A comment card does not move the camera, so it records nothing; a jump that does (DF7's issue
  markers, the page lenses) goes through the same recorded tween.
- Plugins see the history only through the commands; the contract is unchanged.

## Related

- [ADR 246](246-one-zoom-range.md), [ADR 257](257-indesigns-fits-and-page-keys.md) — amended.
- [ADR 287](287-view-modes.md) — the camera's rotation the rule and the fits honour.
- [ADR 1208](1208-docks-are-resizable-and-the-workspace-adapts.md) — the resize anchor, a
  camera write that stops a tween like any other.
- [ADR 247](247-stored-settings-are-shape-checked.md) — the calibration's shape check.
