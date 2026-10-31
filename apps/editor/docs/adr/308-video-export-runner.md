# ADR 308 — Video export runner

- **Status:** Accepted 2026-10-28.
- **Scope:** the slide bundle's `output/video/` (`runner.ts`, `timeline.ts`, `mp4.ts`),
  `show/offline.ts` and `output/export-view.tsx`; the journey
  `apps/canvas/tests/journey/plugins/slide-video-export.journey.spec.ts`. The module half is
  slide ADR 720; builds on ADRs 304–306 (presentations and module views) and slide ADR 721
  (WGSL transitions).

## Context

PowerPoint's File ▸ Export ▸ Create a Video renders the slide show into an MP4. In the editor the
show runs on the editor's own WebGPU adapter and the engine's page layers, in the bundle's realm.
A video needs the same pictures at a fixed frame rate, encoded and muxed, without freezing the
editor and with a way to stop.

## Decision

- **The runner lives in the bundle, on doors the editor already gives.** Frames come from
  `host.render.layers`, transitions from the bundle's shader library on a WebGPU device it asks
  the browser for, the file goes out through `host.shell.saveFile`. The editor adds no door: a
  module that can present can make a video.
- **Off the clock, not off the thread.** The runner draws each frame offline (an
  `OffscreenCanvas`) and hands it to WebCodecs' `VideoEncoder`, which encodes off the main thread.
  It waits for the encoder's queue to drain before the next frame and yields to the event loop
  every few frames, so the editor keeps painting and the progress bar moves. A worker would need
  the page layers and the GPU device across a realm boundary the contract does not cross today.
- **Codec.** H.264 (High profile, the level the size and rate need) where the browser encodes
  it, else VP9; both in MP4. The muxer is the bundle's own (slide ADR 720).
- **Progress and Cancel.** File ▸ Export… shows the module's Export view in place of the canvas
  (ADR 306); the video's progress bar counts frames and Cancel stops between two frames. The
  typed command `media.paged.slide.exportVideo` runs the same runner for scripts.
- **Tested in Chromium.** The journey makes a three-slide video at 720p, 24 fps, opens it in a
  `<video>` element and checks the duration it reports against the runner's, and that a frame
  decodes.

## Consequences

- A host without WebCodecs cannot make videos; the export says so.
- The video's speed is the browser's encoder's: hardware H.264 on most machines.
- Moving the runner into a worker is open; it needs page layers and a GPU device in a worker.
