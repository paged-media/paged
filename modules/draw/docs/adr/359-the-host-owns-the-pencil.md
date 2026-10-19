# ADR 359 — The host owns the Pencil; it runs this repo's PencilMachine

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/draw-bundle` (tools, manifest, tool options, the retired
  `handlers/pencil.ts`), `packages/draw-tools/src/pencil-machine.ts`; in the editor
  `packages/tools/src/handlers/pencil-tool.ts` and `built-in-tools.ts`

## Context

There were two Pencils. The editor's `paged.tool.pencil` (`n`, its own `pencil` slot) simplified
the samples with RDP and sent the corners with `insertPath { smooth: true }`, so the engine fitted
the curve. This bundle's `media.paged.draw.tool.pencil` (`shift+n`, in the pen flyout) ran
`PencilMachine` in `draw-tools`: decimation, RDP, closing the contour when the pen lifts near
its start, a Catmull-Rom fit in TypeScript, and three tool options (fidelity, smoothing, close
distance). [ADR 352](352-basic-operations-belong-to-the-host.md) recorded the duplicate and that
the repository did not say why it existed.

The host's Pencil had a known bug: a click committed a path of two coincident anchors (GT-2).
The machine cancels a stroke that simplifies to fewer than two anchors.

## Decision

- **One Pencil, the host's.** Authoring a freehand path is a basic operation, as authoring a path
  with the Pen is (ADR 352). The editor keeps `paged.tool.pencil`; this bundle no longer
  contributes a Pencil tool, and its handler and `PENCIL_OPTIONS` are deleted. The draw solo
  profile already lists the host's Pencil among the primitives it builds on.
- **One implementation, the machine.** The host's handler is a thin shim over `PencilMachine`
  (through `@paged-media/draw/machines`), as the host's Pen is over `PenMachine`. The machine is
  run with `smooth: false`: it returns the simplified samples as corner anchors, and the default
  "Smooth curves" sends them with `smooth: true` so the engine fits the curve
  ([ADR 353](353-path-algebra-runs-in-the-engine.md)). "Corner points" commits the polyline.
  The TypeScript Catmull-Rom fit stays in `draw-geometry` for the brushes, which compose the
  machine.
- **The options move with it**, as host tool options under `paged.tool.pencil`: fidelity
  (default 1.5 px, the host's value), smoothing, and close distance (default 8 px, this bundle's
  value). The handler seeds unset defaults into the host's store when the tool activates, so the
  popover shows the values the next stroke uses.
- **Pressure.** An open stroke drawn with a pen gets the variable-width outline in the insert's
  batch, one undo step, from the machine's per-anchor pressures. A closed stroke does not: the
  engine's variable outline is open-path only.
- **The eyedroppers and the scissors stay two.** The host's Eyedropper samples the composited
  pixel and this bundle's samples element properties; the host's Scissors cuts at an anchor and
  this bundle's cuts anywhere on a segment. Each pair is two modes, not a duplicate.

## Consequences

- The rail has one Pencil. `shift+n` is free. The click bug (GT-2) is fixed, and its expected
  failure is now an ordinary test.
- Tests moved with the tool. The host's unit tests (`packages/tools/test`) pin the commit and
  the three options; the editor's headless tier (`apps/canvas/tests/headless/pencil.test.ts`)
  drives the live handler against the real engine: preview, selection, the graphic default, one
  undo step, the pen outline, and each option's effect on the stored geometry. This bundle keeps
  the machine's unit tests and the headless proof that the engine accepts the machine's commit.
  The bundle's pencil-only perf budgets went with its handler; the shared preview budgets now
  run on the Paintbrush.
- A document drawn with the old bundle Pencil is unaffected: the tool wrote ordinary paths.
- Not done: the editor's headless tier has no fixture with its own `[Normal Graphics Frame]`
  style, so the host Pencil's use of a document's object style is asserted by the fake-editor
  tests and the Playwright `tool-graphic-default` spec only.

## Related

- [ADR 350](350-three-typescript-layers.md) — host-agnostic machines; the host's tools are shims
- [ADR 352](352-basic-operations-belong-to-the-host.md) — what the host owns
- [ADR 358](358-one-snapper-the-engine-resolves.md) — the other tool shared with the host
