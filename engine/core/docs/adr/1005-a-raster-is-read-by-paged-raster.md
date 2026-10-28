# ADR 1005 — A raster is read by `paged-raster`, and a TIFF through `tiff`

- **Status:** Accepted 2026-10-24; amended 2026-10-24 (PSD/PSB through `paged-psd`), 2026-10-24 (EPS preview, DNG, AVIF, JPEG XL and the small formats).
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

## Amendment — 2026-10-24: the first format extensions (EPS preview, DNG, AVIF, JPEG XL, small formats)

**Decision.** `paged-raster` sniffs, probes and decodes these formats, and the render paths reach
them through the one call they already make (`decode_rgba8`, and the renderer's
`reads_through_raster`, now `paged_raster::reads_natively`):

| Format | Sniff | Decoder | Notes |
|---|---|---|---|
| EPS, DOS EPS binary | `C5 D0 D3 C6` | its TIFF section, through the TIFF reader | a metafile-only file is refused by name |
| EPS, EPSI | `%!PS` + `%%BeginPreview` | own: 1/2/4/8-bit hexadecimal gray, 0 = white | a preview-less EPS is refused (no interpreter) |
| DNG | TIFF + DNGVersion (50706) | own, over the TIFF container; lossless JPEG (`SOF3`) own | a good default develop, below |
| AVIF | `ftyp` brand `avif`/`avis` | `avif-parse` (MPL-2.0) + rav1d (BSD-2-Clause) as `sqzer-rav1d`, one thread, no assembly | feature `avif` |
| JPEG XL | `FF 0A` or the JXL container | `jxl-oxide` (MIT OR Apache-2.0), no rayon | feature `jxl` |
| OpenEXR | `76 2F 31 01` | `image` + `exr` (BSD-3-Clause) | feature `exr`; scene-linear |
| Radiance HDR | `#?RADIANCE` / `#?RGBE` | `image` | scene-linear |
| TGA | v2 footer, or a consistent header | `image` | no magic number |
| QOI, ICO | `qoif`, `00 00 01 00` | `image` | ICO: the entry `image` picks |

