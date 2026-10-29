# ADR 231 — The page-item clipboard: Cut, Copy, Paste, Paste in place, Duplicate

- **Status:** Accepted 2026-10-19.
- **Scope:** `apps/canvas/src/clipboard-commands.ts`, `apps/canvas/src/main.tsx` (registration),
  `apps/canvas/tests/headless/harness.ts`; engine ADR 193 (the snippet).

## Context

Page items had no Cut, Copy, Paste or Duplicate (SH-201, UX audit F-28); only text ranges and
sheet cells did. InDesign's Edit menu has Cut, Copy, Paste, Paste in Place, Duplicate (⌥⇧⌘D).

## Decision

1. **Commands** `paged.edit.cut`, `.copy`, `.paste`, `.pasteInPlace`, `.duplicate`, in the Edit
   menu between Redo and Select all, bound to InDesign's chords on both platforms
   (Cmd/Ctrl+X/C/V, +Alt+Shift+V, +Alt+Shift+D). They apply at the object level only
   (`objectVerbApplies`): with a text caret the keys stay the story's (`useTextEditing`), inside
   an edit context the context's.
2. **The internal format is the engine's snippet** (ADR 193), held by the editor. The system
   clipboard gets `text/plain` (the copied frames' text) and `text/html` carrying a marker of
   the copy and, up to 512 KB, the snippet itself (so another tab can paste it). Writing is best
   effort; the internal copy stands either way.
3. **Paste pastes the newest content.** It reads the system clipboard where the browser allows:
   our marker means our copy; any other text becomes a new text frame (240 × 120 pt) at the view
   centre, one undo step; when the browser refuses the read, our copy. Paste centres the copy on
   the view (InDesign's Paste); Paste in Place keeps its position on the page; both target the
   page in view and select the copies. Cut is Copy, then Object ▸ Delete.
4. **Duplicate** is `duplicateElements` with InDesign's default step, 1p0 (12 pt) right and down,
   directly above each source, selected, one undo step.
5. **Several documents.** The editor holds one document at a time, so "between two open
   documents" is copy, open the other, paste — which works, the snippet carrying the styles and
   swatches the target lacks.

## Amendment (2026-10-28): vectors

ADR 289 adds the vector forms: Copy also writes the selection as `image/svg+xml` (and, with no
frame text, as the `text/plain` form); Paste of an SVG document from elsewhere imports it as
native page items, one undo step. Decisions 2 and 3 above stand for everything else.
