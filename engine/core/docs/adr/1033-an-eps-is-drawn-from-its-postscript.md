# ADR 1033 — An EPS is drawn from its PostScript, by `paged-ps`

- **Status:** Accepted 2026-10-24.
- **Scope:** no wire change (protocol unchanged). New crate `paged-ps`; `paged-renderer`
  (`pipeline/placed_eps.rs`, `pipeline/images.rs`); `paged-raster` gains the decode filters
  (`filters`); `paged-color` gains `math`; `paged-compose` gains `PathData::from_bez`/`to_bez`.
  Reverses the "no PostScript interpreter" ruling the placed-EPS rows carried (Q-06, Q-14).

## Context

A placed EPS was recognised and then not drawn: the renderer sniffed `%!PS`, reported a decode
failure and painted the frame fill. Since WP1.5 a linked EPS with a DOS-binary TIFF or an EPSI
preview draws that preview, a low-resolution raster that many EPS files lack. InDesign itself
draws the PostScript. The other routes were closed: a Ghostscript sidecar is AGPL and native
only; a PDF conversion needs an interpreter anyway.

## Decision

**A clean-room interpreter.** `paged-ps` is a PostScript Level 2 interpreter written from the
PostScript Language Reference Manual (third edition) and the Type 1 Font Format specification;
no other interpreter's code was read or ported. Pure Rust, wasm-safe, no I/O.

- **The language.** Scanner (numbers with radix, names, the string forms, ASCII85 strings,
  procedures, `//name`, binary tokens for numbers and strings); operand, dictionary and
  execution stacks; execution is iterative (a procedure, file, loop or `stopped` is a frame), so
  PostScript recursion costs heap, not Rust stack. The core operators: stack, arithmetic,
  relational and bitwise, control (`if`…`loop`, `forall`, `exit`, `stop`/`stopped`), dictionaries,
  arrays, packed arrays, strings, conversion, `bind`, `save`/`restore` (graphics state only; VM
  contents are not rolled back), files (`currentfile`, `readstring`/`readhexstring`/`readline`,
  `token`, `eexec`), resources (`findresource`/`defineresource` for Font, Encoding, ProcSet and
  the rest), and the device and VM operators an EPS calls, as no-ops. An operator that fails
  leaves its operands; `stopped` catches errors; `languagelevel` is 2 (`shfill` is present for
  programs that test for it).
- **Files and filters.** Every file is read a byte at a time through one position, so `RD`
  reads a charstring right after its token. A decode filter is decoded when it is first read
  (by then the program has read the tokens after `filter`, and its source stands at the data):
  ASCIIHex, ASCII85, RunLength, LZW (EarlyChange), Flate (TIFF and PNG predictors), DCT and
  SubFile. The decoders live in `paged-raster::filters` (shared capability C5): Flate through
  flate2, LZW through weezl, DCT through jpeg-decoder (which hands CMYK samples over as stored,
  what a PostScript `Decode` array expects); each reports what it consumed, and stops at the
  memory budget.
- **Graphics.** The graphics state (CTM, line parameters, dash, flatness, overprint recorded),
  paths in device space as PostScript keeps them, on kurbo (shared capability C8: `Affine`,
  `BezPath`, `kurbo::Arc` for `arc`/`arcn`/`arct`/`arcto`, `kurbo::flatten`,
  `reverse_subpaths`, `kurbo::stroke` for `strokepath`); `fill`/`eofill`/`stroke`/`rect*`,
  `clip`/`eoclip`/`rectclip`; forms (`execform`) and patterns (`makepattern`/`setpattern`:
  a shading pattern shades under a clip; a tiling pattern runs its PaintProc per cell under a
  clip, coloured or uncoloured, up to 4096 cells, beyond that an even grey, reported).
- **Colour.** DeviceGray/RGB/CMYK; Indexed (table or procedure); Separation and DeviceN through
  their tint transforms to the alternate (the separation's name is kept on the paint; `/None`
  paints nothing, `/All` paints the alternate); ICCBased through its alternate or its component
  count; the CIE-based spaces approximated by the device space of their component count,
  reported. HSB and the naive CMYK formula are `paged-color::math` (shared capability C4), the
  formula the CMS already used.
