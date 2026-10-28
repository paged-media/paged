# ADR 1038 — The remaining codecs: GIF, BMP, TGA, JPEG XL and AVIF encode, HDR and OpenEXR floats, and the layered TIFF

- **Status:** Accepted 2026-10-28.
- **Scope:** no wire change (protocol unchanged), no contract change (plugin-api and plugin-sdk
  untouched). `paged-raster` (`encode`, `tif/encode.rs`, `other.rs`), `paged-psd`
  (`layer_list.rs`, `model/layers.rs`); in the image module, `image-js` (`export.rs`, the
  `psd_to_layered_tiff` door) and the bundle (Export As formats, the "TIFF with layers"
  exporter, the importer's media types, `registry/codecs.yaml`). Work package WP9.4; extends
  [ADR 1005](1005-a-raster-is-read-by-paged-raster.md).

## Context

ADR 1005 gave the engine one raster crate: every decoder the renderer and the image module use,
and the encoders of WP1.4 (PNG, JPEG, WebP lossless, TIFF). The codec matrix still lacked the
small web and legacy encoders, JPEG XL and AVIF encode, a decision on the floats of Radiance HDR
and OpenEXR (decoded since WP1.5, clipped for display), and a way to write a TIFF that keeps
Photoshop's layers: the reader of tag 37724 existed, the writer did not.

## Decision

**Encoders.** `EncodeFormat` gains `Gif`, `Bmp`, `Tga`, `Jxl` and `Avif`, with `name`, `ALL`,
`available` (this build carries the encoder) and `lossless`. `encode` writes:

| Format | Samples | Through | Notes |
|---|---|---|---|
| GIF | Gray/RGB ± alpha, 8-bit, Gray widened | `image` (`gif`, NeuQuant speed 10) | at most 256 distinct colours (alpha included) are kept exactly, more are quantized; alpha is one bit |
| BMP | Gray/RGB ± alpha, 8-bit | `image` | Gray with alpha goes out as RGBA (the 32-bit gray form has no alpha mask); the resolution as pels per metre |
| TGA | Gray/RGB ± alpha, 8-bit | `image` | RLE |
| JPEG XL | Gray/RGB ± alpha, 8/16-bit | `zune-jpegxl` 0.5 (MIT OR Apache-2.0 OR Zlib), feature `jxl-encode`, default on | lossless (modular) only |
| AVIF | Gray/RGB ± alpha, 8-bit in, quality | `ravif` 0.13 (BSD-3-Clause) over `rav1e` 0.8 (BSD-2-Clause), feature `avif-encode`, default **off** | speed 6, one thread, no assembly; EXIF (`Exif` item) |

None of GIF, BMP, TGA and JPEG XL carries metadata or a profile as written here. A colour model a
format cannot hold (CMYK, Lab) is refused naming it; a format whose feature is off is refused
naming the feature. WebP stays lossless (image-webp has no lossy encoder).

**JPEG XL lossy encode is declined.** The only pure-Rust VarDCT encoder is AGPL-3.0 or
commercial, which `deny.toml` refuses; libjxl is C++. zune-jpegxl's lossless encoder is small
(about 55 KB of wasm) and round-trips 8- and 16-bit samples through jxl-oxide exactly.

**AVIF encode stays out of every wasm.** rav1e is the only permissive pure-Rust AV1 encoder.
Built into the image module's wasm it adds 1,715,779 bytes (9,861,855 against 8,146,076;
brotli +276 KB), which breaks the module's 8 MiB manifest cap. The feature is therefore off by
default: native builds that want it turn it on, `core-ci.yml` runs paged-raster's suite with it
(clippy and nextest), and the module's Export As does not offer AVIF. rav1e names
`libfuzzer-sys` (NCSA) as a `cfg(fuzzing)` dependency no build compiles; `deny.toml` lists it as
the one licence exception, so `cargo deny --all-features` stays clean.

**HDR and OpenEXR are float rasters.** `decode` hands both over as 32-bit float RGB(A)
(`SampleFormat::Float`, scene-linear; `to_rgba8` still clips and sRGB-encodes for display). Two
corrections and one recorded convention come from the Photoshop oracle (below):

- An OpenEXR alpha is **associated**: OpenEXR stores colour premultiplied, Photoshop reads it
  so (its float TIFF of the file says ExtraSamples 1), and `image` hands the samples over as
  stored. `probe` and `decode` now say `Alpha::Associated`, so `to_rgba8` divides the alpha out.
