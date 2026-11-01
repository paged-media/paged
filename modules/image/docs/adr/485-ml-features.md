# ADR 485 — ML features: Select Subject, Object Selection, matting, live Remove

- **Status:** Accepted, 2026-11-01 (WP8.2: Tier A, Tier B, the neural filters and the panel section;
  the contextual task bar, face-aware Liquify and reference-image edits are not part of it).
- **Scope:** `glue/src/ml-features.ts` (the controller, `session.ml()`), `ml-contrib.ts`
  (commands and the Object Selection tool), `ml-engine.ts` and `image-js/src/ml_doors.rs`
  (`ml_select` and the generated-pixels doors), `ml-section.tsx` (the Generate and Neural Filters section), `retouch.ts` (the Remove tool's provider
  lookup), `masking-session.ts` (the matting hook), the Select menu's rows, the manifest's
  `capabilities.ml`.

## Context

The host carries seven ML doors (`host.ml`, extensions ADR 1100): segment, matting, inpaint,
superres, landmarks, generate and edit. Small models answer in the editor's ML worker (Tier A);
the generative host answers generate and edit (Tier B). This module had two empty hooks waiting
for them: Select and Mask's `MattingProvider` and the Remove tool's `InpaintProvider`.

## Decision

**No model is in this bundle.** The module asks the door and shows the registry's own refusal
("local image model not running", "no model installed") in the status line; it never installs,
downloads or names a model file. The manifest declares `capabilities.ml` with all seven abilities.

**One controller, looked up live.** `session.ml()` calls `host.ml` on every use, so a model
installed, stopped or removed after the bundle loaded is honoured. The Remove tool's lookup was
resolved once at start; it now resolves per stroke (an explicit `setInpaintProvider` still
wins). The matting provider is given to Select and Mask once and asks `ml.matting` per call; the
answer is blended into the trimap's unknown band only, so the known foreground and background
stay as drawn, and with no model the classical colour solve stays in charge (the panel keeps its
"no matting model" hint through `MattingProvider.available`).

**A model's mask is an ordinary selection.** Select Subject (`ml.segment` with no prompt),
Select Sky (positive points along the top edge) and the Object Selection tool (a box drag or a
click; Shift adds, Alt subtracts) land through `ml_select`, ONE undo step labelled with the
feature, not through the unrecorded `selection_set_coverage`. The tool shares the quick-select
slot of the toolbox.

**Tests use the SDK's fake provider or a scripted one on the real registry.** Nothing downloads.
The generative model family stays out of the bundle and out of any automatic download.

**Tier B lands as ordinary layers.** Generative Fill crops the selection's box with context
(half its larger side, at least 32 px), shrinks it so the long side is at most 1024 px and both
sides are multiples of 8 between 64 and 4096 (the generative host's sizes), asks `ml.edit` with
the selection as the mask, enlarges the answer back and adds it as a pixel layer masked by the
selection (`ml_layer_add`). Generative Expand grows the canvas and adds the masked border layer
in one step (`ml_expand`). Remove asks Tier B `ml.edit` first, then Tier A `ml.inpaint`, then the
classical content-aware fill, and lands the pixels inside the hole only (`ml_land_hole`). Remove
Background takes `ml.matting` (else `ml.segment`) as the active layer's mask (`ml_layer_mask`).
Generate Image adds the result fitted into the canvas; with several variations the results wait
in the panel's strip and Place lands one. Sky Replacement, Colorize and Skin Smoothing are prompt
presets over the same fill (the faces `ml.landmarks` finds, as ellipses, at strength 0.35).
Super Zoom and JPEG Artifact Removal use `ml.superres` and add a layer. Every one is ONE undo
step and an ordinary pixel layer, saved with the document in parts like any other.

**Prompts.** The three prompt-driven commands (`generateImage`, `generativeFill`,
`generativeExpand`) take the prompt, seed, steps and sizes from the command payload, so a script
or a template run can use them; a menu click carries none and raises the Image panel, whose ML
section holds the prompt, seed, steps, variations and the strip. The commands are not the
`paged.ml.generate` / `paged.ml.edit` ones the SDK registers.

**Not here.** The contextual task bar over a selection, face-aware Liquify and reference-image
edits (the Links panel) are follow-ups.

**Amended 2026-11-01:** the task bar, face-aware Liquify and reference-image edits are in
[ADR 486](486-ml-followups.md).
