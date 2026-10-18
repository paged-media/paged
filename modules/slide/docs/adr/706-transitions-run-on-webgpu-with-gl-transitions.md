# ADR 706 — Slide transitions run on WebGPU, using the gl-transitions shader collection

- **Status:** Accepted 2026-10-05.
- **Scope:** the slideshow stage (`packages/slide-bundle`), `vendor/gl-transitions`, the transition
  mapping in `slide-js`

## Context

The slideshow draws each slide (and each build step) from an engine snapshot, so a transition is
a function of two images and a progress value. PowerPoint offers several dozen transitions; a
hand-written 2D-canvas animation per kind would cover fade, push and wipe and little else.

[gl-transitions](https://github.com/gl-transitions/gl-transitions) is a collection of 125
transitions written against exactly that contract: a fragment shader receives
`getFromColor(uv)`, `getToColor(uv)`, `progress` and `ratio`, plus typed parameters with
defaults. The collection is MIT-licensed; each file carries its own author and licence header
(two files are BSD-2 and BSD-3).

The engine already renders on WebGPU, so the browser in which the slideshow runs has a WebGPU
device.

## Decision

1. **Transitions run on WebGPU.** The stage panel uploads the outgoing and incoming snapshots as
   textures (`copyExternalImageToTexture`) and draws one full-screen pass per frame with the
   transition's fragment shader. Progress follows the PowerPoint duration (`p:transition` `dur`,
   or `spd` mapped to 0.5 / 0.75 / 1.0 s).
2. **The shaders come from gl-transitions, vendored** at `vendor/gl-transitions/` at a pinned
   commit, with every file's own header kept and a `SYNCED` stamp, as for `paged-ooxml`
   (ADR 701). Each transition is translated from GLSL to WGSL once, when the bundle is built,
   with naga. The vendored GLSL is wrapped in a fixed prelude that defines `getFromColor`,
   `getToColor`, `progress`, `ratio` and the declared parameters. A transition that does not
   translate is left out of the build with a listed reason. It is never patched in place.
3. **PPTX kinds map to gl-transitions by a table in `slide-js`**: kind, direction and options
   map to a shader name plus parameter values. Examples: `fade` → `fade`; `fade thruBlk` →
   `fadecolor` (black); `push` (l/r/u/d) → `Directional` with a direction vector; `wipe` →
   `wipeLeft` / `wipeRight` / `wipeUp` / `wipeDown`; `split` → `HorizontalOpen` /
   `VerticalOpen`; `circle` → `circleopen`; `dissolve` → `dissolve`; `cut` → no pass. A kind with
   no mapping plays `fade`. Its original XML is still kept for export (ADR 703, ADR 704).
4. **The full collection is also offered for native use.** A slide's transition can be any
   gl-transitions shader with parameters, stored in page metadata as
   `{shader, params, durationMs}`. On PPTX export, a shader that maps back to a PowerPoint kind
   is written as that kind. Any other shader is written as `fade`, with a diagnostic.
5. **Without WebGPU, the stage cross-fades two 2D canvases.** This also applies when the device
   is lost.

## Consequences

- Fade, push and wipe, the basic set from the plan, are three shaders in a general mechanism, not
  three special cases.
- The bundle carries WGSL generated from third-party GLSL. The licence notices travel with the
  vendored sources and are listed in the bundle's third-party notices.
- Build steps (appear, fade) use the same pipeline: a fade build is `fade` between the frames of
  steps k−1 and k.
- Conformance does not compare transitions with PowerPoint pixel for pixel. Tests check the
  mapping table, that every vendored shader translates (or is listed as excluded), and that
  progress 0 and 1 reproduce the outgoing and incoming frames exactly.