- **Images.** `image`, `colorimage`, `imagemask` in their operand and dictionary forms, ImageType
  1 and 4 (colour-key masking), 1–16 bits, `Decode` arrays, one source or one per component
  (procedures are called in turn), sources from a string (reused), a file or procedures; samples
  are converted to 8-bit device pixels.
- **Shading.** `shfill` types 1–3. An axial shading and a radial one between concentric circles
  become a gradient (33 stops sampled from the function: types 0, 2, 3, arrays of them, or a
  procedure); an unextended end is a clip. A function-based shading and a radial one between
  offset circles are sampled into an image of at most 400 px per side. Types 4–7 are reported
  and skipped.
- **Text.** Type 1 fonts (the eexec section, hex or binary; charstrings decrypted with lenIV;
  Subrs, flex, hint replacement, `seac`), Type 3 (BuildGlyph or BuildChar, `setcachedevice`,
  `setcharwidth`), Type 42 (sfnts through ttf-parser). Glyphs are drawn as filled outlines.
  `show`, `ashow`, `widthshow`, `awidthshow`, `xshow`, `yshow`, `xyshow`, `kshow`, `cshow`,
  `glyphshow`, `stringwidth`, `charpath`; `scalefont`, `makefont`, `selectfont`, reencoding.
  A font the program names and does not define is a **substitute**: the renderer's
  `FontProvider` resolves the PostScript name through the document's asset resolver
  (`Helvetica-BoldOblique` → family `Helvetica`, style `Bold Oblique`) and falls back to the
  build's fallback face; the substitution is in the report, and with no face the text is not
  drawn. Composite (Type 0) fonts are reported and skipped.
- **DSC.** The `%%BoundingBox` and `%%HiResBoundingBox` (the high-resolution one is the art's
  box), `(atend)` boxes from the trailer, `%%BeginBinary`/`%%BeginData` sections stepped over by
  the comment reader, the DOS-binary EPS header's PostScript section. Without a box, the box is
  the drawing's, reported.
- **Limits.** Operations (50 M), memory (a 512 MB allocation budget over the run, decoded
  data and output included), wall time (20 s; not on wasm32, which has no clock), nesting of
  procedures run inside operators (48), operand stack (100 000), execution stack (20 000),
  output elements (2 M). A program over any is refused with `Error::Limit(kind)`
  (`limitcheck: the memory limit was reached`); `stopped` does not catch it.

**Output.** `interpret` returns an `Art`: fills (with their rule), strokes (path in their user
space, the CTM beside them, so a scaled pen stays elliptical), clip pushes and pops, images and
gradients in PostScript's default user space, the bounding box, and a `Report` (substituted
fonts, skipped features, operation count). Nothing in `paged-ps` depends on the display list.

**The renderer draws it.** `placed_eps::prepare` runs the interpreter once per resolution and
converts the art: paths through `PathData::from_bez`, colours to paints (grey and RGB in linear
light; CMYK kept as `Paint::Cmyk` with its display colour from the document's CMYK transform, so
the PDF export keeps it CMYK), images to RGBA (CMYK through the document's profile). `draw` lays
it into the page's list at the placement's transform, image space y-down from the box's
top-left corner in points, clipped to the box as InDesign clips it. A resolved EPS is
`Placed::Eps` beside `Placed::Pdf` and `Placed::Svg`, remembered in the decoded cache
encoded-only as an SVG is. The PDF export writes the list, so the EPS reaches the PDF as
vectors. Order: a PDF (an `.ai` file is one, even behind a `%!PS` header) first, then the
interpreter, then the raster path, where the WP1.5 preview is the fallback for a program the
interpreter refuses.

## Consequences

- A placed EPS renders as vectors on both rasterizers and in the PDF export; an EPS with only a
  preview, or none, no longer shows the frame fill when the interpreter runs it.
- Each frame placing an EPS interprets it again (as an SVG is prepared again); a document with
  many placements of one heavy EPS pays that per frame. A shared cache of prepared art is a
  follow-up.
- `save`/`restore` restore the graphics state, not VM contents; programs that rely on restore
  undoing definitions see their later definitions. Overprint is recorded, not applied; halftone,
  transfer and colour-rendering operators are accepted and ignored.
- Not covered: smooth shadings 4–7, composite fonts, ImageType 3, CCITTFax, `CIEBased`
  conversions, Level 3 operators beyond `shfill`. Each is reported when met.
- An "open EPS as native vectors" import door can build on the same `Art` later.
