# ADR 1093 — A line stops inside its line ends

- **Status:** Accepted 2026-11-09; built.
- **Scope:** `paged-geom` (`trim`: an open run of anchors shortened along its curve), `paged-renderer`
  (`pipeline/shapes.rs`: `arrowhead_inset`, `stroke_under_line_ends`; the stroke of a `<GraphicLine>`
  and of a pen path's open contours), paged.doc's Office heads (doc ADR 629, amendment 1).
- **Builds on:** RFI C-62 (a pen path's line ends, the `line-ends` fixture), ADR 148 (dash fitting on
  the same fixture).

## Context

The engine drew a line end (`LeftLineEnd` / `RightLineEnd`, and the DrawingML `a:headEnd` /
`a:tailEnd` that `dml-native` maps onto them for paged.slide) over a stroke that ran on to the line's
last anchor. InDesign, Word and PowerPoint all stop the stroke inside the head instead. Where the
head is narrower than the line near its tip, a stroke that runs to the end shows its corners beside
the tip; a round or projecting cap pokes out past it; a translucent line darkens where it overlaps
its head; and a hollow head (a circle or square ring) shows the line inside it. The `line-ends`
threshold recorded the difference as named residue ("InDesign trims the stroke under the head").

InDesign 20.0.1's export of `line-ends` (3 pt and 8 pt lines, heads at 50, 100 and 150 %) shows where
it stops the stroke, measured from the line's end along the line:

| Head                        | InDesign stops the stroke                                   |
| --------------------------- | ----------------------------------------------------------- |
| triangle (and the wide one) | about 0.6 of the head's length back (8.39 of 13.89 at 3 pt) |
| barbed                      | at its notch (the same 8.39 at 3 pt)                        |
| simple / simple-wide        | where its two strokes meet (2.2 pt back at 3 pt)            |
| solid circle                | at its centre                                               |
| hollow square, hollow circle | at its far side, so no line shows inside it                |

The cap does not move the cut: a round-capped 3 pt line stops exactly where a butt-capped one does.

## Decision

- **One kernel.** `paged_geom::trim::trim_run(run, start, end)` shortens an open run of path anchors
  by `start` pt at its first anchor and `end` pt at its last, measured along the curve (kurbo arc
  length, 1e-3 pt); a cut segment is split, not re-fitted, so a curve keeps its shape. It answers
  `None` when the two cuts take the whole run. The renderer uses it for the engine's line ends, and
  paged.doc for the Office heads it draws itself (doc ADR 629, amendment 1).
- **The engine's heads.** `arrowhead_inset` gives the cut for each head the renderer draws, in its own
  geometry (a head `4 x weight x scale` long): `0.6` of the length under a triangle, a barbed head
  (its notch is at `0.6`) and the simple heads the engine draws filled, at least the weight plus a
  round or projecting cap's reach but never past the head's base; the centre of a solid circle or
  square; the far side of a hollow one, plus the cap's reach so a cap does not show inside the ring;
  nothing under a bar.
- **Which ends.** A `<GraphicLine>` is cut at its first and its last anchor, where its two heads sit;
  a pen path's every open contour at both of its ends (C-62: InDesign draws line ends on each); a
  closed contour never. A contour shorter than its two cuts is not stroked. The heads stay where they
  were, on the line's own end anchors and along its own end tangents; the fill of an open pen path
  keeps the whole outline (only the stroke is cut). Inside or outside stroke alignment offsets only
  closed contours, so it is computed from the cut outline unchanged.
- **One rule for every source.** InDesign stops the stroke too, so the cut is not a per-end property:
  IDML, paged.slide (DrawingML heads mapped onto the engine's by `dml-native`) and anything else that
  sets the engine's line ends get it. The amount follows the engine's head geometry, which is
  InDesign-shaped; Office's own sizes are not modelled (below).

## Not done

- The engine's heads are not InDesign's exact shapes: InDesign's triangle is 13.89 pt long on a 3 pt
  line and 26.94 pt on an 8 pt one (the engine: 12 and 32), its simple heads are open strokes, and its
  circle sits a little closer to the end. The cut follows the engine's heads.
- DrawingML's head sizes (`w`, `len`: `sm`, `med`, `lg`) are not on the engine's model, so paged.slide
  draws PowerPoint's heads in InDesign's proportions; paged.doc draws Office's heads itself (doc ADR
  629) and cuts its line with the same kernel. One Office head geometry for doc, slide and sheet (sheet
  draws no heads yet) is open: the engine model would need a per-end Office head, or `dml-geom` the
  heads as paths.

## Evidence

- `line-ends` (corpus/generated, InDesign 20.0.1): page mean ΔE 0.155 → 0.137, ink ΔE 3.79 → 3.37,
  SSIM 0.9953 → 0.9959; the thresholds are re-sized from it.
- `paged-geom` `trim` tests (straight, across segments, a quarter circle that stays on its circle, cuts
  that meet); `paged-renderer` `pipeline::shapes::tests` (the cut per head, a line cut at its two ends
  only, a pen path at each open contour, a closed contour never).

## Amendment (2026-11-11): Office's heads have one owner

Office's head geometry (the `sm` / `med` / `lg` sizes, the 2 pt sizing minimum, the `stealth`
notch, the `arrow`'s two strokes, the inset of the stroke under each head) moved from paged.doc's
`docx-lower` to `platform/shared/dml-geom` (`dml_geom::heads`), the DrawingML geometry crate the
three Office modules share; doc draws its heads through it unchanged. Still open: paged.sheet
draws no heads (its page shapes carry one paint per shape, a head needs the line's), and
paged.slide maps DrawingML heads onto the engine's InDesign-shaped ends. Both wait on a per-end
Office head in the engine model, whose geometry would move from `dml_geom::heads` into an engine
crate on the same terms as ADR 1096's preset programs.
