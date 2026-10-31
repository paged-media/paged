# ADR 1032 — One colour API with explicit intents and black-point compensation on every backend

- **Status:** Accepted 2026-10-24.
- **Scope:** no wire change (protocol unchanged; `ImageMetadata.rendering_intent` is an additive
  `serde(default)` field). `paged-color` (new module `cms`, feature `moxcms`), `paged-raster`
  (`PagedColour` carries a rendering), `paged-renderer` (`pipeline/images.rs`,
  `image_decode.rs`, `image_convert.rs`), `paged-compose` (`DecodedImage.rendering`),
  `paged-gpu` (the wasm32 raster-time decode), `idml-import`/`idml-export`
  (`ImageRenderingIntent`). The image module's `image-cms` becomes an adapter over it (image
  ADR 457, amendment of 2026-10-24). Follows PM-0014 ("`paged-color` gains the `image-cms`
  backends rather than a second colour crate"); amends [ADR 003](003-lcms2-color.md) and
  [ADR 1005](1005-a-raster-is-read-by-paged-raster.md).

## Context

The engine converted colour through lcms2 on native and qcms on wasm32 (ADR 003), with the
intent and BPC a per-document setting that reached the paint transform only. The image module
wrapped qcms and moxcms itself (`image-cms`, image ADR 457): two colour stacks in one
repository. moxcms honours all four ICC intents but has no black-point compensation, so the
image module approximated Photoshop's default view of a CMYK document (relative colorimetric
with BPC) through the perceptual table; qcms has neither BPC nor a PCS endpoint. A placed CMYK
raster always converted relative colorimetric with BPC on native and perceptual (qcms) on
wasm32, whatever the frame's `ImageRenderingIntent` said.

## Decision

**One API, three backends.** `paged_color::cms::Transform` converts between two profiles
(ICC bytes or the built-in sRGB, Lab D50 and gray) with an explicit `Rendering` (intent and
BPC) on `Backend::Lcms2` (native), `Backend::Qcms` (every target) or `Backend::Moxcms` (every
target, feature `moxcms`). Layouts name the space and alpha (Gray, RGB, CMYK, Lab); 8-bit and
float. A backend refuses what it cannot do instead of ignoring it: qcms has no Lab end and no
BPC, so a BPC request on qcms is an error. `Backend::preferred()` is lcms2 on native and
moxcms on wasm32.

**BPC is Adobe's published algorithm where the backend lacks it.** Black points are detected
from the profiles (the source and destination methods of "Adobe Systems' Implementation of
Black Point Compensation", 2006, standardised as ISO 18619) and the PCS is scaled in XYZ
between two backend legs (device → XYZ → device). moxcms reaches the PCS through a proxy
profile (identity colorants, the CIE L\* curve) because its Lab and XYZ endpoints are not
usable. lcms2 keeps its own BPC; it is the oracle (`paged-color/tests/cms.rs`: the detection
within ΔE 0.5 of lcms2's on lcms2's legs and 1–2 on moxcms's; the software BPC on lcms2's
legs within 2 levels of lcms2's own). BPC applies between device profiles under perceptual,
relative colorimetric and saturation; absolute colorimetric never compensates; a v4
destination under perceptual or saturation compensates whether asked or not (ICC v4's
reference medium black; lcms2 does the same).

**Soft proof and gamut check** are two compositions over the API: `SoftProof` (source →
output under the proof's rendering, then output → display relative colorimetric with BPC, or
without it for "simulate black ink", or absolute for "simulate paper"), and `GamutCheck` (a
pixel is out of gamut when its colorimetric round trip through the output profile moves it by
more than a ΔE\*ab threshold).

**A placed raster converts with its frame's intent.** `ImageRenderingIntent` is read into
`ImageMetadata.rendering_intent` and written back. The renderer converts a placed CMYK TIFF
(and the streamed CMYK JPEG) with the frame's intent when it names one, else the document's
Color Settings intent, and the document's BPC. The wasm32 lazy decode carries the rendering on
`DecodedImage.rendering` to paged-gpu's raster-time decode. A picture decoded under a
non-default rendering is cached under a suffixed key, so a Color Settings change never serves a
stale conversion and every default-keyed lookup is unchanged.

## Consequences

- A native render with the default settings is bit-identical to before (the lcms2 leg is built
  as `IccTransform` built it; `the_default_cmyk_transform_is_the_renderers`).
- On wasm32 a placed CMYK TIFF now converts through moxcms with relative colorimetric and BPC
  instead of qcms perceptual: it moves toward the native render (moxcms vs lcms2 on Coated
  FOGRA39: within 3 levels without BPC, 9 with it; absolute colorimetric 16, where moxcms
  adapts the media white differently).
- The paint path (`IccTransform`, `IccCmm`) is unchanged: lcms2 native, qcms wasm32.
- The image module's CMYK ingest converts with real relative colorimetric and BPC, the view
  Photoshop shows; both lanes are the engine's code.
- The renderer's per-frame intent applies to CMYK rasters; an RGB or gray raster's embedded
  profile is still not applied by the renderer.