**EPS.** The engine has no PostScript interpreter (that is WP9.1's `paged-ps`), so an EPS draws the
preview it carries for screens. `eps_bounding_box` reads `%%HiResBoundingBox` (else
`%%BoundingBox`); the renderer places the preview over that box in points, whatever its pixel
size, as the PostScript would cover it, and `RasterInfo::resolution` states the preview's ppi
against it. A placed EPS drawn this way records `ImageDrawnFromPreview` (warning; the PDF
export's finding `image_drawn_from_preview`), and neither `ImageDecodeFailed` nor the
ghost-cross of `degraded_asset_markers`, which stays for content nothing can draw. An EPS
without a readable preview keeps the earlier outcome (frame fill, `ImageDecodeFailed`). An inline
`<EPS><Contents>` is still only flagged by the importer (its bytes are not kept), so it keeps the
`ImageContentUnrenderable` path. A placed `.ai` is a PDF and keeps drawing through hayro.

**DNG.** The raw IFD is IFD0 or a SubIFD with NewSubFileType 0 and CFA or LinearRaw. Its strips
or tiles are read uncompressed (1 to 16 bits; 8 and 16 in the file's byte order, other depths
packed MSB first) or as lossless JPEG (compression 7: Huffman, predictors 1 to 7, restart
intervals, the DNG convention of coding a CFA tile as a frame of two components). Deflate (8),
lossy JPEG (34892) and JPEG XL (52546) are refused by name. The develop is a documented
default, not a raw converter: LinearizationTable, BlackLevel (repeat pattern and deltas),
WhiteLevel, inside ActiveArea; a bilinear demosaic for any red/green/blue repeat pattern (the
mean of the nearest same-colour neighbours); white balance by AsShotNeutral, BaselineExposure;
ColorMatrix (the D65 one) to linear sRGB the way dcraw derives it; clipped, sRGB-encoded,
DefaultCrop, 16-bit RGB. Opcode lists, ForwardMatrix, camera calibration and profiles,
AnalogBalance and highlight recovery are not applied; the image module's Develop adjustment
(WP5.2) owns finer control.

**AVIF.** rav1d is the decoder the plan names, but neither its 1.1 release nor `re_rav1d` compiles
for `wasm32-unknown-unknown` (they import `libc` types that target lacks), and `avif-decode`
spawns worker threads, which panic there. `sqzer-rav1d` is rav1d's upstream main with the safe
Rust API of upstream PR 1439 and a `wasm32` shim of those `libc` names, published under rav1d's
BSD-2-Clause licence, so `paged-raster` keeps `forbid(unsafe_code)`; it is swapped for an
upstream release once one carries both. One thread, no assembly (so no `nasm` on x86 CI).
YUV converts with the stream's matrix and range (BT.601 when unspecified), chroma by
replication; the alpha item is decoded and merged (`prem` → associated). Other primaries, PQ
and HLG, and a container ICC profile are not converted. 10 and 12-bit streams arrive as 16-bit
samples.

**JPEG XL.** `jxl-oxide` renders the first keyframe with orientation applied: to sRGB when the
image is XYB or enumerated, in its own space with its ICC profile carried on otherwise. CMYK is
refused.

**Scene-linear.** `Format::is_scene_linear` (HDR, EXR): `to_rgba8` clips those floats at 1 and
sRGB-encodes them, a display-referred default without tone mapping.

**Size.** The three larger decoders are default features of `paged-raster` (`avif`, `jxl`,
`exr`), on in every build, so a build can still leave one out (it then sniffs the format and
refuses it, naming the feature). Measured on `paged-canvas-wasm` (`--features gpu`,
`wasm-release`, `wasm-bindgen`, `wasm-opt -Oz`, `brotli --best`):

| Build | `-Oz` wasm | brotli | brotli delta |
|---|---|---|---|
| before this amendment | 30,562,669 B | 6,583,108 B | |
| features off (EPS, DNG, TGA, QOI, ICO, HDR, renderer) | 30,712,755 B | 6,611,915 B | +28.1 KiB |
| default (`avif`, `jxl`, `exr` on) | 33,506,022 B | 7,310,529 B | +710.4 KiB |

The three features together cost +682 KiB brotli. Built alone into an empty `cdylib` (an upper
bound, their shared dependencies counted each time), AVIF is about 252 KiB, JPEG XL 248 KiB and
OpenEXR 80 KiB brotli.

All three together stay far below the +1 MB brotli line that would have kept them out of the
editor's wasm.

**Consequences.**
- A linked EPS with a preview draws (low resolution, and the diagnostic says so); DNG, AVIF and
  JPEG XL links render instead of the frame fill.
- `Format` grows nine variants; `RasterInfo` is unchanged. No wire change (protocol unchanged):
  the new `DiagnosticCode` is appended at the end, and diagnostics are not on the wire.
- WP9.1 (`paged-ps`) replaces the EPS preview with the artwork and keeps the preview as the
  fallback; WP9.4 owns the encoders.

## Amendment — 2026-10-25: the encoders, metadata, and `paged-raster` as the only decoder

Work package WP1.4 and the raster half of plan C5 (image ADR 468).

**Encoders.** `encode(img, EncodeFormat, &EncodeOptions)` writes PNG (Gray/RGB with or without
alpha, 8 and 16 bits; `iCCP`, `eXIf`, the XMP `iTXt`, `pHYs`), JPEG (Gray/RGB, quality; APP2 ICC,
APP1 EXIF and XMP, APP13 IPTC, JFIF density; alpha dropped), WebP (lossless only, image-webp
has no lossy encoder; `ICCP`, `EXIF`, `XMP `) and TIFF (the existing `encode_tiff`; ICC, XMP,
IPTC, Photoshop resources, resolution). EXIF is written with Orientation 1
(`exif::with_upright_orientation`). `resize`, `rgb_to_cmyk` (through `paged-color`'s export
destination with an intent and BPC, else the naive formula, reported) and `srgb_icc` prepare an
export. `paged-color` gains `IccCmm::export_rgb8_to_cmyk8`, the bulk form of its export
transform.

**Metadata.** `read_metadata` collects ICC, EXIF, XMP, IPTC and Photoshop resources from JPEG,
PNG, WebP, TIFF and PSD. `RasterInfo` gains `exif` (JPEG APP1, PNG `eXIf`, WebP `EXIF`, PSD
resource 1058); PNG's `pHYs` and JPEG's JFIF or EXIF resolution fill `resolution`, and a JPEG's
EXIF orientation fills `orientation`.

**JPEG.** `decode` reads a JPEG through zune-jpeg directly (the decoder `image` uses, so no new
crate): a CMYK or YCCK JPEG keeps its inks, with the Adobe APP14 inversion undone exactly when
APP14 is present, and converts through its profile like a CMYK TIFF. A JFIF file's colour
model reads `YCbCr` (Adobe transform 0: `Rgb`). `decode_rgba8`, the render path, is unchanged:
`image`'s decode, byte for byte. `jpeg_header` is the frame header and APP14 read.

**One decoder.** paged-gpu's two `decode_image_for_render` copies are one call,
`decode_rgba8_at` (decode within the recorded size, resample to it). `paged-export-pdf`'s JPEG
sniff, component count and APP14 test are `paged-raster`'s. The format sniff moved into a
dependency-free leaf crate, `paged-sniff` (`Format`, `sniff`, extensions, media types), which
`paged-raster` re-exports; `idml-export` names a placed image's file through it without linking
a decoder. The web module's PNG encoder stays in its bundle: it is TypeScript running in the
bake, where the module's only Rust is its Blitz wasm, so the encoder is not reachable without a
second wasm call on the bake path.

**Dependencies.** `zune-jpeg`, `zune-core`, `image-webp` and `moxcms` become direct dependencies
of `paged-raster`; all four were already in the graph through `image`.

## Note — 2026-10-24: the frame's intent ([ADR 1032](1032-one-cms-with-intents-and-bpc.md))

`PagedColour` now carries a rendering (intent and black-point compensation) and converts
through `paged_color::cms` on the preferred backend: lcms2 on native, moxcms on wasm32 (no
longer qcms). The renderer passes the frame's `ImageRenderingIntent`, or the document's Color
Settings, to the build-time decode and, on wasm32, on the lazy image to paged-gpu's
raster-time decode (`decode_rgba8_at_with`, the merged form of `decode_rgba8_at`). The default (relative colorimetric with BPC) is
bit-identical to the transform above on native.
