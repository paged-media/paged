# ADR 626 — A Word document's embedded fonts reach the document

- **Status:** Accepted 2026-11-08.
- **Scope:** `paged-ooxml` (`fonts`), `docx-import` (`fonts`), `docx-js` (`embedded_fonts`),
  `docx-conformance` (`embedded_fonts_docx`), `packages/doc-bundle` (`fonts.ts`, the
  `assets: ["fonts"]` capability).
- **Builds on:** ADR 602 and 610 (untouched parts re-emit their bytes), slide ADR 707 (the same
  door and the same report), plugin-sdk ADR 328 and 330 (the document-font door and the
  lifetime of a face).

## Context

Word embeds the faces a document uses (File ▸ Options ▸ Save ▸ Embed fonts). Until now doc read
none of them: text set in an embedded family was drawn in a substitute on any machine that did
not have the font, while the engine already has a document-font door that slide uses for
PowerPoint's embedded fonts.

## Decision

Word stores each face as an obfuscated OpenType part, `word/fonts/fontN.odttf`, listed per
typeface in `word/fontTable.xml` (`w:embedRegular`, `w:embedBold`, `w:embedItalic`,
`w:embedBoldItalic`, each with the relationship id of the part and the `w:fontKey` GUID that
unlocks it). The first 32 bytes are XORed with the GUID's 16 bytes read from the end of its text
(ECMA-376 Part 1, 17.8.1).

- **Shared layer.** `paged_ooxml::fonts` holds what is the same in every OOXML format: `FaceUse`
  (what an embedded face may be used for), `use_for_fs_type` (the OS/2 `fsType` licence levels),
  `sfnt_fs_type`, and `deobfuscate`. Slide's `FaceUse` is now that type (`pptx-import` re-exports
  it); `pptx-fonts` keeps the Embedded OpenType and MicroType Express decoder, which only
  PowerPoint needs. Word needs no decompressor, so nothing else moved.
- **Reader.** `docx_import::fonts::embedded_faces` reads the font table and its relationships,
  unlocks each part, reads the face's own `fsType` and applies the licence as slide does: an
  installable or editable face is used (a document opens for editing); preview-and-print,
  restricted and bitmap-only faces are not, and each is named in a diagnostic with the reason. A
  bad key, a part that is not OpenType and a relationship to a missing part are told, never
  guessed at. A typeface listed twice yields each face once.
- **Surface.** `DocEngine.embedded_fonts()` returns `{ faces, diagnostics }` and
  `embedded_font_data()` the usable faces' bytes one after the other, the shape of slide's
  `DeckFonts`. Nothing is added to the wasm beyond the reader: the font table is read with the
  typed `w:fonts` DOM already linked and no `paged-mutate` is involved.
- **Bundle.** After the document is open (a face belongs to the document open when it is given),
  `ingest` gives every usable face to `host.assets.registerDocumentFont` (family and style from the
  table). The door fills a gap and never replaces a face the document already has, so an installed
  font wins over the embedded copy, as in Word. A document reopened later (File ▸ Open of a saved
  document, or open when the bundle activates) gets its faces again from the source `.docx` the
  label keeps. What the host refuses, and a host without the door, are warnings on the lane
  `media.paged.doc/embedded-fonts`. The manifest declares `assets: ["fonts"]`.
- **Save.** Reading never changes the package: the font table, its relationships and every
  `.odttf` re-emit their original bytes (ADR 602), also after an edited save. Fonts the user adds
  in paged are not written into the file (not planned: embedding is a licence decision).

## Evidence

- `docx-conformance` `embedded_fonts` (nextest): four slots with four licences, the usable
  faces' bytes equal the originals back to back, a wrong key and a missing part are told, a
  document without fonts has none, and the font parts are byte-identical after an edited save.
  The unlocking was also checked against a Word-format file from the wild (sixteen faces, every
  one an OpenType file after unlocking).
- `test/fonts.spec.ts`: the door, the refusal and no-door diagnostics, the lane.
- `test/headless/embedded-fonts.spec.ts` (real engine): File ▸ Open of `embedded-fonts.docx`
  (Lora under a family no machine has) leaves the family not missing, the engine serves exactly
  the embedded bytes, and an unedited export carries the font parts unchanged.
- `native-body.spec.ts` opens the new fixture both ways like every other fixture.

## Consequences

- A face over the host's per-face budget is refused and told; the text is drawn in a substitute.
- Subsetted faces (`w:subsetted`) hold only the glyphs the author used; editing text with other
  characters falls back per glyph. The report says which faces are subsets.
- Fonts embedded in a header, footer or anywhere else Word allows are the same parts; only
  `fontTable.xml` is read.
