# ADR 294 — The fill presets on phones and tablets

- **Status:** Accepted 2026-10-24.
- **Scope:** the profile's `compact` and `canvas.preview` (`packages/shell/src/profile/`),
  `packages/shell/src/state/compact.ts`, `cockpit/CockpitLayout.tsx` and `cockpit/TouchZoom.tsx`,
  the header and region buttons; `apps/canvas/src/ui/ViewportCanvas.tsx` and `ui/pinch.ts`
  (touch pan and pinch), `panels/canvas-panel.tsx`, `panels/template/form-panel.tsx`,
  `overlays/template-fields.tsx`; the `template-fill` and `form` presets
  (`apps/canvas/src/profiles/presets.ts`). Follows [ADR 276](276-filling-a-template.md) and
  decision 3 of the composable editor's concept (§12, "Decided on 2026-10-24").

## Context

The person who fills in a template is often on a phone: a business card ordered from a shop,
a postcard sent from a trip. The `template-fill` preset was a desktop layout (a tool rail, the
form as a 320 px column on the right) and the canvas answered a finger as it answers a mouse: a
drag on a field tried to move it and was refused, a drag on the page drew a marquee, and two
fingers did nothing useful. The `form` preset of the concept (§5.4) did not exist. The full and
focused editors are desktop editors and stay so; only the fill shapes are made for touch.

## Decision

**A breakpoint, measured on the editor.** Below 720 CSS px (`COMPACT_MAX_WIDTH_PX`) a fill
shape uses its compact layout. The width is the editor root's, not the window's, so an editor
embedded in a narrow column is narrow. 720 puts every phone on the compact layout and keeps a
tablet in portrait (768) on the desktop one.

**The profile says what compact means.** `EditorProfile.compact` is `form-first`,
`field-sheet` or `null` (the desktop layout at every width), resolved through the preset chain
and shape-checked. A profile without it, the full and focused editors among them, never
changes layout. A host turns it off with `compact: null`.

- `template-fill` is `field-sheet`: the canvas takes the screen, the tool rail gives way, and
  the form region becomes a sheet under the canvas that shows the field selected on the
  canvas, with Done to put it away and All fields to list every field.
- The new `form` preset is `form-first`: the form takes the width, and the preview is folded
  away behind a Show preview toggle above it. On a wide screen the form is a column beside the
  preview. Its canvas is a preview (`canvas.preview`): it pans and zooms and never selects or
  edits.

The form is the `form` region in both presets (no longer the right dock's inspector):
rendered by the cockpit as a column on the wide layout, and as the sheet or the first column
on the compact one.

**Touch-sized.** In a fill shape, below the breakpoint or wherever the primary pointer is
coarse, every control is at least 44 by 44 px (`TOUCH_TARGET_PX`): the header's and the
actions bar's commands, the form's inputs (at 16 px type, so a phone does not zoom the page
into them), the sheet's buttons, the canvas's Replace button, and three zoom buttons over the
canvas (zoom out, fit page, zoom in) that run the View menu's commands.

**Touch on the canvas.** A filler or a viewer moves nothing by dragging, so for them one
finger pans the page and a tap selects, as a click does; a pen and a mouse are unchanged. Two
fingers anywhere pinch: the document point under their starting midpoint stays under their
midpoint and the scale follows their distance. The second finger rolls back whatever the
first began (never commits it), and the touch stays the pinch's until every finger is lifted.
Long-press is not used.

**A picture from the camera.** A touch-sized picture field offers two inputs instead of
Replace: Take photo (`accept="image/*"`, `capture="environment"`, so a phone opens its camera)
and Choose picture (the library and files). Both place the bytes through
`replaceImageBytes`, the path Replace takes, which the engine checks as `image.replace`.

**Motion.** The sheet rises into place, only under `prefers-reduced-motion: no-preference`.

## Evidence

- `apps/canvas/test/panels/fill-touch-layout.dom.test.tsx`: the breakpoint; form-first folds
  the preview behind a 44 px toggle and shows the form column wide; field-sheet shows the
  sheet and 44 px zoom buttons; a desktop editor at phone width is unchanged; the sheet shows
  the selected field at 44 px and 16 px type, fills it, puts it away and lists all fields; a
  picture field offers the camera and the library, and keeps Replace when wide.
- `apps/canvas/test/shell/regions.dom.test.tsx`: the whole shell below and above 720 px.
- `apps/canvas/test/unit/pinch.test.ts`: the pinch arithmetic.
- `packages/shell/test/profile/profile.test.ts`: `compact` and `canvas.preview` through the
  chain and the shape check.
- `apps/canvas/tests/journey/focused/mobile-fill.journey.spec.ts`: on an emulated Pixel 7, the
  business card demo filled by tapping a field and typing, a photo through the camera input,
  one-finger pan, the zoom buttons and a pinch, and Submit; on an emulated iPhone 13 the form
  layout with its preview folded out on request.

## Consequences

The business card demo works on a phone, and `?layout=form` shows it as the form preset. A
host that placed the form panel in a dock of a `template-fill` profile keeps it there; the
preset itself now uses the form region. The full and focused editors, and any profile without
`compact`, have the same layout and sizes at every width.

## Related

- [ADR 274](274-the-editor-profile-is-runtime-data.md) — the profile and its presets
- [ADR 276](276-filling-a-template.md) — filling a template
