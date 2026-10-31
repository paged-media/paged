# ADR 482 — A smart object is a source, a placement and its filters; the layer is their render

- **Status:** Accepted, 2026-10-29 (WP5.14; closes I-25 and I-40's smart-object half). Amends
  ADR 478 (a transformed smart object is no longer rasterized on save) and ADR 467 (the CPU
  resample gains the projective warp a placement is drawn with).
- **Scope:** `paged-psd`'s `smart_object.rs` (placed-layer records, linked files, smart
  filters, the filter-effects cache) and `AdditionalLayerInfo::payload` / `opaque`;
  `paged-resample`'s `warp_projective_rgba8`; `paged-warp` (the homography, taken unchanged
  from WP4.1's branch); `image-js`'s `smart.rs`, `layers/smart_ops.rs`, the `SmartSource`
  model, the canvas ops' smart-object paths, `psd_write_smart.rs`, `layers_persist.rs`
  (manifest version 7) and the `wasm/smart_doors.rs` doors; the bundle's `smart-engine.ts`,
  `smart-session.ts`, the Smart object section and Transform dialog, Layer ▸ Smart objects ▸ …,
  Filter ▸ Convert for smart filters and Filter ▸ Blur ▸ Gaussian blur…, the `links` binding
  provider and the host Links panel's provided rows (`ProvidedLinkRow`, plugin-api); the
  Photoshop probes `smart-objects.jsx` and `smart-readback.jsx`.

## Context

A smart object was a layer kind that kept the pixels it was converted from and a scale: a
re-render letterboxed the source at that scale into the top-left corner on the GPU. A PSD's
smart object was imported as the render Photoshop stored, and only when the file's composite
agreed with it; nothing read its source, its transform or its filters. Canvas Size, a crop at
another scale and an arbitrary rotation were refused over a smart object, moving one by whole
pixels was refused, the layered save rasterized a transformed one (ADR 478), smart filters were
only "an adjustment layer clipped to it", there was no Edit Contents, and a linked file had no
place in the host's Links panel.

## Decision

**Three parts, one render.** A smart object holds its SOURCE (`SmartFile`: embedded bytes, or a
link and its path; or the pixels it was converted from; or the page items of a vector smart
object), its PLACEMENT (the four corners the source's rectangle lands on, `Quad`, Photoshop's own
`Trnf` / `nonAffineTransform`) and its SMART FILTERS with their filter mask. The layer's pixels
are only the render of the three, made again from the source whenever one changes — a transform,
a canvas op, Image Size, a filter edit, new contents. A placement may be any affine map or a
perspective; a scale down and up again loses nothing, because nothing is ever resampled twice.

**The placement is drawn on the CPU.** `render_placed` reduces the source with Lanczos-3 when the
placement shrinks it (below 0.8 on either axis) and draws it through the placement's homography
with the bicubic projective warp of `paged-resample` (Catmull-Rom, premultiplied, transparent
outside the source), into the window the quad covers (ADR 464). It is a one-shot render per
change, like a decode, and it is what the import, Image Size, a canvas op, the PSD save and the
headless object model all need without a device — so it is the ADR 467 backend, not a kernel
twin. WP5.6's `geom.warp_projective` kernel may take the interactive Free Transform preview; the
committed render stays this one.

**The source is decoded once, on demand.** A PSD's smart object opens as the render Photoshop
stored (exact) with its source, placement and filters adopted (`adopt_psd_smart_objects`); its
embedded file is decoded the first time something re-renders it and the decode is cached with
the file. A stored render the composite disputes (a stale cache) is now drawn from the source and
judged again before the import declines. A warp is read and kept, not drawn: such an object keeps
Photoshop's render until it is transformed in paged; a missing link keeps its render and says so.

**Smart filters are the Filter dialog's filters.** A filter run on a smart object (the dialog's
OK, `applyFilter`) becomes a smart filter instead of a pixel edit: the stack lists catalogue ids
and values, each with a switch and an opacity, plus the whole stack's switch and the FILTER MASK.
The bundle runs the live filters through the same `FilterDef.run` the dialog runs, on a detached
copy of the unfiltered render (`layers_smart_filter_base`), fades a filter below 100 % over its
input, and lands the result through the filter mask (`layers_smart_filter_land`). No kernel is
new: Gaussian Blur, which the catalogue lacked, is the adjust chain's blur run detached (Photoshop's
radius is the Gaussian's sigma, as the oracle's `gaussian-r*` cases already showed). The pass is
GPU work; without a device the object shows its unfiltered render and is marked pending, and the
session's next fold runs it.

