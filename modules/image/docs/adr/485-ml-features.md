# ADR 485 — ML features: Select Subject, Object Selection, matting, live Remove

- **Status:** Accepted, 2026-11-01 (WP8.2, first part: Tier A; the generative Tier B features
  and their panels follow in the same record).
- **Scope:** `glue/src/ml-features.ts` (the controller, `session.ml()`), `ml-contrib.ts`
  (commands and the Object Selection tool), `ml-engine.ts` and `image-js/src/ml_doors.rs`
  (`ml_select` and the generated-pixels doors), `retouch.ts` (the Remove tool's provider
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
