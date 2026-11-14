# ADR 1226 — Snapping says what it snaps to

- **Status:** Accepted 2026-11-14 (plan task IC8 of [`interaction-plan.md`](../interaction-plan.md)).
- **Scope:** `packages/shell/src/overlays/snap-lines.tsx` (the labels), `packages/shell/src/tools/snap-bypass.ts`
  (the one bypass key), `packages/tools/src/handlers/snapper.ts` (the point-placing tools),
  `apps/canvas/src/ui/ViewportCanvas.tsx` (a move's and a handle drag's modifiers). Builds on
  engine ADR 1300 and the amendment to 125 (protocol 79: `SnapLine.targetKind`, hysteresis,
  the current zoom's tolerance, ranking).

## Context

The interaction specification asks a snap to say what it snaps to (`UXI-SNP-002`): a line that
appears while dragging is only useful when the user can tell a page centre from a margin, a
column, a guide or another object's edge. Protocol 79 gave every snap line its target's kind
(`guide`, `margin`, `column`, `pageEdge`, `pageCenter`, `grid`, `baseline`, `objectEdge`,
`objectCenter`, `objectPoint`, `equalSpacing`, `angle`, `point`, `pixel`), but the overlay drew
the lines alone; the measurement labels (a distance, an angle) appeared only with View ▸
Measurement labels.

The bypass was two keys: a move read Ctrl (`disableSnap: e.ctrlKey`, after InDesign), the Pen
and Direct Selection read Cmd (after Illustrator). A user who learned one found the other did
nothing (`UXI-SNP-005`).

## Decision

1. **Every snap line names its target**, always, in the user's language (`shell.snap.*`):
   guide, margin, column, page edge, page centre, grid, baseline, edge, centre, point, equal
   spacing, pixel. An angle snap shows its angle. With measurement labels on, the measure
   follows the name (`page centre · 12 pt`). The line carries `data-snap-target` with the
   engine's kind, so tests and assistive tooling read the same fact.
2. **One bypass key**: the platform's primary modifier — Cmd on macOS, Ctrl elsewhere — held
   during a drag or a point-placing tool's sample ignores the snap targets; letting it go snaps
   again, from the same anchor, without a jump (`snapBypassHeld`, the one reader). Shift keeps
   constraining (a constrained angle wins over a snap that would pull the point off it), and
   View ▸ Snap to points still turns snapping off for the point tools.
3. **Hysteresis and the committed position are the engine's**: the overlay draws what the engine
   answered for the last sample, and the committed geometry is the snapped one, exactly (no
   rounding in the editor).

We chose the primary modifier over Ctrl because the point tools already used it, and on macOS a
Ctrl press is the secondary click; we chose one key over a per-tool key because the
specification asks for one (`UXI-SNP-005`).

## Consequences

- `UXI-T12` (`tests/e2e/uxi-snap.spec.ts`): a move snaps its centre to the page centre, the line
  says "page centre", the commit lands exactly on it, and with the bypass held it does not snap.
- A user who held Ctrl to bypass a move on macOS now holds Cmd; Ctrl does nothing there during
  a drag.
- New target kinds from the engine draw a line without a name until `shell.snap` names them
  (the switch's default).
