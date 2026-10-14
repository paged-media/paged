# ADR 707 — A deck's embedded fonts are decoded here and given to the document within their licences

- **Status:** Accepted 2026-10-14.
- **Scope:** `pptx-fonts`, `pptx-import` (`fonts`), `slide-js`, `packages/slide-bundle` (`fonts.ts`)

## Context

PowerPoint can embed the fonts a deck uses ("Embed fonts in the file"). Each face is a part
`ppt/fonts/fontN.fntdata` listed per typeface and style in `p:embeddedFontLst`. The parts are
Embedded OpenType (EOT): a little-endian header with the face's names and its embedding
permissions (a copy of OS/2 `fsType`), then the font data, which PowerPoint compresses with
MicroType Express (MTX). Every part PowerPoint wrote in the decks examined, for Windows and Mac,
sets the compressed flag; a deck saved with PowerPoint's default embeds subsets.

The importer read the list and used none of it: text in an embedded font was drawn in a substitute
and flagged as missing. Since 2026-10-12 the import named each such font. Using the faces needs a
MicroType Express decoder and a door through which a plugin gives the document a face.

## Decision

1. **The decoder is ours, in Rust** (`pptx-fonts`, under the workspace's licence), written from
   the two W3C member submissions of 5 March 2008: *Embedded OpenType (EOT) File Format* (header
   versions 0x00010000, 0x00020001 and 0x00020002, XOR obfuscation) and *MicroType Express (MTX)
   Font Format* (LZCOMP with its three adaptive Huffman trees and run-length stage; the Compact
   Table Format: `glyf` from contour triplets, push data and instructions in separate blocks,
   `loca` rebuilt, `cvt ` from deltas, `hdmx` and `VDMX` from their prediction errors). No other
   decoder's code is used. A bare OpenType part, which some producers embed instead, is taken as
   it is.

2. **Hostile input is the normal case.** Every read is bounds-checked; allocations are bounded by
   the format's field widths and by a 32 MiB limit on any decoded block or face; a malformed part
   is a typed error, never a panic. A table that cannot be rebuilt (`hdmx`, `VDMX`: hinting caches
   a renderer can do without) is left out and noted rather than failing the face.

3. **The licence decides, before anything is decompressed** (EOT §2.3, §4.1; the least
   restrictive of several set bits applies):

   | `fsType` | Meaning | Here |
   |---|---|---|
   | no restriction bit | installable | used |
   | `0x0008` | editable: loaded while the document is open, editing allowed | used |
   | `0x0004` | preview and print: the document must be read-only | **not used**: a deck opens for editing |
   | `0x0002` alone | restricted | not used |
   | `0x0200` | bitmap embedding only: the outlines may not be used | not used |
   | root string | tied to named web addresses | not used |

   A face that is not used is never decompressed; the import names it, the reason and that its text
   is drawn in a substitute. Preview-and-print faces become usable when a read-only view exists
   (the slideshow, M5).

4. **The faces reach the document through the host's document-font door**
   (`host.assets.registerDocumentFont`, plugin-sdk ADR 328), before the document opens, so it lays
   out in them from the start. The door fills a gap and never replaces a face: a font the machine
   or the document already has wins over the deck's copy, as in PowerPoint. A face the host
   refuses (its per-face budget) and a host without the door are reported in the import's
   diagnostics. The bundle declares the `fonts` asset; it reaches the door structurally and probes
   `supports("assets.documentFont@1")`, so it runs on hosts from before the door.

5. **The faces are not copied into the document.** A face lives for the editing session (the
   door's lifetime). The source deck the importer keeps as a container part still holds them, so a
   deck document opened again (or already open when the plugin activates) gets them back from it
   (`embeddedFonts` in slide-js, at `document.onDidOpen`).

## Consequences

- The engine wasm grows by 55 KB (1 508 621 → 1 563 787 bytes; gzipped 455 961 → 479 063).
- Editable embedding asks that a face be dropped when its document closes. The door keeps faces
  for the session, so a document opened later in the same session could resolve a family only an
  earlier deck embedded. Dropping them needs a per-document lifetime in the door.
- A subset face holds only the characters the deck used: a character typed later is missing from
  it, as in PowerPoint.
- Fonts are authored into fixtures through PowerPoint (ADR 705): `embed-resave.applescript` saves a
  deck in place, which keeps its "embed fonts" setting (a save under a new name drops it).
