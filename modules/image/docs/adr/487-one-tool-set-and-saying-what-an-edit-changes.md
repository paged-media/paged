# ADR 487 — One tool set; saying what an edit changes; a before/after split, draft and progress for filters; the pixels at 100 %

- **Status:** Accepted 2026-11-14.
- **Scope:** `glue/src/edit-kind.ts` (the four kinds of edit and their words),
  `panels/sections/edit-kind-badge.tsx` (the layer row's badge, the "Editing: …" chip),
  `panels/edit-kind-group.tsx` (the raster context's control-bar group), `activate.ts` (its
  registration), `panels/image-panel.tsx` (the badge in the layer rows, the pixel view, the split),
  `filter-split.ts` (the split's composite and its line), `session.ts` (`FilterDialogState.split`
  and `.quality`, `setFilterSplit`, `readPixels`), `panels/sections/filter-dialog.tsx` (the split
  control, the quality line), `panels/sections/pixel-view.tsx`; and the host's context toolbar
  (`apps/editor/packages/shell/src/chrome/ContextToolbar.tsx`, `ToolOptionsPopover.tsx`'s
  `ToolOptionsInline`), which carries the tool in hand for every module's context. Task CM5
  (image) of the editor's interaction plan; the UX strategy's §7.2; UX audit F-43. Builds on
  [ADR 475](475-the-image-workspace.md) (the rail's flyouts), editor ADRs 1214 and 1215 (Frame ·
  Content · Edit) and extensions ADR 1106. No contract change.

## Context

Inside the raster context the rail showed fifteen tool slots and the context toolbar about forty
more tool icons — every id of the context's `toolIds`, unlabelled, partly the same tools (F-43):
two tool sets. Four kinds of edit looked alike: a brush or a filter on a pixel layer rewrites
pixels, an adjustment / fill / type layer or a smart filter changes nothing underneath, painting a
mask changes where a layer shows, and the Content level of a picture frame moves the picture
inside its frame without touching the image. Before/after in the filter dialog was a toggle; the
dialog previewed a reduced copy while a slider moved and the full image after, without saying
which the frame showed or that the full pass was still running. The canvas shows a placed picture
at the layout's size, never at its own pixels.

## Decision

1. **One tool set: the rail.** A context's tools are picked in the tool rail, which the context
   already restricts to them (its flyouts per ADR 475). The context toolbar no longer repeats them
   as pills; it names the **tool in hand** — its icon and title — and carries **its options**
   inline (the same fields the rail's double-click popover shows, `ToolOptionsInline`), then the
   context's own control-bar groups. A context that declares no tools still says so. This is the
   host's rule for every module's context, since every context's toolbar had the same double.
2. **What an edit changes is said where it is made.** Each layer row carries a badge of its kind —
   Pixels (a solid chip) or Adjustment, Smart object, Fill, Type (dashed: non-destructive) — whose
   tooltip says what an edit there does. The raster context's control-bar group reads "Editing:
   Pixels", "Editing: Mask · non-destructive" (the mask is the edit target) or "Editing: Adjustment
   · non-destructive" (an adjustment, smart, fill or type layer is active), following the session.
   The host's Content level of a picture frame shows "Placement · non-destructive": moving,
   scaling or rotating the picture there never changes its pixels.
3. **A before/after split.** The filter dialog's Split view shows the frame with the image as it
   was left of a line and with the filter right of it; a slider moves the line, which is drawn over
   the frame on an overlay layer with the two halves named. Both halves are what the frame shows
   (the display adjustments applied) at the preview's resolution: the "before" is the reduced copy
   taken when the dialog opened (or the image read once with the preview step taken out), the
   "after" the newest preview — the draft, then the full pass read back. The split is a view: OK
   keeps the filter as one undo step as before and puts the whole result back in the frame; Cancel
   puts the image back. The Before toggle stays.
4. **Draft and progress.** The dialog says what the frame shows: a draft (the reduced copy, while
   the values move), "Rendering at full resolution…" with an indeterminate bar while the
   full-resolution pass runs, then "Full resolution". The engine reports no progress for a pass, so
   no percentage is invented.
5. **The pixels at 100 %.** The Image panel's "Pixels at 100 %" section shows the image's own
   pixels — one image pixel to one screen pixel, or 200, 400 or 800 % with a pixel grid at 800 % —
   around the pointer while it is over the image (else where it last was), with the image's pixel
   size, the resolution the layout gives it (ppi) and the pixel under the pointer. It reads the
   composite (`readPixels`); it changes nothing. The canvas's own zoom stays the host's: a bundle
   cannot set the camera, and the panel view needs no contract change.

## Consequences

- Tests: `glue/test/edit-kind.spec.ts` (the kinds and the composite), `glue/test/image-ux.dom.test.tsx`
  (the badges, the split control and the quality line, the pixel view), and in the editor
  `tests/e2e/image-ux.spec.ts` (the one tool set and the edit-kind chip on the real engine, the
  split and the quality line asserting the model and the history) and the amended
  `tests/e2e/edit-context-chrome.spec.ts` (AC-CTXBAR-1: no second tool set; the tool in hand named).
- UX audit F-43: the two tool sets are one. The embedded picture counted in Links and the "Colour"
  spelling are not part of this record.
- A module whose tools the rail cannot show would have no way to pick them from the bar; every
  built-in context's tools are rail tools.
