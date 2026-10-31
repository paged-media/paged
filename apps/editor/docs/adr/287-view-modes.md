# ADR 287 — View modes, grids and smart guides

- **Status:** Accepted 2026-10-24.
- **Scope:** the engine's view rewrite (`engine/core/crates/paged-gpu/src/view.rs`,
  `RasterOptions.view` / `.pixel_preview`), the session's view settings
  (`paged-canvas/src/view.rs`, `SetViewSettings` → `ViewSettingsApplied`, protocol v77), the
  GPU screen's scene cache (`paged-canvas-wasm/src/scene_cache.rs`) and Pixel Preview's present
  (`paged-gpu/src/surface.rs`); snapping v2 (`paged-canvas/src/snap.rs`, `snap_point.rs`);
  the camera's rotation (`paged-canvas/src/camera.rs`, `packages/client/src/sab/camera.ts`);
  the View menu (`apps/canvas/src/view-commands.ts`), its toggles
  (`packages/shell/src/state/view-toggles.ts`), the Guides & Grid preferences
  (`packages/shell/src/state/view-preferences.ts`, `apps/canvas/src/panels/view-preferences-dialog.tsx`),
  `ViewSettingsSync`, and the grid and snap-line overlays. Work packages WP2.5 and WP4.7 of the
  image/draw master plan.

## Context

The editor had one way to look at a page: the composite, with overprint simulated on the CPU
tiles and drawn as knockout on the GPU screen. Illustrator users expect Outline (⌘Y),
Overprint Preview, Pixel Preview, a visible document grid, a pixel grid, Snap to Grid / Pixel,
smart guides that measure and space, rotate snapping and a rotatable view. The document grid
existed only as a snap target nobody could see, and the editor never sent the engine its snap
settings.

## Decision

**A view is a raster-time rewrite of the display list, never a build option.**
`paged_gpu::view::apply_view` rewrites a list for a `RasterView`: `Composite` (the list as
built), `Knockout` (`FillPathOverprint` / `StrokePathOverprint` back to plain fills and strokes —
exactly the list a build that never ran `rewrite_tail_for_overprint` would produce) or `Outline`
(every filled or stroked path as a one-device-pixel black hairline of its geometry, a placed
image as its box with both diagonals, clips kept, effects, blend groups, transparency layers and
soft-mask sources dropped). Both lanes run the same rewrite at their door
(`draw_with_view`), so they cannot disagree; the model's build, its digest (ADR 101) and every
export, snapshot and separation are untouched, because none of them names a view.

**Four modes, one session setting.** `ViewMode { Preview, Outline, OverprintPreview,
PixelPreview }` travels in `SetViewSettings` (a new message kind: protocol 77). Preview draws
overprints as knockouts — the default of Illustrator's and InDesign's screens, and what the GPU
screen always drew; the CPU tiles, which simulated them, now agree with it. Overprint Preview
simulates them: the CPU lane composites per ink, and the GPU screen shows an overprinting page as
a CPU raster made at the camera's scale bucket (the Vello lane draws overprints as knockouts).
Pixel Preview draws the page at 72 ppi — one pixel per point — and enlarges it with
nearest-neighbour sampling: the CPU tile loop asks for a 72 ppi tile and draws it unsmoothed; the
GPU screen composes the visible pages at one texel per point into a low-resolution target whose
texels sit on whole points and enlarges it with a `textureLoad` blit through the inverse camera
(`pixel_preview_plan`), so it holds under view rotation. Below one device pixel per point there
is nothing to enlarge and the vector scene shows.

**The scene cache is keyed by page and view.** `SceneView` is `Knockout`, `Outline(bucket)` or
`OverprintRaster(bucket)`, the bucket a quarter-octave of the camera scale, so Outline's hairline
stays within ±9 % of a pixel and a zoom rebuilds a few times per doubling, not per frame. An edit
drops every view of its pages.

**The View menu is toggles in the editor's scope.** Outline (⌘Y), Overprint Preview (⌥⇧⌘Y) and
Pixel Preview (⌥⌘Y) add up to one mode (`viewModeOf`; Overprint and Pixel Preview exclude each
other); Show Grid (⌘'), Snap to Grid (⇧⌘"), Show Pixel Grid, Snap to Pixel and Smart Guides (⌘U)
beside them; Rotate View ▸ 15° clockwise / counterclockwise / Reset rotation (⇧⌘1). The chords are
Illustrator's and none was taken (the editor's keymap, the module registers of
`modules/draw/CLAUDE.md`). A Shift chord on a digit or `'` matches by the physical key, as an Alt
chord already did. None of the toggles is a document change, so none is an undo step.
`ViewSettingsSync` hands the mode and the snap settings to the engine whenever they change.

