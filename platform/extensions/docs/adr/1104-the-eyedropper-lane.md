# ADR 1104 — The host Eyedropper's target: the binding provider's eyedropper lane

- **Status:** Accepted 2026-11-11.
- **Scope:** `BindingProviderScope.eyedropper`, `BindingProvider.takeEyedropperSample`,
  `BindingEyedropperRequest`, `BindingEyedropperRead` and `BindingEyedropperResult` in
  `packages/plugin-api/src/binding-provider.ts`; the registry's `takeEyedropperSample` and the flag
  `bindings.eyedropper@1` in `packages/plugin-sdk/src/host-impl.ts`. The editor half is the host
  Eyedropper (`apps/editor/packages/tools/src/handlers/eyedropper-tool.ts`) and the
  `PagedEditor.bindingProviders` handle it reads. Amends [ADR 340](340-the-workspace-and-readout-lanes.md).

## Context

There were two eyedroppers: the host's (`paged.tool.eyedropper`, every context; it samples the
rendered page and writes a swatch, the document default fill and the selection's fill) and
paged.image's (`media.paged.image.tool.eyedropper`, inside a raster image; it samples the image's
own layers at Photoshop's sample sizes into the foreground, Alt the background). The capability is
one (pick a colour off what is under the pointer); what differs is where the colour goes and what
the pixels are. paged.image already answers the host's colour panels through its binding provider
(the fill and stroke wells are its foreground and background), so the target exists; the host
tool had no way to hand it a sample.

## Decision

- **One tool, a target lane.** A binding provider may declare `provides.eyedropper` and implement
  `takeEyedropperSample({ pageId, point, sampleSize, secondary })`. While its context is active,
  a Pixel-mode press of the host Eyedropper goes to the innermost such provider first: it samples
  its own content (`sampleSize` the tool's option: 1, 3, 5, 11, 31, 51 or 101, a point or an N×N
  average; `secondary` is Alt) and answers `{ kind: "taken", rgb }`, or declines. A drag keeps
  sampling into the same target, as in Photoshop. Taking a colour is tool state, not a document
  edit: the host writes nothing.
- **A decline is the page.** A provider that declines (the point is not its content) leaves the
  click to the host's own sample of the rendered page, which writes as before. Object mode never
  asks a provider.
- **The sample size is the host tool's.** The Eyedropper has a `sampleSize` option; the page
  sample averages the snapshot window with the same arithmetic paged.image averages its layers
  with (`@paged-media/helpers` `sampleWindow` / `averageRgba8`, premultiplied).
- **paged.image is the first provider.** Its colour provider declares the lane: the point maps into
  the image, an armed Curves eyedropper takes the click first, and `sampleColor` reads the active
  layer or every visible one (the colour section's Sample choice) into the foreground or, for the
  secondary target, the background. Its own Eyedropper tool, gesture and the tool options are
  gone (the id leaves through the deprecation window, replaced by the host's); the Color Sampler,
  Ruler, Count and Note join the host Eyedropper's flyout.
- **The host reaches the registry through `PagedEditor.bindingProviders`** (optional; null when
  the editor wired none), the same shared registry the panels read.

## Consequences

- One Eyedropper in every context; inside an image it takes the image's colours at the image's
  resolution, elsewhere it samples the page.
- Probe `supports("bindings.eyedropper@1")`; true with a shared registry. Contract canary
  `0.74.3-canary.86`.
- Not carried over: paged.image's Eyedropper had no key (the host's has `i`), so nothing is lost
  there; a press that an armed Curves eyedropper took is answered as taken, so a drag after it
  samples into the foreground.
