# ADR 1212 — Editing aids and Proof view

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/shell/src/state/view-toggles.ts` (the aids' toggles and
  `paged.view.editingAids`), `state/editing-aids.ts` (the aids' names, the overlay rule),
  `overlays/overlay-host.tsx` (where the rule is applied), the new overlays `frame-edges.tsx`,
  `baseline-grid.tsx`, `overset-markers.tsx` and `proof-surface.tsx`, the aids' existing overlays
  (`margin-guides.tsx`, `guide-overlay.tsx`, `ruler-guides.tsx`, `thread-lines.tsx`, and
  `page-decorations.tsx` and `table-cell-overlay.tsx`, which lose their own screen-mode checks),
  `state/view-settings-sync.tsx` (guide snapping), `chrome/EditingAidsControl.tsx` and
  `chrome/ModeSwitcher.tsx` (the bottom bar's control), `cockpit/canvas-frame/ProofBadge.tsx` and
  `cockpit/CockpitLayout.tsx`, `state/messages.ts` (the screen mode's name);
  `apps/canvas/src/view-commands.ts` (the aids' commands, View ▸ Editing aids, View ▸ Proof
  view), `app-commands.ts` (Show text threads moved), `app/mount.tsx` (the overlays),
  `cockpit/control-bar.tsx` (the Proof chip).
- **Implements:** the redesign strategy's §4.1 (the canvas's four levels and an Editing aids
  control) and §4.5 (a Proof surface); the interaction contract's UXI-GDE-003, UXI-GDE-004 and
  UXI-OVR-002 ([ADR 1200](1200-the-interaction-contract-is-adopted.md)). Amends
  [ADR 287](287-view-modes.md).

## Context

What the canvas drew over the page was decided overlay by overlay. The margins and columns, the
ruler guides, the page captions and a table cell's outline each checked the screen mode
themselves and hid in any mode but Normal; nothing else did, so the Preview screen mode still
showed the selection's handles, the threading ports, the document grid, the data and field
markers and the comment pins. None of the structural aids could be switched off on its own: the
margins and the guides were always on in Normal, and only the text threads had a View toggle (in
memory, lost on reload). Frame edges, a baseline grid and overset markers on unselected frames
were not drawn at all; the overset plus showed on the one selected frame only. Hidden guides
still snapped, because the engine was always told `guides: true`. The Preview screen mode had no
idea where the publication ended: the CPU lane clips a page's raster at the trim while the GPU
lane lets bleed artwork run onto the pasteboard, and no overlay marked the trim or the bleed.

## Decision

**Four levels, one rule.** The canvas draws the document, then the **editing aids** (the
nonprinting structure), the **editing chrome** (the selection and its handles and ports, path
points, the live-shape widgets, the content grabber, a table cell's outline, page captions, the
document grid, data and template field markers, comment pins, the markup margin band) and the
**gesture feedback** (the marquee, a tool's preview, snap lines, the caret). Which overlays draw
is decided in one place, the overlay host, by `overlayShown(id, toggles, screenMode)`
(`state/editing-aids.ts`): an aid's overlay while its aid is on and the view is not a proof; the
editing chrome outside a proof; the proof surface only in one; everything else always. Overlays
are classified by their contribution id in that file; an overlay no longer checks a mode of its
own. A plugin's overlay is not classified and keeps drawing.

**Eight aids, each remembered on its own.** The toggles live with the View menu's other toggles
(`view-toggles.ts`); the aids are remembered as one editor preference, `paged.view.editingAids`,
read field by field (ADR 247). The other view toggles stay in memory.

| Aid | Default | Drawn by |
| --- | --- | --- |
| Frame edges | off | `frame-edges.tsx`: every top-level page item's edge (the spreads' members, one batched `elementGeometry`), through its turn, violet and faint |
| Margins and columns | on | `margin-guides.tsx` |
| Ruler guides | on | `guide-overlay.tsx` (editor), `ruler-guides.tsx` (viewer) |
| Baseline grid | off | `baseline-grid.tsx`: the document's grid preferences (`DocumentMeta.baselineGrid*`, relative to the page or the top margin), InDesign's 36 / 12 pt without them |
| Text threads | off | `thread-lines.tsx` (the old View ▸ Show text threads, same command) |
| Overset markers | on | `overset-markers.tsx`: the red plus at the out port of every frame whose story runs over, selected or not |
| Hidden characters | off, **disabled** | not supported yet: the engine does not report where spaces, tabs and returns are |
| Nonprinting items | on, **disabled** | not supported yet: the engine always draws nonprinting items on screen (and leaves them out of export); hiding them needs a view option the engine's `ViewSettings` lacks |

The two engine gaps are visible, disabled entries with their reason (ADR 207), never toggles that
do nothing. The aids are in View ▸ Editing aids (a submenu with the extras; View ▸ Show text
threads moved into it as Text threads) and in a compact control in the bottom bar (an eye button
before Back and Forward), one checkbox per aid and Proof view below them. The commands are
`paged.view.toggleFrameEdges`, `…MarginsColumns`, `…Guides`, `…BaselineGrid`,
`paged.view.toggleTextThreads` (unchanged), `…OversetMarkers`, and the disabled
`…HiddenCharacters` and `…Nonprinting`. None is a document change or an undo step.

**Guides are named apart, and hidden guides do not snap (GDE-003, GDE-004).** The document's
ruler guides are their own aid, "Ruler guides", apart from margins and columns and from the
document grid (ADR 287's Show grid). With the aid off the engine is told not to snap to guides:
nothing on screen would say why an object jumped. The grid keeps its own Show grid and Snap to
grid, which are independent by ADR 287's choice.

**Proof view is the Preview screen mode, completed.** View ▸ Proof view, the bottom bar's
control, the control bar's Proof chip and InDesign's W all switch the screen mode between Normal
and Proof view (the mode's name was "Preview"; the Bleed, Slug and Presentation modes are proofs
too). In a proof every aid and all the editing chrome are hidden, the aids keep their states for
when the user comes back, and the selection is never touched: what was selected stays selected,
its handles return on leaving. The proof surface (`proof-surface.tsx`) masks the pasteboard in
the canvas's surround colour outside what the publication shows — the trim in Proof view, the
trim grown by each page's bleed in Bleed and Slug, with the trim dashed — and draws crop marks at
the trim's corners, so the mask, not the lane's raster, says where the page ends. A badge over the
canvas names the proof, the current page's trim and bleed and what the mask lets through, says
that screen colours are not a colour-managed proof, and leaves Proof view in one click. Colour
fidelity stays Proof colors' (soft proofing); Proof view promises none.

## Consequences

- `apps/canvas/tests/e2e/editing-aids.spec.ts`: the aids are independent switches in the control
  and the menu, remembered across a new editor on the page, the unsupported two disabled with
  their reason; Proof view hides the handles, the frame edges and the margins, shows the trim
  surface and its badge, keeps the selection and the aids' states, and leaves by the badge, the
  control and W; the document and the history unchanged. `packages/shell/test/settings/view-toggles.test.ts`
  (the defaults, the stored aids and their shape check, the overlay rule) and
  `test/overlays/editing-aids.test.ts` (frame edges through a turn, the grid's lines, the proof
  box). The menu matrix lists the new rows.
- With every aid on its defaults the canvas looks as before, except that an overset frame shows
  its red plus without being selected.
- **Engine gaps**, recorded for the engine's track: hidden characters need the positions of
  spaces, tabs, returns and other invisibles (a query or a side channel of the composer's glyph
  runs); hiding nonprinting items on screen needs a view option that rebuilds the live display
  list with `omit_nonprinting` (a build option, unlike ADR 287's raster views); a proof without
  the GPU page border and the missing-image and substituted-font markers needs the same kind of
  option; the CPU lane's trim clip and the GPU lane's bleed spill should agree (the mask covers
  the difference today). Per-frame baseline grids are not on the wire.
- The frame-edge and overset overlays read the document only while their aid is on; with an aid
  off its overlay is not mounted and costs nothing.

## Related

- [ADR 287](287-view-modes.md) — amended: the View menu's toggles gain the aids; Preview is
  Proof view.
- [ADR 207](207-honest-seams.md) — the disabled aids.
- [ADR 247](247-stored-settings-are-shape-checked.md) — the stored aids.
- [ADR 1211](1211-navigation-history-and-one-current-page.md) — the bottom bar the control joins.

## Amendment 2026-11-14 — Data bindings is an editing aid

paged.data's binding badges (the data markers) join the aids as **Data bindings** (data ADR 566):
in View ▸ Editing aids and the bottom bar's control, remembered in `paged.view.editingAids` with
the others, drawn by the same rule (`paged.overlay.dataMarkers`). The command keeps its id,
`paged.view.toggleDataMarkers`; View ▸ Show data markers left the feature ids with a deprecation
window, 0.80 to 0.82.
