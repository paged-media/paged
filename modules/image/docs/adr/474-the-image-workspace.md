# ADR 474 — The image workspace: guides, count, notes and slices in the stack; rulers, guides and grid are the host's

- **Status:** Accepted, 2026-10-28.
- **Scope:** `image-js/src/workspace.rs`, `image-js/src/layers/workspace_ops.rs`,
  `image-js/src/layers_persist.rs`, `image-js/src/lib.rs` (the workspace doors),
  `engine/core/crates/paged-psd/src/model/resources.rs` (resource 1032),
  `glue/src/workspace*.ts`, `glue/src/panels/sections/workspace-section.tsx`.
  Contract: extensions ADR 3XX (the workspace and readout lanes). Plan WP5.12 (I-69).

## Context

Photoshop users measure in pixels from the image's corner, drag guides out of the rulers,
snap marquees and crops to them and to a grid, count things, pin notes, cut slices and read
the pixel under the cursor in the Info panel. The host already had rulers, guide dragging,
a document grid with snapping (editor ADR 287) and an Info panel (WP4.5), all about the page.

## Decision

- **Document state in the stack.** Guides, count groups and marks, notes and slices are a
  `Workspace` in the layer stack's snapshot, so each change is one structure step on the one
  undo list (ADR 463), and a canvas operation moves them with the point map the paths use
  (a guide that stops being axis-aligned is dropped, a slice is clipped). They persist as a
  tagged trailing block of the layer manifest (`"PGWS"`, after ADR 470's `"PGMK"`), absent
  when empty, so older manifests read unchanged.
- **PSD.** The guides travel as Photoshop's grid-and-guides resource (id 1032: version,
  grid cycle, then i32 locations in 1/32 px and a direction byte). `paged-psd` types it
  losslessly; it is read when a PSD opens (not an undo step) and written before a PSD save.
  Writing the guides a file already has changes nothing, so an unedited PSD still saves
  byte for byte (§10.4). The Photoshop oracle (`scripts/photoshop/probes/guides.jsx`,
  replayed by `image-conformance/tests/it/psd_guides_photoshop.rs`) pins the layout: the
  positions read exactly and the canonical re-encode is Photoshop's own bytes. Count (1080), notes and slices (1050) are not written to PSD yet.
- **Host chrome stays the host's.** The rulers, the guides' drawing and dragging and the grid
  are the editor's, driven through the binding provider's workspace lane: the image answers
  with its frame (origin, pt per pixel, size), the ruler unit (px, in, cm, mm at the image's
  ppi) and its guides, and takes guide edits back. The host hands the image its grid and snap
  state; the image's own tools (marquee, crop, Ruler, Slice) snap to guides, canvas edges and
  that grid within the host's tolerance.
- **Info.** The readout lane gives the Info panel the pixel under the cursor (read from the
  composite), the selection's size and the Ruler's distance and angle.
- **Tools.** Ruler, Count and Note join the Eyedropper's flyout and Slice the Crop tool's,
  without keys (the registers are full). Straighten to ruler is the existing arbitrary canvas
  rotation. The host's Note tool annotates text stories, so the image's notes are its own.
- **View settings** (ruler unit, Show / Lock / Snap to Guides) are session state, as
  Photoshop's are; Show Grid and Snap to Grid are the host's View menu.

## Consequences

The workspace survives commit and reopen with the layers and round-trips guides through
PSD. Count groups, notes and slices live only in the stack until the PSD descriptor writer
(WP5.15) can write their resources. Slice export saves one PNG per slice through the host's
file saver; a zipped export waits for the shared zip writer (plan Phase 11, C13).
