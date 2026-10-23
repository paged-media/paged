# Adding fonts — a proposal

October 2026. Proposal, not built. Where it is built, an ADR decides the details.

## The gap

The editor cannot be given a font. The engine resolves a run's `AppliedFont` against faces that
someone registered (`CanvasClient.registerFont` for the session, `registerDocumentFont` for the
open document, plugin-sdk ADR 330), and the only faces anyone registers are the bundled default
family (Inter roman and italic) and the faces a plugin brings for its own scene layers. A document
that names Minion or a brand face lays out in the fallback; the Fonts panel lists the family as
missing and Problems says so (ADR 261), but nothing in the editor lets the user fix it. IDML
carries fonts by name only, so an InDesign package's `Document fonts/` folder is the one place a
user has the files, and nothing reads it.

## What the user can do

1. **Drop a font file** (`.otf`, `.ttf`, `.woff`, `.woff2`; `.ttc` and `.otc` give every face
   inside) on the window, or choose **Type ▸ Add fonts…** (a file picker that takes several
   files). Dropping a font is not placing: `FileDrop` routes font MIME types and extensions to
   the font path, never to Place.
2. **Fonts panel ▸ Missing ▸ Locate…** on a missing family: the same picker, with the family's
   name in the title. A face that matches by family and style resolves the missing rows at once.
3. **Use a font installed on this computer** (Chromium's Local Font Access API,
   `window.queryLocalFonts()`, behind its permission prompt): Fonts panel ▸ Missing ▸ _Use
   installed font_, which asks for the one family by name, never the whole font list. Where the
   API is missing (Firefox, Safari) the action is absent and the panel says to add the file
   instead.
4. **Open an InDesign package folder** (or a zip of one): the faces in its `Document fonts/`
   register with the document, the way InDesign activates them for that document only.

Every path ends in the same call: parse the face's `name` table for family and style (in the
worker, which already reads fonts), then `registerDocumentFont(family, bytes, style)`. The pages
lay out again (`fontRegistered` carries the pages), the Fonts panel's row turns green, and the
Problems entry closes. One undo step is not needed: adding a font changes no content.

## Where the font lives

- **In the document, by default.** The face is written into the `.paged` container as a part of
  its own (`fonts/<family>-<style>.<ext>`, listed in the manifest with its family, style and
  hash), so the document opens with its fonts on another machine, as an InDesign package does.
  On open, the editor registers every face the container holds before the first layout.
  Exporting IDML leaves them out (IDML has no place for them); packaging (`paged package`)
  copies them into `Document fonts/`.
- **In the user's library, on request** ("Keep for all documents" in the add dialog): the
  bytes go to the origin's storage (OPFS, with IndexedDB as the fallback) and register as
  session faces on every start. A library face is never written into a document unless the
  document uses it and the user saves, so a document never carries fonts it does not use.
- **Never on a server** in this proposal. A team font library is a later, separate decision.

## Licence

Embedding a font in a file is a licence question the editor cannot answer for the user, but it
can read what the font says about itself:

- The face's OS/2 `fsType` decides what is allowed. _Restricted_ (2): the face is used for this
  session only, never written into the `.paged` file, and the add dialog says why. _Preview &
  print_ (4) and _Editable_ (8): written into the file. The PDF export already follows the same
  bits for embedding; `paged package` already refuses Restricted faces (engine `package.rs`).
- The add dialog carries one line, always: "Fonts are licensed software. Add only fonts your
  licence lets you use and share with this document." No checkbox to tick: the line informs,
  it does not shift responsibility.
- Local fonts read through the Local Font Access API follow the same rules; a face the system
  marks Restricted is used for display only.

## Limits and costs

- Memory: each face is held twice today (the client's registry, for re-registering after a
  reload, and the engine's). A 10 MB CJK face costs 20 MB; the WASM budget (120 MB app-wide) is
  not touched, but the add path should refuse faces over a stated size (e.g. 32 MB) with a
  message rather than stall.
- Variable fonts register as one face covering their axes, as Inter does now; named instances
  map to styles through `fvar`.
- WOFF2 needs a decoder in the worker (a small Rust crate); the rest the engine reads as is.

## Pieces to build

| Piece                                                      | Where                                            |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Font file detection on drop, Type ▸ Add fonts…             | editor shell (`FileDrop`), app command           |
| Face name parsing (family, style, `fsType`)                | engine wasm export (reuses the font loader)      |
| Fonts panel _Locate…_ / _Use installed font_               | `apps/canvas/src/panels/fonts-panel.tsx`         |
| `fonts/` parts in the `.paged` container, register on open | editor save/open path, engine container manifest |
| User library (OPFS)                                        | editor app, a per-origin store                   |
| `Document fonts/` on package open                          | editor open path                                 |
| WOFF2 decode                                               | engine                                           |

The first slice worth shipping is the drop/picker path with document-scope registration and the
`fonts/` parts, with the `fsType` rule: it closes the missing-font loop for the files the user
has, and every later path reuses it.