**What Photoshop does that the files do not say** (recorded, `smart-objects.jsx`): the PSB a new
smart object embeds has only a white placeholder composite (no real merged data) and is padded to
1 MiB — its contents are flattened from its layers (a plain stack on the CPU; a richer one keeps
the stored render until Edit Contents writes a real composite); a filtered object's layer channels
are the filters' output BEFORE the filter mask, drawn through the mask over the unfiltered render
cached in `FEid` — the import shows that mix; a blur smart filter averages associated colour (so
the pass associates around the blurs, `ASSOCIATED_FILTERS`); and Photoshop refuses a file whose
`SoLd` length is not a multiple of 4 (every smart-object block is written padded to 4, as it
writes them).

**One undo step.** Every verb is one structure step of the stack. The filter pass that may follow
a verb records nothing: it finishes the verb's step, so an undo takes the verb and its filtered
render back together, and a redo restores the filtered render it had.

**Edit Contents is a nested document.** `smart_contents_open` parks the parent (its stack, its
undo list, its handle) and binds the contents — a PSD/PSB opened with its layers, any other file
as one layer — on a new image handle; the session shows them in the same frame and every door
works on them. `smart_contents_close(save)` writes the contents back — into the PSD/PSB they came
from through the layered save, or as a new PSB — and replaces the smart object's source: ONE step
in the parent ("Edit Contents"). Discarding, or saving unchanged contents, leaves the parent as it
was. A commit or a PSD export saves and closes open contents first. A vector smart object's
contents are page items: they are edited on the page.

**A smart object is not painted on.** Painting, a destructive filter and Merge Down onto a smart
object are refused ("not directly editable"), as in Photoshop; its mask is a mask and paints.

**The layered save writes it live.** An unchanged smart object keeps its record and its source
entry byte for byte (ADR 478). A changed one gets its `SoLd` patched — corners, source size and
uuid, `filterFX` in Photoshop's form — and `PlLd` regenerated from it; new contents add an `liFD`
entry (a source that is not a file becomes a one-layer PSB of its pixels); a filtered object gets
a new `FEid` entry (its unfiltered render and filter mask) and the document an `FMsk` when it had
none. The filters Photoshop has a counterpart for are written as Photoshop writes them (Gaussian
Blur, Motion Blur, Box Blur, High Pass and the square Median, Maximum and Minimum, recorded); an
object with any other smart filter is saved as the pixels it shows and the save says so. A
relinked object whose new link cannot be written is saved embedded, and says so.

**Links go through the host Links panel.** While the image's edit context is active, its binding
provider serves the `links` collection: one row per smart object with a file, its status
(`embedded`, `ok`, `missing`) and the commands the panel runs for it (`ProvidedLinkRow.actions`:
Relink, Update from file, Embed, each with `{ link }`). The panel lists those rows after the
document's own links and branches on what a row offers, never on who served it. A browser cannot
reread a path, so Update reads the file the user picks again and keeps the link's path.

**Vector smart objects.** Page items placed into the image (Layer ▸ Smart objects ▸ Place selected
page items) are drawn by the host (`render.snapshot@2`, transparent, trimmed, raw RGBA) at the
image's own resolution in the frame and placed where they lie over it. The items are the source:
a placement grown past what the source holds draws them again at the resolution it needs (up to
2400 ppi), one undo step with the transform.

## Consequences

- Photoshop is the oracle both ways (`smart_objects_photoshop.rs`): its 17 recorded records read
  back to what it reported (corners, size, eight filter classes byte for byte, the filter mask);
  paged's render from each embedded source is Photoshop's stored render exactly for identity, a
  flip and a scale down and up, and within 0.8–6 % of pixels more than 8 levels off for a turn, a
  skew and an enlargement (a convention: Photoshop's "Bicubic Automatic" is unpublished; the
  differences sit on the edges of the content's transparency); the Gaussian Blur smart filter, with
  and without a filter mask, within 3 levels on a GPU; and Photoshop reopens the five files paged
  writes — transformed, in perspective, filtered with a filter mask, re-contented, made in paged —
  as live smart objects whose contents open, and draws them again within 0–5 % (the perspective
  1.6 %).
- The manifest is version 7; a version-6 smart object opens at its old placement (the top-left
  corner at its scale). The TypeScript codec mirrors it byte for byte.
- `paged-warp` is the file WP4.1's branch adds, unchanged, so the merge is clean.
- Not here: drawing a warp (`customEnvelopeWarp`), smart filters in modes other than Normal,
  smart filters on 16-bit documents' pass (the pass is 8-bit), painting the filter mask with the
  brush (it is set from the selection, inverted, cleared or switched), linked files read without a
  picker, Photoshop's Convert to Linked and New Smart Object via Copy, multi-page (PDF/AI) sources
  and layer comps of the contents.
