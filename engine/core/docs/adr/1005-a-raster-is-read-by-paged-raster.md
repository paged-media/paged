# ADR 1005 — A raster is read by `paged-raster`, and a TIFF through `tiff`

- **Status:** Accepted 2026-10-24; amended 2026-10-24 (PSD/PSB through `paged-psd`).
- **Scope:** no wire change (protocol unchanged). New crate `paged-raster`; `paged-renderer`
  (`pipeline/image_decode.rs`), `paged-gpu` (`vcpu.rs`, `vello_rs.rs`: the wasm32 raster-time
  decode), `paged-cli` (`place.rs`). The first part of the raster plan's codec matrix; the
  PSD reader, the remaining codecs, region decode and the PDF export's CMYK passthrough follow
  in later decisions.

## Context

A placed picture was decoded in three places, each with `image::load_from_memory`: the
renderer at build time, and paged-gpu's two lanes at raster time on wasm32 (the lazy path). A
TIFF went through `image`'s TIFF adapter, which converts CMYK with a naive formula and never
reads the TIFF's embedded ICC profile, refuses palette and Lab images, and exposes none of the
metadata a print workflow carries in a TIFF (XMP, IPTC, Photoshop resources, resolution,
layers). A CMYK TIFF, the most common print raster in an InDesign document, rendered in the
wrong colours.

## Decision

**One crate reads rasters.** `paged-raster` (pure Rust, `forbid(unsafe_code)`, wasm-safe)
offers `probe` (header facts: size, samples, colour model, alpha, ICC, XMP, IPTC, Photoshop
resources, the layer tag 37724, resolution, orientation, page count), `decode` (samples in the
file's own model and depth), `to_rgba8` (straight-alpha sRGB through a `ColourConvert`),
`decode_rgba8` (the call the render paths make) and `encode_tiff`.

**TIFF decodes through `tiff` 0.11**, a direct workspace dependency with the features `image`
already enabled, so the graph keeps one build. Strips and tiles, chunky and planar, 1 to 64-bit
integer and 16 to 64-bit float samples, Gray, RGB, CMYK, YCbCr, palette and Lab, associated and
unassociated alpha, every IFD, and the compressions `tiff` implements. `tiff` refuses palette
and Lab; the decoder hands it a copy whose PhotometricInterpretation says gray or RGB and does
the colour-map lookup or the L\*a\*b\* scaling itself. Anything else fails with an error that
names it (`compression old-style JPEG (6)`).

**Colour converts through paged-color.** A CMYK TIFF with an embedded profile converts with
`IccTransform::cmyk_to_linear_rgb`, the transform CMYK JPEGs already used (lcms2 native, qcms
wasm32); without one it keeps the naive formula `image` applied, so it renders as before. The
conversion is a trait so a caller with its own colour settings supplies it; the crate still
depends on paged-color, which is wasm-safe and already in every rendering tree, so both decode
sites call one function.

**Everything else is unchanged.** PNG, JPEG, WebP, GIF and BMP decode through `image` exactly
as before (`decode_rgba8` on them is `load_from_memory(..).to_rgba8()`), and the renderer's
DCT-scaled JPEG path stays where it is. A TIFF that `paged-raster` cannot read falls back to
`image`. A decoded TIFF is box-shrunk to the renderer's 4096 px cap, and the wasm32 peek reports
the shrunk size. A Lab TIFF's profile is not carried on (its pixels arrive as sRGB).

## Consequences

- A CMYK TIFF with a profile now renders in its profile's colours; one without does not move.
- Native and wasm32 decode a TIFF with the same function; the qcms/lcms2 difference of CMYK
  JPEGs applies to CMYK TIFFs too.
- Orientation is reported, not applied (the renderer never applied it), and a CMYK TIFF without
  a profile does not yet use the document's CMYK working space.
- The PDF export still embeds a TIFF as RGB pixels (its lazy path still uses `image`).

## Amendment — 2026-10-24: a PSD or PSB is read through `paged-psd`

The PSD reader of the raster plan moved into the engine (PM-0014, image ADR 466):
`crates/paged-psd` and its pixel types `crates/paged-pixel`, by `git mv` from paged.image's
`image-psd` and `image-core`, with their tests. `paged-raster` depends on it.

**Decision.** `probe` of a PSD or PSB reads `paged_psd::summary`: the header, the image
resources (ICC 1039, XMP 1060, IPTC 1028, resolution 1005, the whole resource section as the
Photoshop resources) and the layer records, without copying a channel. `decode` returns the
merged composite, the image Photoshop stores beside the layers, through the composite decode
paged.image opens a flat PSD with: RGB and Grayscale (`composite_rgba8`) and CMYK
(`composite_cmyk8`, straight ink), 8 and 16 bits (16 reduced to the high byte), RAW and RLE,
straight alpha when the layer count's sign says the composite has transparency (the white
matte undone). CMYK converts in `to_rgba8` with the file's embedded profile through the
`ColourConvert`, the conversion a CMYK TIFF takes; without a profile, the naive formula. A
Lab, indexed, bitmap, duotone, 32-bit or ZIP composite is refused by name
(`Error::Unsupported`). The renderer decodes a PSD as it decodes a TIFF (`decode_raster`,
shrunk to its 4096 px cap, the embedded profile carried on), so a placed PSD or PSB draws its
composite instead of the frame fill and the `ImageDecodeFailed` diagnostic; a composite it
cannot read keeps that outcome. paged-gpu's wasm32 raster-time decode and `paged-cli`'s
`place` probe needed no change.

**Layers.** `RasterInfo` gains `layer_count`: the layer records a PSD stores (in its layer
info, or in the `Lr16` / `Lr32` block of a 16- or 32-bit document) and those of a layered
TIFF's ImageSourceData (tag 37724; `paged_psd::image_source_data_records`). `None` marks a
TIFF whose layer data is there but not readable: Photoshop writes it little-endian in a
little-endian TIFF, which `paged-psd` does not read. The layers' pixels stay the image
module's; the engine draws the composite (a TIFF's own image, a PSD's merged composite).

**Consequences.**
- The device fallback for a profile-less CMYK PSD truncates as the TIFF one does; paged.image's
  ingest rounds, so the two differ by at most one level until the colour unification (WP1.3)
  gives both one conversion. With a profile both use the embedded profile, through different
  CMS backends (paged-color here, `image-cms` in the module).
- `idml-export`'s image sizing keeps its own two-field PSD header read; switching it to the
  probe would add `paged-raster`'s tree to a crate that has none of it.
- `paged-psd` and `paged-pixel` stay leaf crates, checked by a `cargo tree` guard in
  `core-ci.yml`.
