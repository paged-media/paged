# PDFium (`pdfium.esm.js`, `pdfium.esm.wasm`)

The PDF reader of this bundle ([ADR 655](../../../docs/adr/655-pdfium-reader.md)): PDFium
compiled to WebAssembly with Emscripten, committed as a prebuilt binary. It is third-party
code and is not under this package's licence.

| | |
| --- | --- |
| What | PDFium, the PDF library of the Chromium project |
| Upstream | <https://pdfium.googlesource.com/pdfium/> |
| Built by | the `paulocoutinhox/pdfium-lib` project (<https://github.com/paulocoutinhox/pdfium-lib>), its WebAssembly release |
| Added | 2026-07-24, with the move from pdf.js to PDFium |
| `pdfium.esm.wasm` | 5 218 943 bytes, SHA-256 `f3fe52ae7f150e912a8379ec4478cac9c11b4135dc56fdc039b0ff885f1c0981` |
| `pdfium.esm.js` | 253 501 bytes, SHA-256 `2dfd76eaee7e3466b13b0ad067055be1fa264e8f8a609a8d3e065e1c005e39f0` |

## Version: not recorded

Which `pdfium-lib` release, and so which PDFium revision, these files are is **not known**.
No file, lockfile, script or commit message in this repository names it, the glue file has
no version or licence header, and the binary carries no version string that was found. The
checksums above identify the files; matching them against the `pdfium-lib` releases
published before 2026-07-24 would establish the version.

## Licence

PDFium is distributed by its authors under the terms of the `LICENSE` file of its
repository (BSD-3-Clause and Apache-2.0 terms, depending on the revision), and it bundles
third-party libraries with licences of their own (FreeType, libjpeg-turbo, OpenJPEG, zlib,
Little CMS, Anti-Grain Geometry, among others), listed in that file and in the
`third_party` directory of the PDFium source. `pdfium-lib`, the build project, is MIT.

**Missing:** the licence texts themselves are not in this directory, because the revision
they belong to is not known. Until the version is established and the `LICENSE` of that
revision is copied here, a distribution of this bundle does not carry PDFium's notices.

## Replacing the binary

Take both files from one `pdfium-lib` release, and in the same change record here the
release tag, the PDFium revision it names, the download URL and the new checksums, and add
that release's licence file next to them.
