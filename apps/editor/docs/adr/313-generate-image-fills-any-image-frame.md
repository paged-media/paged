# ADR 313 — Generate Image fills any image frame, from the host

- **Status:** Accepted 2026-11-01.
- **Scope:** `apps/canvas/src/ml/generate-image.ts` (`generateImage`, `generateImageHandler`,
  `generationSize`), `ml/service.ts` (`MlService.generateImage`), `ml/scope.ts` (`mlServiceOf`),
  `panels/generate-image-panel.tsx` (panel `paged.generate-image`, Object ▸ Generate image…),
  `insert-commands.ts` (`paged.insert.generateImage`), `app/mount.tsx`, `cockpit-menus.ts`,
  `locales/de.json`. Work package WP8.3 of the image/draw plan. Rests on [ADR 290](290-the-ml-service.md)
  and extensions [ADR 1100](../../../../platform/extensions/docs/adr/1100-the-ml-doors.md).

## Context

The ML service (ADR 290) and the `ml.generate@1` door exist, and the image module uses them on its
own pixels. A document, a deck, a sheet or a publication has image frames too, and a bundle per
module would repeat the same prompt field, size rule and placement. A frame is a page item, so the
host can do it once.

## Decision

**One host feature, not one per module.** Generate Image works on the page's frames, whatever module
made the page:

- **One graphic frame selected** (empty, or already holding a picture): the picture replaces its
  content through `replaceImageBytes`, the lane File ▸ Place uses. One mutation, one undo step.
- **Anything else selected:** a new image frame is minted on the current page, centred, 60 % of the
  page's shorter side on its long side, and filled in the SAME batch (`insertFrame`, `bindCreated`,
  `replaceImageBytes` addressed as `$h:frame`). One undo step, and a refusal leaves no empty frame.

**The model is asked first and the document is touched last.** The picture's shape is the frame's
aspect (or the panel's choice), sized by the doors' rule: long side 1024, both sides multiples of 8
within 64 to 4096. Nothing changes until the model has answered, so a refusal, a cancel or an error
changes nothing and needs no rollback.

**The words of a refusal are the registry's.** The panel shows the rejection as it came: "ml.generate@1:
local image model not running (start paged-ml-host and configure a model in Settings ▸ Models)".

**Where it is.** The panel (`paged.generate-image`, Object ▸ Generate image…) holds the prompt, a
"leave out" field, the shape, Generate and Cancel (an `AbortSignal` to the job). The command
`paged.insert.generateImage` `{ prompt, aspect?, seed?, steps? }` is the same action for a script, a
test and the command palette; it is one of the insert commands, so it is blocked inside an edit
context like they are (leave the frame first).

**The licence gate is untouched.** This feature calls the doors; it bundles, downloads and installs
no model. Qwen-Image 2.1 stays user-installed through Settings ▸ Models (ADR 290).

## Consequences

- Every module's pages get Generate Image with no bundle change. A bundle that wants it inside its own
  content (the image module's Generate panel) keeps its own.
- The service reaches the command through the scope (`mlServiceOf`) when it runs, because the commands
  and the service are set up in different effects.
- Tests: `test/panels/generate-image-panel.dom.test.tsx` (the real engine, the SDK's `fakeMlProvider`,
  one mutation or one batch and one undo, the registry's refusal, the command), and an e2e in
  `tests/e2e/ml-models.spec.ts` through the menu row with a fake local host.
- Not done: a gallery of variations (the image module's Generate panel has one); reference images
  (`ml.edit@1`) for a mockup.
