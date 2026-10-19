# ADR 247 — Stored settings are read with a shape check

- **Status:** Accepted 2026-10-19.
- **Scope:** `packages/shell/src/lib/stored-settings.ts` (`readStoredShape`, `oneOf`, `isRecord`,
  `isStringArray`, `parseStored`) and its readers: the cockpit's per-mode tabs
  (`cockpit-persistence.ts`), the tool rail's last-used faces (`ToolRail.tsx`), the PDF export
  form (`ExportPdfDialog.tsx`) and the image export settings (`export-targets.ts`).

## Context

Settings in `localStorage` outlive the code that wrote them and can be edited by hand. Four
readers spread the parsed value over their defaults or used it as is: a stored
`rightTabs: 5` broke the right dock and the Window menu (SH-101), a stored DPI of `"huge"` or
`100000` reached the image export (SH-102), `standard: "bogus"` reached `exportPdf` (SH-103),
and a stored `null` made the tool rail fail to mount (SH-104).

## Decision

A stored value is taken field by field, and only where it has the shape the field allows:
an enum field only one of its members, a number a finite number in its range, a list a list
of the right type, and a field with no check of its own a value of its default's type.
Anything else, and anything that is not a plain object, reads as the default. A cockpit mode
entry of the wrong shape is dropped, so that mode falls back to its slot seed.

## Consequences

SH-101 to SH-104 close. A reader that adds a stored setting uses `readStoredShape`; settings
stay a convenience: a bad value costs the user a default, never a broken surface.
