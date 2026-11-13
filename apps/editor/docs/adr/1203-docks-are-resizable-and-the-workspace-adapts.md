# ADR 1203 — Docks are resizable and the workspace adapts

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/cockpit/` (`CockpitLayout.tsx`, `DockSplitter.tsx`,
  `dock-sizing.ts`, `workspace-class.ts`, `focus-workspace.ts`, `cockpit-persistence.ts`,
  `drop-zone.tsx`, `canvas-frame/LoadingStatus.tsx`), `packages/shell/src/state/camera-context.tsx`
  (`anchorViewportResize`), `packages/shell/src/state/document-loader.ts` and
  `document-context.tsx` (`LoadingState.stage`), the header (`chrome/Header.tsx`,
  `CollabCluster.tsx`), the mode bar (`chrome/ModeSwitcher.tsx`, `ModeContribution.placeholder`),
  the Window menu (`PagedShell.tsx`'s `windowMenuGroup`, `PanelContribution.windowCategory`,
  `apps/canvas/src/panels/window-categories.ts`), `apps/canvas/src/ui/ViewportCanvas.tsx` (the
  resize anchor, the developer readout).
- **Implements:** the interaction contract's UXI-CAM-003, UXI-PNL-007 and UXI-PRF-003
  ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); the redesign strategy's §2.1–2.4 and
  §9.1. Closes UX audit F-17, F-18, F-21, F-23, F-24, F-53 and F-55.

## Context

The cockpit had three fixed columns: a 262 px left dock, the canvas and a 320 px right dock
(a form column of 340 px in the fill profiles), the same at every width. A 1280 × 720 window left
the canvas a quarter of the screen and an 800 × 600 window 64 px, with the page scrolling sideways
(F-55). Opening, closing or hiding a dock moved the document on screen by the dock's width,
because the camera is relative to the canvas's left edge. A large document opened onto an empty
dark canvas for 15–21 s (F-53); `LoadingState` existed and nothing read it. The header showed the
disabled Share as its loudest control and the tab title never named the document (F-24); the
developer readout sat over every canvas (F-21); two of the six modes were mostly "coming soon"
(F-23); the Window menu grew from the dock groups, with Title and sentence case mixed and one
panel under two names (F-17, F-18).

## Decision

**Resizable docks.** Each dock has a divider (`DockSplitter`): a WAI-ARIA window splitter — a
focusable `separator` whose value is the dock's width — dragged with the pointer, moved with the
arrows (Shift for 40 px), Home and End to the bounds, Enter or a double-click back to the default.
A dock is 240–480 px; the defaults are the old columns, 262 / 320 / 340. The widths are remembered
per workflow mode (`paged.cockpit.docks.v1`, scoped like the tabs' blob). Docked columns give way,
the left dock first, so the canvas keeps its working minimum (`CANVAS_MIN_WORKING_PX`, 640); a
divider cannot be dragged past it.

**An adaptive workspace.** The layout follows the width the cockpit is GIVEN — its own element,
measured by a `ResizeObserver`: what remains after the host page, the header and the editor's two
rails, never the window. Three classes (`workspaceClassOf`), derived from canvas budgets beside
the default docks:

- **wide** (≥ 1442 px of work area — a comfortable 860 px canvas beside both docks): both docks
  docked.
- **laptop** (≥ 960 px — the working minimum beside the right dock): the left dock collapses to a
  40 px rail whose button opens it as a flyout over the canvas; the pin docks it again (remembered
  per mode).
- **narrow**: both docks are overlays, the left a flyout, the right a drawer that a panel rail
  button, the Window menu or any newly opened panel opens; the next press on the canvas closes
  them, and so does Escape inside them.

With a full-window editor and its rails the thresholds fall at about 1575 px and 1095 px of
window, the strategy's 1600 / 1100. Edit ▸ Settings ▸ "Adapt the workspace to the window"
(`paged.adaptiveWorkspace`, on by default) turns it off: the fixed layout at every width, both
docks docked at their chosen widths and nothing given way. A flyout or a drawer is the docked column restyled, so its
panels are not mounted again (ADR 240), and it does not resize the canvas. The header's menus
scroll inside their zone and the mode bar drops its labels and its zoom slider when narrow, so
nothing scrolls sideways. The fill shapes keep their own layout below 720 px of editor
(`state/compact.ts`, ADR 294). The class is published per editor (`useWorkspaceClass`) for the
chrome around the cockpit.

**A camera anchor on resize.** When the canvas's viewport changes size — a dock opens, closes, is
dragged, the window changes, the Focus workspace hides the chrome — the document point at the
viewport's centre stays where it was (`cameraKeepingCentre`: a translation by half the change,
right at any zoom and view rotation). The canvas's `ResizeObserver` reports the change
(`ViewportCanvas`'s `onViewportResize`) and the camera context applies it through `setCamera`.
Nothing re-fits, nothing changes the zoom, the selection or the history (UXI-CAM-001,
UXI-PNL-007). The anchor is the viewport's centre; a caret or a selected target as the anchor
(UXI-CAM-003's alternatives) is not taken yet.

**The Focus workspace.** `paged.view.focusWorkspace` (Cmd/Ctrl+., View ▸ Focus workspace, and the
context toolbar's Focus pill, which used to run the Tab toggle) hides everything but the canvas
and the tool rail: header, context toolbar, docks, panel rail, mode bar, title bar, page strip and
status bar. It is a flag over the layout, not a change to it, so the same command (or the
"Leave Focus workspace" button over the canvas) brings back exactly what was there, the Tab
toggles' state included. What it hides stays mounted. The Tab and Cmd+\ toggles (ADR 234) are
unchanged.

**Progressive loading.** A load reports real stages (`LoadingState.stage`): `recognized` (the
file's name and size), `geometry` (the page count, sizes and places), `firstPaint` (the first page
composed) and `refining` (the other pages prepared, `pagesReady` of `pageCount`); ready ends the
load. The canvas shows the stage in words and real counts, never a percentage, and until the
first page is composed outlines every page where it will be; the header shows the short form
beside the document's name. The pill comes in after 300 ms, so a document that opens at once
does not flash it. The viewport carries `data-loading-stage` (`ready` when done). The first open
still fits page 1 (ADR 237).

**The header and the chrome.** Beside the document's name sits the save status slot
(`SaveStatusSlot`, `data-save-status-slot`): today's dirty/saved dot, the mount point a
save-state machine fills. The browser tab reads "<document> — paged" when the editor is the page
(never an embedding host's tab). The disabled Share is a ghost button. A mode whose surfaces are
mostly seams declares `placeholder: true` and the mode bar does not offer it, unless it is the
active one (Review; Content now leads with Character and Paragraph). The developer readout
(`ViewportHud`) shows only with `?debug=hud`. The Window menu lists each editor panel once, under
InDesign's categories (Color, Styles, Type & Tables, Object & Layout, Interactive, Output,
Utilities) with eight panels one click deep (`windowCategory`, set from
`apps/canvas/src/panels/window-categories.ts`); panel names are sentence case and one name per
thing ("Bullets and numbering", "Numbering and section options", Draw's "Type on a path", "Color"
in paged.image and the host); a plugin's panel row that its own menu row already opens ("Data
query" beside "Data query…") is dropped; Insert ▸ "Web frame" lost the ellipsis of a dialog it
never opened. The renamed menu ids are deprecated aliases until 0.80.0
(`apps/canvas/deprecated-ids.json`, PM-0013 amendment 2).

## Consequences

- UXI-T50 and UXI-T49 are asserted on the camera, the selection and the history
  (`apps/canvas/tests/e2e/uxi-workspace.spec.ts`), F-55 at 1280 and 800 px there too; the DOM
  tests mount the shell at each class (`apps/canvas/test/shell/workspace.dom.test.tsx`); the
  sizing rules, the anchor and the settings have unit tests (`packages/shell/test/cockpit/`,
  `test/settings/cockpit-docks.test.ts`); the Window menu's rules are INV-REG-4
  (`tests/e2e/registry-invariants.spec.ts`).
- The canvas and the overlays move together when a dock changes, so a spec that reads a screen
  position after a layout change reads the camera after it.
- The browser suite's window is 1280 px, a laptop width. `openCanvas` boots with the adaptive
  workspace off unless a spec passes `adaptiveWorkspace: true`, so the specs about panels read
  the docked layout they were written against; the workspace's own specs run at 1600 px with it
  on and step down to 1280 and 800.
- A dock's divider is a tab stop between the dock and the canvas.
- File ▸ "New document…" keeps its ellipsis: the New document dialog of the interaction plan
  (DF5) is what it opens.
