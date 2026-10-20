# ADR 261 — Insert ▸ Rectangle and Ellipse draw what the drawing tools draw

- **Status:** Accepted 2026-10-20.
- **Scope:** `apps/canvas/src/insert-commands.ts` (`paged.insert.rectangle`,
  `paged.insert.ellipse`), the graphic default in `packages/tools/src/handlers/shared.ts`, the
  parity suite's `insertFrame/command` and `insertOval/command` cases.

## Context

Finding PAR-6: Insert ▸ Rectangle and Insert ▸ Ellipse (the menu command, and
`editor.runCommand` of it) make the frame with a 1 pt `Color/Black` stroke, while `insertFrame`
and `insertOval` on every other surface (the wire, `host.objects`, `paged.insertFrame`,
`paged invoke`, MCP) make it unstroked. The finding asked for one object from every surface:
either the engine applies the default, or the menu does not.

In InDesign a shape drawn with a tool takes the `[Normal Graphics Frame]` object style (no fill,
a 1 pt black stroke), while placed graphics and frames made by import or by plugin output do
not gain an outline. The editor already draws that distinction (`shared.ts`, "The graphic
default"): the drawing tools paint their own shape in the insert's batch, only while the
document has no defaults of its own, and the primitive inserts stay unpainted because Place,
plugin output (chart bars, barcode bars, web frames) and scripts mint through them.

## Decision

- The Insert menu's Rectangle and Ellipse are the drawing tools reached from a menu: they make
  the tool's shape, painted as the tool paints it. They are not the `insertFrame` /
  `insertOval` primitive under another name.
- The primitive stays unpainted on every surface. Neither side changes.
- PAR-6's Expected ("the same frame from the menu as from host.objects") is wrong on
  reflection. The parity suite keeps its `insertFrame/command` and `insertOval/command` cases,
  and their `ui.command` / `automation.command` doors stay marked, now as this documented
  difference rather than a defect: a change that made the two agree would fail them and come
  back here.

## Consequences

- No product change. The conformance index records PAR-6 as decided by this ADR.
- A script or plugin that wants the drawn look applies the stroke itself, as an InDesign script
  sets `strokeColor` and `strokeWeight` on what it adds.
