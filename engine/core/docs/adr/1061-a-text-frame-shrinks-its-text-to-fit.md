# ADR 1061 — A text frame shrinks its text to fit

- **Status:** Accepted 2026-11-09; built. Closes the autofit gap slide
  [ADR 724](../../../../modules/slide/docs/adr/724-autofit-and-chart-data-reach-audit.md) recorded.
  Part of the capability layering of PM-0014 and PM-0017
  ([capability register](../../../../docs/development/capability-register.md), slide reach).
- **Scope:** `paged-model` (`text_fit::ShrinkToFit`, `TextFrame::shrink_to_fit`), `paged-renderer`
  (`pipeline/text_fit.rs`, `auto_size::Measurer::fit_shrink`, the emitter's run attributes,
  `first_baseline_for_frame`, `equations::set_equations`), `slide-resolve`, `slide-native`,
  `pptx-export`.

## Context

PowerPoint's `a:normAutofit` sets a body's text smaller when it does not fit: `fontScale` scales
every run's size and `lnSpcReduction` takes a share of the line spacing away. PowerPoint stores the
values it last computed and draws them when it opens the file; it computes them again when the text
is edited. `slide-resolve` multiplied every run's size and the line spacing by the stored values, so
the engine's model held the shrunk sizes and nothing could shrink again: an edit in the editor
oversets (or, with slide's height auto-sizing, grows the frame) where PowerPoint shrinks. The
engine had frame growth (`AutoSizingType`, InDesign's auto-sizing, measured in `auto_size.rs`) and
no shrink. `a:spAutoFit` is growth and already lowers onto `AutoSizingType::HeightOnly`.

## Decision

- **The model holds the written text and the fit to start from.** `TextFrame::shrink_to_fit:
  Option<ShrinkToFit { font_scale, line_spacing_reduction }>`, `serde(default)` and skipped when
  unset, so a frame without one keeps its bytes and state hash. The story keeps the sizes it was
  written in; the frame names the fit the authoring application saved.
- **The renderer decides the fit before layout, with the auto-size fits.** `fit_shrink` composes
  the frame's story into a scratch page at the frame's own size, through the same trial the
  auto-size fits use: at the saved fit while the text fits there, else at the first of
  `SHRINK_STEPS` below it at which it fits, else at the last step. The steps are the values
  PowerPoint writes: the line spacing reduced by 10 % and 20 %, then the size in steps of 7.5 %, to
  25 %. A frame that also auto-sizes is sized from the shrunk text. The fit goes to the layout
  clone of the frame, as the fitted bounds do.
- **What a fit changes.** Each run's resolved size times `font_scale`; an explicit leading times
  `font_scale × (1 − line_spacing_reduction)`; auto leading follows the size, and becomes an
  explicit, reduced leading when lines are reduced; the baseline shift, a list marker style's own
  size and an equation's size scale with the text; a `FixedHeight` first baseline follows the line
  pitch. Paragraph spacing, indents and tab stops keep their values. The emitter applies it where
  it reads run attributes (`StoryEmitter::run_attrs`), so every path that sizes a line sees the same
  numbers; a threaded story is not fitted.
- **The fit never goes above the saved one.** PowerPoint draws the stored values on open; the
  engine keeps them while the text fits, so a deck that fits looks as saved. Text that no longer
  fits after an edit shrinks further. Text that is removed does not grow back past the saved fit
  (a writer that sets the fit to none lets it).
- **Off the wire.** No mutation path or catalog row: the field is set by importers and carried
  through the document, like the text warp of ADR 1091. Script and panel editing of the fit is a
  later amendment with its own resync.
- **slide** lowers `normAutofit` onto the field and stops scaling runs (`slide-resolve` keeps
  `shrink` as read); a percentage line spacing in a frame whose saved fit reduces lines is written
  out as an explicit 100 %, so the engine reduces it and the first baseline follows, exactly as
  the baked values did. `pptx-export` writes sizes as they are and the fit back as
  `a:normAutofit` when it changed (a new text box with a fit gets one instead of `a:spAutoFit`); an
  unchanged deck keeps its own bytes and an edited body its stored `fontScale` / `lnSpcReduction`.

## Consequences

- The PowerPoint fixtures lay out as before: the shrunk body of `text.pptx` (40 %, 20 %) fits at
  its saved fit and draws the same sizes and pitch the baked values gave. A body PowerPoint saved
  as fitting (`<a:normAutofit/>`) that oversets with the engine's fonts now shrinks instead of
  growing its frame.
- Differences from the baked values, where no fixture has the case: a point line spacing
  (`spcPts`) and run tracking now shrink with the text; a percentage paragraph spacing no longer
  does.
- InDesign and IDML have no shrink-to-fit; IDML export writes the frame without it (the text at its
  written sizes).

## Related

- [ADR 1091](1091-a-text-warp-is-an-envelope-over-the-outlines.md): the other text-frame field set
  by importers and kept off the wire.
- Slide [ADR 724](../../../../modules/slide/docs/adr/724-autofit-and-chart-data-reach-audit.md):
  the audit this closes for autofit.
