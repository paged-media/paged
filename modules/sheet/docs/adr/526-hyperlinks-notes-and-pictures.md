# ADR 526 — Hyperlinks, notes and pictures: authored by splice, drawn on both surfaces

- **Status:** Accepted, 2026-10-24. Extends 510 (the frame's two surfaces) and 517 (protection).
- **Scope:** `sheet-xlsx/src/{links,comment_edit}.rs`, `sheet-xlsx/src/parts/pictures.rs`,
  `sheet-js/src/core/annotations.rs`, `sheet-grid` (`GridLink`, `GridPicture`), the host model's
  `table-pictures.ts` and `grid.ts` (`linkAt`, `pictureBox`), the grid painter and the frame
  surface's image cache.

## Context

Hyperlinks and notes round-tripped as opaque bytes and could not be written; a note showed as an
indicator only. Pictures (drawing pictures and images placed in cells) were not read at all, so
neither the grid nor the page showed them.

## Decision

1. **Hyperlinks** are read from the worksheet's `<hyperlinks>` child and its relationships. A
   write rewrites that child only: a kept link keeps every attribute (`xr:uid` included), a new
   one gets an external relationship (`TargetMode="External"`) when it has a URL, and a
   relationship no remaining link names is removed. Setting a link replaces any link over the
   range's first cell and gives the cells Excel's `Hyperlink` cell style, as Excel's Insert Link
   does. The cell's own value stays what Excel shows; `display` is recorded, not written into the
   cell. A protected sheet refuses unless it allows inserting hyperlinks.
2. **Notes** are two things in a package and are written together: the `<comment>` in the
   sheet's comments part and the VML shape (`ObjectType="Note"`, its row and column) in the
   legacy drawing the worksheet names with `<legacyDrawing>`. A new note creates the parts, their
   relationships and content types (`Default Extension="vml"`) when the sheet has none; a delete
   takes both out, and the parts when nothing is left in them. Other comments keep their content
   (rich text included) and other VML shapes keep their bytes. Shape numbers continue the
   drawing's own; a new drawing takes the next free `idmap` block of the workbook.
3. **Threaded comments** stay preserved and are never rewritten. Excel keeps a legacy note for
   each thread, so the note of a cell that carries a thread is refused (editing it alone would
   desynchronise the two); `list_comments` says which notes belong to a thread.
4. **Pictures** are read on demand, nothing stored: the `xdr:pic` anchors of the sheet's
   drawings (two-cell, one-cell, absolute) and images in cells, followed through value metadata
   → `XLRICHVALUE` → rich value → `_rvRel:LocalImageIdentifier` → `richValueRel.xml` → media.
   The session places them in sheet points (hidden tracks take no room) and serves a picture's
   bytes by its media part name; nothing reads outside `xl/media/`.
5. **The grid** gets one clickable rect per visible linked cell (`GridScene.links`; `linkAt`
   finds it) and the pictures that show in the viewport (`GridScene.pictures`). The painter draws
   a picture once the surface has decoded its bytes (`createImageBitmap`, kept per surface); an
   image in a cell is fitted into the cell keeping its aspect ratio.
6. **The page** gets the pictures anchored in a tracks or frame page's cells as `pictures` on the
   lowered content, each with its image as a `data:` URI (the wasm door attaches them, so the
   placement costs no extra engine call). The bundle places each as an image frame over the
   table, with the data bars, and the table's refresh replaces them like the bars.

## Consequences

- Excel 16 opens what Paged writes after adding, editing and deleting notes and links, on a new
  workbook and beside an existing thread and picture, without a repair (the open-check lane:
  `w2-annotations-new`, `w2-annotations-edit`, `w2-notes-delete`).
- A link in a placed table is not clickable on the page: the wire's `insertHyperlink` takes a
  story range with no table-cell qualifier, so a link inside a table cell cannot be made. The
  grid has the rects; the click behaviour is left to the frame surface's UI.
- Pictures are not authored (insert, move, delete); a paginated chain draws no pictures (as no
  bars). Linked pictures (an external target) have no bytes and are skipped.
