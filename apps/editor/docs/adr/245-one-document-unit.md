# ADR 245 — One document unit for every length

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/ui/src/inputs/document-unit.ts` (the unit, the formatter, the
  parser), `LengthInput` / `BoundsInput` / `NumberInput` (`parse`), the shell's
  `LengthLeaf` and `PropertyField`, the control bar's geometry fields, and the readouts in
  Properties, Pages, the document map, Align, Output Readiness and Info.

## Context

Lengths were formatted per surface. The control bar, Properties and every schema field read
in points; the Properties page summary read the page size in inches, the Align panel's
spacing in millimetres, the Prepress checklist "Bleed 3 mm" (UX audit F-39, findings R12:
PN-24, PN-260, PN-303). There was no unit to choose, and a typed unit was not read: "10mm"
in a margin field was written as 10 pt (PN-204). The engine models no measurement unit
(`documentMeta().units` is empty; IDML's `ViewPreference` units are not parsed).

InDesign's model: Preferences ▸ Units & Increments sets the ruler unit, and every geometry
field shows it; a value typed with a unit ("10mm", "1in", "6p") is converted, a bare number
is read in the current unit. Type size, leading and stroke weight have their own units, by
default points, apart from the ruler unit.

## Decision

1. **One unit.** `documentUnit()` / `useDocumentUnit()` name the unit geometry is shown in:
   points, picas, inches, millimetres, centimetres or pixels, points by default. It is an
   editor preference (setting `paged.units`, persisted in `localStorage`, a stored value that
   is not a unit reads as points), chosen in Document Setup's Units row. The document model
   keeps points; the unit only decides how a length is shown and read. Reading a
   document's own unit (IDML's `ViewPreference`) is left to the engine; when it lands it
   becomes that document's default.
2. **One formatter, one parser.** `formatLength`, `formatLengthPair` and `lengthIn` show
   points in a unit; `parseLengthText(text, unit)` reads a typed length into points: an
   explicit suffix (`pt`, `p`/`pc`, `in`/`"`, `mm`, `cm`, `px`) converts, a bare number is in
   the unit, a comma decimal is read. Every length field and readout uses them; no surface
   formats a length itself.
3. **Geometry follows the unit, type and stroke stay in points.** `LengthInput` (and so
   every schema length field and `BoundsInput`) shows the document unit unless its caller
   names one; `PropertyField` names points for a size, leading, baseline shift or weight
   path, as InDesign's Type and Stroke units do. The control bar's X, Y, W and H follow the
   unit; its stroke, size and leading stay in points but read a typed unit too.

## Consequences

- Choosing millimetres re-renders every open length field; a step (arrow key, scrub) is one
  shown unit.
- `LengthUnit` gains `pc`.
- A field that shows a length outside the shared path is a bug of this ADR's kind.