**Grids are drawn by the host, snapped by the engine, from one preference.** Guides & Grid
preferences (a gridline every 72 pt with 8 subdivisions by default, a colour, grids in back,
the smart-guide options, the tolerance) are an editor preference in localStorage (ADR 247).
The overlay draws the gridlines per visible page; the engine snaps to
`gridEvery / gridSubdivisions` (`SnapSettings.gridEvery`, which overrides the document's
gridline divisions), so what snaps is what shows. "Grids in back" cannot put a line under the
artwork of a raster the overlay sits on; it multiplies the grid into it instead — plain on paper,
sunk into dark fills. The pixel grid (one line per point) shows in Pixel Preview at 600 % and
above.

**Snapping v2.** Snap to Pixel lands an edge or point nothing else took on a whole point. A
rotated item snaps through its oriented box (the extremes of its turned corners). Moving between
neighbours snaps to equal spacing and draws the gaps (`SnapLine.kind = spacing`, `distance`).
Scale snaps the dragged handle like a resize edge (Shift: one axis, so the proportion holds).
Rotate snaps the item's angle to 0/45/90° and to the angles of the items on the page within a
tolerance that is the pointer's screen tolerance at its radius; Shift keeps its 15° steps. The
point resolver adds outline intersections (a point target), 45°/135° and custom-angle
construction guides from the caller's points, and draws its smart guides from the point they came
through to the snapped point with the distance. `SnapLine` gains the optional `kind`, `from`,
`to`, `angle` and `distance`, omitted when unset, so an older reader sees the v76 shape; the host
labels distances in the document unit.

**Rotate View turns the camera.** The camera SAB's spare slot (offset 12) carries the rotation;
`viewport = scale · R · doc + t`, so a pan and a zoom about a point are the same formulas at any
rotation. `viewportToDoc` / `docToViewport` honour it, so hit tests, gestures and the overlays
(drawn under `cameraMatrix`) follow; a camera written without a rotation keeps the view's; the
fit commands fit the turned page.

## Evidence

- `engine/core/crates/paged-gpu/src/view.rs` (unit): Composite borrows the list; Knockout turns
  overprints back into plain draws; Outline strokes every path with a device-pixel hairline,
  draws an image as its box and cross, drops effects and groups, skips a soft mask's source;
  the zoom bucket; the nearest-neighbour enlargement; the Pixel Preview plan under zoom and
  rotation.
- `paged-gpu/tests/it/view_parity.rs`: Outline and Pixel Preview on the CPU and Vello lanes agree
  (engine ADR 146), on a GPU adapter.
- `paged-canvas/src/view.rs`, `camera.rs`, `snap.rs`, `snap_point.rs` (unit): the wire spelling
  and the modes' raster views; the rotated camera's round trip; a rotated item snapping through
  its oriented box; equal spacing (centred and repeated) and its gap lines; Snap to Pixel; the
  host grid overriding the document's; scale and rotate snapping; outline intersections, angle
  guides, smart-guide extents.
- `paged-canvas-wasm/tests/it/scene_cache.rs` and `dispatch.rs`: each view has its own scene of
  a page, Outline per zoom bucket, Overprint Preview rasterising only overprinting pages; the view
  settings survive a load and rebuild nothing.
- `packages/shell/test/settings/view-toggles.test.ts`, `test/state/view-modes.test.ts`: the
  toggles' defaults and exclusivity, the engine mode they add up to, the snap settings they send,
  the preferences' shape check and persistence, the grid overlay's lines, the camera rotation.
- `apps/canvas/test/unit/commands/view-commands.test.ts`, `view-preferences.test.ts`: every
  command flips its toggle (no undo step), Rotate View and the preferences reach their handlers,
  the rows tick, the chords are free; the dialog opens with the stored preferences.
- `apps/canvas/tests/e2e/view-menu.spec.ts`: ⌘Y changes the canvas and no document and ⌘Y again
  restores it; Overprint and Pixel Preview reach the engine and exclude each other; a move snaps
  to the 9 pt grid; Rotate View turns the canvas and a click still selects the frame under it;
  the preferences change the grid's step.

## Consequences

Outline draws text as its glyph outlines (the display list carries glyphs as paths). Overprint
Preview on the GPU screen costs one CPU raster per overprinting page per zoom bucket. Pixel
Preview of a page placed off whole points (none is today; pages stack at whole points) would
show its pixel grid offset. Resize of a rotated item still passes through unsnapped: its handle
moves the item's own axes, and snapping that edge needs the oriented edge as a target, which is
left for the Free Transform work (WP4.1). The rulers do not turn with the view.

## Related

- Engine ADR 146 (GPU/CPU parity), ADR 101 (display-list digest), ADR 205 (the canvas's markers)
- [ADR 246](246-one-zoom-range.md) — every camera write passes `CameraProvider`
- [ADR 247](247-stored-settings-are-shape-checked.md) — stored preferences
