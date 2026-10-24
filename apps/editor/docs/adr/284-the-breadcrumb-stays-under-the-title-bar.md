# ADR 284 — The edit-context breadcrumb stays under the title bar; full screen carries its own

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/shell/src/chrome/EditContextBreadcrumb.tsx` (the bar `PagedShell` mounts
  under the title bar), `modules/sheet/packages/sheet-bundle/src/surface/sheet-frame-surface.tsx`
  (the full-screen header). Builds on ADRs 281 and 283.

## Context

Entering a frame's content (a sheet grid, a web frame's source, a vector graphic) pushes an edit
context. The shell already shows the stack as a breadcrumb bar under the title bar: one crumb
per level, a click pops back to that level, Esc pops one. When the frame-surface work began, the
plan was to move that trail into the title bar, so that it would still be visible in full
screen. Full screen (ADR 283) then turned the title bar off, so moving the trail would not have
made it visible there.

## Decision

- **The breadcrumb stays where it is.** It is a 28 px bar under the title bar, shown only while
  a context is entered (an honest seam, ADR 207). It is not moved into the title bar: the title
  bar belongs to the editor profile's regions (ADRs 274/275), and the breadcrumb must work in
  profiles without a title bar.
- **Full screen carries its own header.** A surface in the full-screen presentation hides the
  shell's chrome, the breadcrumb included, so it shows where you are itself. The sheet's header
  reads "Page › Sheet frame › ‹sheet›". It has a "Back to page" button
  (`requestPresentation("frame")`, the same as Esc) and, where the browser allows it, a "Whole
  screen" toggle for the browser's Fullscreen API.
- **No new contract.** The header is the bundle's own DOM in its bar slot (extensions ADR 334);
  the host adds nothing.

## Consequences

- A second bundle that goes full screen writes its own header; if more than one appears, a shared
  header component in panel-kit is the next step.
- In full screen the shell's breadcrumb and the bundle's header never show at the same time.
