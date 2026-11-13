# ADR 282 — Enter enters the content a plugin owns

- **Status:** Accepted 2026-10-23.
- **Scope:** `packages/shell/src/state/use-edit-context-entry.tsx` (`isOwnedContent`),
  `apps/canvas/src/ui/usePathEditMode.ts` (the Enter key).

## Context

A double-click enters the edit context of the content under the pointer: a sheet frame opens its
grid, a web frame its source. The keyboard had no way to do the same. Enter on a selected frame
started editing the frame's path, which for a frame whose content a plugin compiles (a placed
sheet table) is never what is meant — and editing its outline by accident reshapes a table the
plugin owns.

## Decision

Enter on a single selected element whose content a plugin owns — its metadata claims an object
type, the lane a Type-tool click on owned content already uses (C-4) — enters that plugin's edit
context, exactly as a double-click without a point does (the context starts where it left off).
Whether the selection is owned is resolved when the selection changes (`isOwnedContent`, a dry
run of the double-click resolver), so the key stays synchronous. Enter on any other element keeps
its meaning (path editing on a path-bearing element); Enter with a modifier, inside an active edit
context, in a text field or in a frame surface is not this key.

## Consequences

- Every plugin with owned content gets keyboard entry without code of its own.
- Contexts claimed by element kind (the vector-graphic context on paths) are not entered by Enter:
  Enter on a path stays path editing.

## Amendment 2026-11-13

[ADR 1201](1201-interaction-decisions.md), D-05: on an image frame a double-click no longer
enters the image module; it enters content position (the picture moves, the frame stays). The
explicit "Edit image" action enters paged.image's context: its button on the context toolbar,
Enter on the selected frame as this record decides, or a second double-click. Other owned content
is unchanged. Until that task lands the body describes the code.

## Amendment 2026-11-13 (implemented)

[ADR 1213](1213-frame-content-edit.md) builds D-05: a double-click on a picture frame enters its
content level; Enter on a selected picture frame (and on its content level) enters Edit image,
the context that declares `editsPlacedImages`. `isOwnedContent` answers true for a picture
frame when such a context is registered.
