# ADR 616 — Files: templates, macros, RTF, OpenDocument, .doc, and "Save as .docx"

- **Status:** Accepted 2026-10-25.
- **Scope:** `docx-js/src/files.rs` (`DocSession::open_file`, the wasm `open_file`,
  `source_docx`, `native_docx`), `docx-export/src/write.rs` (`write_docx`),
  `docx-export/src/native.rs` (`native_document`), the new crates `docx-rtf` and
  `docx-odt`, `packages/doc-bundle/src/files.ts`, `activate.ts` (importers, the
  exporter's native path, `activateWith`), `object-model.ts` (`saveAsDocx`,
  `pasteRtf`). Word-parity program, wave W5.

## Context

paged.doc opened `.docx` (and, by accident of the importer, a `.dotx` as if it were the
document) and nothing else. Word users bring templates, macro-enabled documents, RTF from
older tools and from the clipboard, and OpenDocument files; a `.doc` failed with a container
error; and a document made in paged could not be saved as a Word document at all, because
save-back (ADR 602) only splices into the file that was opened.

## Decision

1. **The bytes decide the format, in Rust.** `DocSession::open_file(bytes, name, options)`
   turns every format it reads into the `.docx` package the session works on, so the
   lowering, the skeleton, the pour and save-back stay one path. It answers an `OpenReport`
   (`format`, `untitled`, `macros`, `saveName`, `diagnostics`), which the bundle shows as
   diagnostics (`media.paged.doc/file`). The importer and Insert ▸ Word document both use it.
2. **A template opens as a new document.** For `.dotx` (`…template.main+xml`) and `.dotm`
   (`…macroEnabledTemplate.main+xml`) only `[Content_Types].xml` changes: the main part becomes
   a document's (`…document.main+xml` / `…document.macroEnabled.main+xml`); every other part
   keeps its bytes. The document is named `Untitled.docx` (`.docm`), so saving never writes
   the template. Following editor ADR 293 (a template opened as a document says so), the
   outline panel shows a notice naming the template and saying that saving writes a new
   Word document, and the same sentence is the first `media.paged.doc/file` diagnostic.
3. **Macros are carried, never run.** A `.docm` (or any package with `vbaProject.bin`) opens
   like a `.docx`; save-back splices `word/document.xml` and leaves `vbaProject.bin`, its
   relationships and the macro-enabled content type alone. It saves under its `.docm` name.
   Diagnostic: "This document contains macros. They are kept in the file and saved with
   it, but paged.doc never runs them."
4. **RTF is read onto docx-core (`docx-rtf`) and written as a new `.docx`.** It is a tokenizer
   plus a group-state machine with no dependency beyond docx-core: fonts, colours, the style
   sheet (with `\sbasedon`), character and paragraph formatting, `\listtable` lists, tables with
   merges, PNG/JPEG pictures, HYPERLINK fields, breaks, `\uN`, Windows-1252 `\'hh`, and
   sections. Formatting that only repeats the style is dropped from the runs. What it does
   not read (headers and footers, notes, comments, objects, metafile pictures, other code
   pages) becomes a diagnostic. An RTF file named `.doc` opens as RTF.
5. **OpenDocument text is read onto docx-core (`docx-odt`), behind a flag.** The `odt` cargo
   feature of docx-js (on by default) carries the reader; the bundle registers the `.odt`/`.ott`
   importer only with `docBundleWith({ odt: true })`, and the engine refuses OpenDocument
   unless asked. Read: paragraphs, headings (Word's `heading N`), spans, links, named and
   automatic styles, the default style, lists, tables with spans, pictures, and the page layout.
   There is no save-back to OpenDocument: the document saves as `.docx`.
6. **`.doc` is refused at the door** with: "This is a Word 97–2003 document (.doc), which
   paged.doc does not open. Open it in Word and save it as a Word Document (.docx) …". The
   importer claims `.doc` so the user gets this rather than "no importer". The binary format
   is not read (user decision).
7. **A new package is written from docx-core (`write_docx`).** It is the smallest package Word
   opens: content types, relationships, `document.xml`, `styles.xml` (the document's styles
   plus Normal, Default Paragraph Font, Normal Table and Table Grid; heading styles get their
   outline level), `settings.xml` (compatibility mode 15), `numbering.xml` (all nine levels of
   each list), and the pictures. It is written as text, never through the ooxmlsdk serializer
   (the wasm budget guard in `scripts/build-wasm.sh`). Headers, footers and notes are not
   written; the report names them.
8. **"Save as .docx" for a document not from Word.** When the document has no Word document
   in it, the `.docx` exporter (and the typed command `media.paged.doc.command.saveAsDocx`)
   reads every story (`document.storyContent`), the styles they name
   (`document.styleProperties`), their colours and the first page, and `native_document` maps
   them through the save-back's inverse (`invert_props`, `invert_para_props`). A paragraph
   style whose list type is a bullet or numbered list makes Word list items. Tables, pictures
   and frames are not in the story read and are not written.
9. **Styled paste goes through RTF.** `media.paged.doc.command.pasteRtf` reads the RTF with the
   same reader and pours its paragraphs at the caret (`buildTextPour`: insertText plus
   applyStyle; `ReplaceStoryParagraphs` is an internal engine operation, not a wire op). The
   host clipboard (`host.clipboard`) carries only text and tabular data, so the command takes
   the RTF as its argument. Reading HTML or RTF from the system clipboard needs contract C8;
   that is a follow-up and was not built here.

## Consequences

- `docx_js_bg.wasm` grows by about 0.43 MiB (6.56 → 6.98 MiB raw, measured with
  `scripts/build-wasm.sh`), within the 8 MiB `maxBytes`.
- An RTF or OpenDocument file saves as a `.docx` written by paged. Save-back after that splices
  into that package as usual, because the session's source is the written package (stored as
  the label's part).
- The tagged-PDF check found two gaps, both in the engine, and neither was changed here:
  - Headings are not tagged as headings. The PDF export writes each paragraph under its style
    name, but maps it to `H1`–`H6` only from the style's `pdf_export_tag`, which no wire
    property sets, so headings from a Word document are tagged `P`.
  - The PDF has no outline from the headings. Its outline comes only from document bookmarks,
    and the Word lowering creates none.

## Evidence

- Rust: `docx-rtf` unit tests (8), `docx-odt` unit tests (4),
  `docx-conformance/tests/it/files.rs` (8): write round trips, `.dotx` and `.dotm`, `.docm`
  macros through an edit, RTF (named `.rtf` and `.doc`), `.doc` refusal, OpenDocument behind
  its flag, native to `.docx` read back.
- Word 16 (macOS) opens the packages written for the RTF, OpenDocument, template and native
  fixtures and saves them as PDF with their text (`scripts/word-pagination-probe.sh`).
- Bundle: `packages/doc-bundle/test/headless/files.spec.ts` (7) on the real engine; fixtures
  `template-letter.dotx`, `macro-letter.docm`, `memo.rtf`, `minutes.odt`, `legacy.doc`.

## Related

- [ADR 602](602-save-back-is-a-byte-splice.md), [ADR 610](610-save-back-across-sessions-and-new-parts.md)
  — save-back, which the converted package goes through
- [ADR 606](606-skeleton-is-a-native-document.md) — the skeleton the opened file is poured into
- editor ADR 293 — a template opened as a document says so
