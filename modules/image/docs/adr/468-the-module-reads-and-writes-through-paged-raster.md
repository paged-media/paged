# ADR 468 — The module reads and writes every raster through `paged-raster`

- **Status:** Accepted 2026-10-25. Amends [ADR 456](456-codecs.md) (the codec adapters keep
  their frozen traits; the codecs behind them are the engine's). Rests on
  [ADR 466](466-core-raster-crates-are-shared.md) and engine ADR 1005 (amendment of
  2026-10-25). Work package WP1.4 and the raster half of plan C5.
- **Scope:** `image-codecs`, `image-js` (`ingest.rs`, `saveback.rs`, `export.rs`, the wasm
  doors), the bundle's importer, exporters and Export As dialog, `registry/codecs.yaml`

## Context

The module had decoders and encoders of its own: zune-png for PNG, zune-jpeg and jpeg-encoder
for JPEG, chosen in 2026-06 by the D-4 bench. Its ingest read PSD, PNG and JPEG and refused
everything else; its exports dropped the ICC profile, EXIF and XMP (zune-png has no iCCP
writer, the targets were never handed metadata) and `encode_image_opt`, the door with a JPEG
quality, had no caller. Meanwhile the engine's `paged-raster` decodes TIFF (every layout),
PSD/PSB composites, WebP, GIF, BMP, TGA, QOI, ICO, HDR, OpenEXR, AVIF, JPEG XL, DNG and EPS
previews, so a picture the canvas shows could not be opened in the image editor.

## Decision

- **`image-codecs` adapts `paged-raster` and nothing else.** `RasterSource` implements the frozen
  `ImageSource` over `paged_raster::decode` and maps the result onto the spec's
  `ChannelLayout` set (RGB widened to `Rgba`, CMYK and CMYK + alpha as `Cmyk`/`Cmyka`, 8 and 16
  bits as `U8`/`U16`, premultiplied alpha un-multiplied; Lab and float samples through
  `to_rgba8`). `RasterTarget` implements `ImageTarget` over `paged_raster::encode`. The old
  names (`PngSource`, `JpegTarget`, ...) are those adapters fixed to one format, and
  `TiffTarget`, `WebpTarget` are new. The traits are unchanged; what the frozen `TargetInfo`
  cannot carry (EXIF, XMP, IPTC, resolution) is set on the target. EXIF parsing moved to
  `paged_raster::exif` and is re-exported.
- **One implementation per codec, the faster one, measured.** The D-4 sweep was re-run on
  2026-10-25 (release build): png 0.18 through `image` now decodes about 1.8 times faster than
  zune-png, and zune-png's faster encode writes files three times the size; `image`'s JPEG
  encoder matches jpeg-encoder's speed with files about 3 % smaller, and its JPEG decoder is
  zune-jpeg. So `paged-raster`'s encoders (`image`, image-webp, `tiff`) are the single
  implementation, and zune-png and jpeg-encoder remain only as dev-dependency fixture builders
  and the bench's comparison. The numbers are in `registry/codecs.yaml`.
- **Ingest opens every format `paged-raster` decodes.** PSD keeps its layer-aware lane; every
  other format goes through `RasterSource`. 16-bit RGB, RGBA, Gray and Gray + alpha stay 16-bit
  (the session's RGBA16 buffers); CMYK, with or without alpha, is converted through its profile
  at 8 bits as before (a 16-bit CMYK file is narrowed and the Depth row says so); Lab converts
  through the CMS; scene-linear floats (HDR, OpenEXR, float TIFF) are **clipped**, not tone
  mapped, and the colour row says `hdr-clipped`. Orientation comes from the TIFF tag or EXIF.
  The importer lists the extensions and media types.
- **Export As.** A dialog over the Image panel (File ▸ Export as…) writes PNG, JPEG, WebP or
  TIFF with: JPEG quality; a scale (Lanczos 3, the session untouched); RGB, Grayscale or CMYK
  (TIFF only) through a picked CMYK output profile or a CMYK source's own, with an intent, else
  the naive formula, said so and untagged; 8 or 16 bits (PNG, TIFF); TIFF compression (LZW,
  Deflate, none); keep or strip the source's EXIF, XMP and IPTC; embed the profile; the
  resolution. The embedded profile is that of the pixels as written: sRGB for RGB, because
  ingest converted into the working space, never the source's own RGB profile. EXIF is written
  with Orientation 1, since ingest turned the pixels upright. A 16-bit session at identity
  exports its own 16-bit samples (`export_image_handle`). WebP is lossless only: image-webp has
  no lossy encoder, and the dialog and the notes say so.
- **The save-back keeps what the source said.** Applying adjustments to a JPEG, PNG, TIFF or
  WebP source re-encodes into the source's format with its EXIF, XMP and IPTC kept, sRGB
  embedded and the image's resolution written. New exporters write TIFF and WebP.

## Consequences

- The module's wasm carries `paged-raster`'s decoders (AVIF, JPEG XL, OpenEXR among them) and
  `paged-color`'s qcms; the size is measured against the manifest cap in the WP1.4 report.
- `encode_image_opt` takes `webp` and `tiff` as well; the actions' `format` parameter accepts
  them.
- The document's CMYK profile is not reachable from a bundle (the contract names it and does
  not hand out its bytes), so CMYK export asks for a profile file. A door for the document's
  profile bytes is an SDK follow-up.
- Not here: Image ▸ Mode ▸ Assign / Convert to Profile and Edit ▸ Color Settings for the image
  context (WP1.4's other UI, after WP1.3's colour unification lands), lossy WebP, CMYK JPEG
  encode, GIF/BMP encode, TIFF EXIF IFD pass-through.