- A deep OpenEXR (version flag bit 11) and one without R, G and B channels (luminance and
  chroma, or channels of other names) are refused as `Error::Unsupported`, naming the variant,
  instead of `image`'s generic decode error.
- **Convention (Radiance HDR):** Photoshop, like Radiance's own reader, reads a non-zero RGBE
  mantissa at the middle of its step, `(m + 0.5) · 2^(e−136)`; `image`'s decoder, kept, reads
  `m · 2^(e−136)`, the value a truncating encoder started from. The difference is half a
  mantissa step (at most 0.4 % of the pixel's largest channel); a zero mantissa is 0 in both.
  The replay holds that relation exactly.

**The layered TIFF.** `paged_psd::image_source_data` writes a document's layers the way
Photoshop stores them in tag 37724: the signature `Adobe Photoshop Document Data Block\0`, then
`8BIM` blocks padded to 4 (the length counts the pad): the layer info (`Layr`, or `Lr16` /
`Lr32` for 16 and 32 bits: the signed count, the records, the channel image data, exactly the
PSD layer info body, through a shared `emit_layer_info_body`), `LMsk` when there is a global
mask, then every other document-level block as stored. `image_resource_blocks` gives the
resources for tag 34377. A PSB (8-byte record lengths) and a document without layers are
refused by name. `paged_raster::encode_layered_tiff(img, image_source_data, opts)` writes the
TIFF; `psd_to_layered_tiff(psd, opts)` takes a PSD whole: its merged composite as the TIFF's
image, its layers, its resources, its profile, XMP, IPTC and resolution.

The file is **big-endian** (`MM`). Photoshop reads the layer data in the TIFF's byte order and
paged-psd writes (and reads) big-endian layer data; `tiff`'s encoder writes the machine's order,
so the finished file is turned big-endian in place: the header, every directory entry and the
values they point at, by type. Strip bytes are left as they are, which is exact for 8-bit
samples only, so the layered writer takes 8-bit samples and `psd_to_layered_tiff` refuses a 16-
or 32-bit document (the composite decoder reads 8 bits; its layers would not match).

**The image module.** Export As offers GIF, BMP, TGA and JPEG XL (16 bits for JPEG XL), with
the notes `gif-palette` (more than 256 colours or partial alpha), `jxl-lossless` and
`no-metadata` (the format carries none, and keeping or embedding was asked). File ▸ Export gains
"TIFF with layers": the session's PSD export (the layered save) through `psd_to_layered_tiff`;
a session not opened from a PSD is told it needs one. The importer also names the media types
of OpenEXR, Radiance HDR and TGA. The module's wasm grows from 8,017,844 to 8,146,076 bytes
(+128 KB, brotli +37 KB: the JPEG XL encoder about 55 KB, the GIF quantizer and the
BMP/TGA/layer writers about 72 KB), under the 8,388,608-byte cap.

**The host's Asset Export** is not on main yet (its snapshot formats are a wire enum of PNG,
JPEG, WebP and TIFF); GIF, BMP, TGA and JPEG XL join it there through `EncodeFormat::from_name`
when it lands.

## Oracle

`modules/image/scripts/photoshop/probes/codecs-open.jsx`, recorded with Photoshop 27.10 on
2026-10-28 into `crates/paged-raster/tests/fixtures/photoshop/`, opens what paged-raster writes
(the inputs come from `cargo run -p paged-raster --example oracle_files`). Replayed by
`tests/it/oracle.rs`, which first regenerates every input and checks it is the recorded copy:

- **Layered TIFF: agreement.** Photoshop opens it with the three layers (names, opacity, blend
  mode, visibility and bounds of the PSD's records), composites them as Normal, Multiply and
  Screen at their opacity (within one level), and each layer shown alone is the layer data the
  tag carries.
- **OpenEXR: agreement**, colour floats equal to the last bit (alpha associated in both;
  Photoshop keeps a 32-bit document's transparency at 16 bits, so a zero alpha returns as
  1/65536).
- **Radiance HDR: convention**, as above.

## Consequences

- Export As writes eight formats; a native build can write AVIF.
- A placed OpenEXR with alpha now has its colour divided by the alpha when it is drawn.
- Opening a layered TIFF still reads its composite and counts its layers; reading the layers
  into the image module's stack is a later step, as is a layered TIFF from a session that was
  not opened from a PSD.
- The Radiance half-step convention stays `image`'s until a reader of our own is worth it.
