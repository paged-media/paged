# ADR 478 — The layered PSD save writes what it reads

- **Status:** Accepted, 2026-10-28 (WP5.15).
- **Scope:** the layered save (`image-js/src/psd_write.rs`, `psd_source.rs`), the adjustment
  model, the descriptor writer, the deep-document layer list and the 16-bit channel codec in
  `paged-psd` (`engine/core/crates/paged-psd/src/adjustment.rs`, `descriptor.rs`,
  `model/layers.rs`, `model/channel.rs`, `layer_list.rs`), the sRGB-to-ink helper in
  `paged-raster`, `registry/psd-blocks.yaml`, and the Photoshop probes
  `adjustment-layers-ext.jsx`, `psd-containers.jsx` and `psd-readback.jsx`.

## Context

The layered save rebuilt every record from the layer stack. A PSD opened as layers and saved
again lost what the stack does not model: text layers came back as pixels, smart objects as
their stored renders, vector masks as rasters, metadata and every block paged does not read
were dropped. Only five adjustment kinds had a writer (the rest flattened the whole file),
16-bit and CMYK documents and their layers could not be saved at all, and three descriptor
writers existed (the shared one, a private one in the `.abr` writer, one in the image module's
fill blocks).

## Decision

**A layer remembers its record.** The layered import attaches to each layer the record it was
read from and the state the import left it in (`LayerExt::source`, `psd_source::PsdSource`;
pixels and masks compared by the shared content hash, not by keeping the old buffers alive).
The save writes:

- an UNEDITED layer as that record — every block and channel payload, byte for byte;
- an EDITED layer as that record with only what changed replaced: name, opacity, blend,
  visibility, clipping, each parity block (`iOpa`, `knko`, `lspf`, `lclr`), Blend If, the style
  (`lfx2`/`lmfx`) and its options, the adjustment's blocks, the fill content, the mask, the
  pixels. New pixels drop what described the old ones (`TySh`, `PlLd`/`SoLd`/`SoLE`, the shape
  blocks): such a layer reopens as the pixels it has. A changed mask replaces the user and
  vector masks with the stack's one mask. A duplicated layer drops its `lyid`;
- a layer MADE in paged as a new record.

A smart object therefore stays a live smart object through opacity, blend, name, style and mask
edits; its sources in the document's `lnk2`/`lnkE` blocks are kept. Text and vector masks are
preserved the same way (their writers are WP5.10 and WP5.11).

**Every adjustment Photoshop has a layer for is written,** as Photoshop writes it.
`paged_psd::adjustment::Adjustment` reads and writes Curves, Levels, Exposure, Invert,
Hue/Saturation, Brightness/Contrast (`brit` beside its `CgEd` descriptor), Color Balance,
Vibrance, Black & White, Photo Filter (Lab), Channel Mixer, Posterize, Threshold, Gradient Map
and Selective Color. The layouts come from layers Photoshop 27.10 wrote with known parameters
(`adjustment-layers-ext.jsx`); the replay reads each of its blocks to those parameters and
writes them back byte for byte. Develop (a Camera Raw filter in Photoshop), Color Lookup (whose
look Photoshop compiles into a profile; a scripted `.cube` load makes an empty layer) and a
stored chain have no counterpart: a stack with one keeps the flatten fallback, which says why.
Reading is not drawing: the import draws the kinds the stack reproduces (Black & White, Channel
Mixer, Posterize, Threshold, measured against Photoshop) and declines the others by name with
the measured distance (`NOT_REPRODUCED`), so such a file still opens flattened in paged while
Photoshop opens paged's file with live layers.

**The document keeps its depth, mode and container.** A deep document's layers (`Lr16`/`Lr32`)
are read at parse into the model's one layer list (`LayerAndMaskInfo::deep_key`) and written
back into that block, the layer info left empty — so the import, the edits and the save see a
16-bit document like any other. 16-bit channels are ZIP with prediction over big-endian samples
(read and written), the composite RAW. A CMYK document's new pixels go through
`paged_raster::srgb8_to_cmyk8` with the document's profile and are stored inverted; an edited or
new adjustment layer in a CMYK document is refused (the stack evaluates it in RGB, Photoshop
would apply the block to the inks). A PSB is written as a PSB.

**One descriptor writer.** `paged_psd::descriptor` is the repository's only descriptor writer;
a `WriteStyle` keeps the one difference between producers (PSD class names counted with a NUL,
`.abr` ones without). The `.abr` writer and the image module's fill blocks write through it.

**The oracle is Photoshop reading paged's files.** `psd-readback.jsx` opens every file the save
writes for a set of cases (each adjustment kind as a new layer over Photoshop's own background,
an edited Curves layer, fill layers and a style, an edited smart object, an edited 16-bit, CMYK
and PSB document) and reports layer kinds, adjustment parameters, effects and a render. The
replay (`psd_write_photoshop.rs`) holds the files to the recording by content hash, the report
to what was written, and Photoshop's render of each paged-written adjustment layer to its render
of its own layer of the same parameters.

## Consequences

- A paged-edited PSD reopens in Photoshop with live adjustment, fill, smart-object, text and
  vector layers; an untouched layer is the file's own bytes.
- The import holds one clone of each imported record (the compressed channels included) for
  the save; a session reopened from its persisted parts has no records, so its layers save as
  built ones.
- Group records are still rebuilt (an artboard saves as a plain group); a transformed smart
  object is rasterized rather than re-placed (WP5.14); pattern fills save as their render; the
  `TySh` and vector-mask writers belong to WP5.10 and WP5.11, which can build on the record
  patching here.
- `registry/psd-blocks.yaml` marks the adjustment, effect, fill, descriptor, record, `Lr16`,
  ZIP and PSB rows `mutatable`.

## Amendment, 2026-10-29 (ADR 481)

The layered save writes the DOCUMENT's mode and depth: a document converted with Image ▸ Mode
(Grayscale, Lab, CMYK, RGB; 8 or 16 bits) is written in that mode, every record's channels
anew, with the profile its values are in. An adjustment layer or Blend If in a document
converted to another mode is refused (the flatten fallback says why). A CMYK file's document
stays CMYK on open, so it is still written as CMYK.
