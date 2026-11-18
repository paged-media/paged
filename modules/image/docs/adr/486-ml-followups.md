# ADR 486 — ML follow-ups: the contextual task bar, face-aware Liquify, reference images

- **Status:** Accepted, 2026-11-01 (WP8.2, the parts [ADR 485](485-ml-features.md) left open).
- **Scope:** `glue/src/ml-taskbar.tsx` (the overlay), `faces-liquify.ts` (landmarks to strokes),
  `filters-warp.ts` (Liquify's face parameters and `run`), `session.ts` (`openWarpDialog`),
  `ml-features.ts` (`detectFaces`, `setReferences`, the references in `editRegion`),
  `panels/sections/ml-section.tsx` (the picker), `panels/sections/filter-dialog.tsx` (the hint),
  `binding-provider/links-provider.ts` (`referenceCandidates`).

## Decision

**The task bar is an overlay of the host's own overlay layer** (`host.contribute.overlay`, the
mechanism the type overlay already uses; no contract change). While `state().selection` has an
area and the frame's fit is known it draws, in page space and at screen size (the camera's
scale is divided out), a bar under the selection: a prompt field, Generative fill, Remove and
Select subject. The buttons call the controller the commands of the same names call
(`session.ml()`), so the model lookup, the single undo step and the refusal text are the
commands'. A fill with no prompt raises the Image panel, as the command does. With no selection,
no image or no overlay layer (headless) nothing renders. The bar stops pointer and key events
from reaching the canvas.

**Face-aware Liquify is a mode of the existing dialog, not a second tool.** When
`openWarpDialog("liquify")` opens, it asks `ml.landmarks` for the open image's faces (through the
live `session.ml()`, so a model installed later is honoured) and stores them in the dialog's
`faces` list: per face the box and five points (eyes, nose tip, mouth corners), as fractions of
the image like every other Liquify geometry. A 68-point answer is reduced to those five; any
other count is not read. Six sliders (eye size, nose size, smile, face width, chin, forehead,
-100 to 100) are ordinary parameters; at run time `liquifyFaceStrokes` turns them into Liquify
strokes (bloat or pucker at the eyes and nose, forward warps at the mouth corners, cheeks, chin
and forehead) which ride after the hand-made strokes in the one `applyLiquify` pass. So the
preview, the proxy pass, Reset, Cancel and the one undo step are the dialog's own, and no
landmark is stored in the document. The strokes are geometry derived from the landmarks, not
Photoshop's face mesh: the amounts are tuned by eye and no Photoshop oracle was recorded.
The `facesStatus` value says whether detection is running, found faces, found none or had no
model; with no model the dialog shows a hint, the status line says so, and the sliders do
nothing while brush strokes work as before. Nothing is downloaded or bundled.

**Reference images for Generative Fill come from the Links panel's rows.** `ml.edit` already takes
up to ten `references`. The Image panel's ML section lists the rows the Links binding provider
serves (smart objects with a file) as checkboxes (`referenceCandidates`), at most ten; the picked
layer ids are kept in `state().ml.references` and `generativeFill` sends each layer's own pixels,
fitted to the model's size, as the references (a layer that has gone is skipped). The other
features do not send them. The panel's picker is the only way in: the Links panel's own toolbar
has no action slot for this (a new action would be a contract change), and a payload
`references: [layerId]` on the `generativeFill` command reaches the same option.

## Consequences

- `MlUiState` gains `references`; `FilterDef` Liquify gains seven values (the sliders and
  `faces`, `facesStatus`), saved with `lastFilterValues` like the rest, but the dialog resets
  them on open.
- Tests: `test/ml-followups.spec.ts` (the SDK `fakeMlProvider`: one face in the centre third, five
  points), `test/ml-taskbar.dom.test.tsx`, `test/ml-section.dom.test.tsx`.

## Amendment — 2026-11-18: the task bar is the image context's

The session keeps the image and its selection after the `rasterImage` context closes (the Image
panel and scripts still read them), and the bar drew whenever a selection existed. So after
Commit and Escape it stayed on the page, at screen size, under where the selection was: the
next frame drag landed on its prompt (it stops pointer events, so nothing was drawn and the
prompt took focus) and every key after that went into the field. The decision changes as
follows; everything else stands.

- **The bar draws only while the context is open on the image's frame.** The context's
  `onEnter` names the frame and `onExit` clears it (`makeTaskBarOverlay`'s `setEnteredFrame`);
  the bar needs that frame to be the session's source, a selection with an area and the fit.
  Every way out of the context (Escape, a commit, a press outside, another tool; editor
  [ADR 1214](../../../../apps/editor/docs/adr/1214-one-way-out-of-a-context.md)) runs `onExit`,
  so each takes the bar with it. The selection itself is kept as before.
- **Focus inside the bar goes back to the canvas when the bar goes** (editor
  [ADR 1206](../../../../apps/editor/docs/adr/1206-focus-returns-to-the-opener.md)): to the
  focusable surface the overlay layer sits in, the canvas viewport, never to the page. The bar's
  root ref does it as it is removed.
- **Escape in the prompt is the field's rung of the ladder** (editor
  [ADR 1207](../../../../apps/editor/docs/adr/1207-one-escape.md)). The arbiter defers a focused
  field's keys, so the press used to do nothing at all. It now hands focus back to the canvas
  and the context stays; the next Escape leaves the context and the bar goes with it. Every other
  key stays the field's.

Tests: `test/ml-taskbar.dom.test.tsx` (the context gate, the hand-back, the prompt's Escape) and
the journey `apps/editor/apps/canvas/tests/journey/plugins/image-taskbar.journey.spec.ts` (enter,
select, Escape in the prompt, commit, Escape, and a frame drawn where the bar was). The image
film no longer deselects before it leaves the context.
