# ADR 1205 — A drop says what it will do

- **Status:** Accepted 2026-11-13. Decision 4 (failed opens change nothing), decision 5 (every
  format offered) and the frame under the pointer in `placeImage` ship with this record;
  decisions 2 and 3 (the label before the drop, the drop carried out from it) take effect when
  the canvas drop zone of task WS0 (`cockpit/drop-zone.tsx`) mounts `useDropIntent`.
- **Scope:** `packages/shell/src/state/drop-intent.ts` (new: the resolver, pure),
  `state/drop-target.ts` (new: the target under the pointer), `state/use-drop-intent.ts` (new:
  the drop zone's handlers), `overlays/drop-intent-overlay.tsx` (new: the ghost label),
  `cockpit/drop-zone.tsx` (the canvas drop zone, task WS0), `state/commands/file-commands.ts`
  (`dropFileAs`; a file that is no package is refused before the replace question),
  `state/document-loader.ts` (a failed load resets nothing and says so),
  `state/picker-types.ts` (new) and `PagedShell.tsx` (the open picker),
  `state/open-library-document.ts` (new), `apps/canvas/src/insert-commands.ts` (`placeImage`,
  `PlaceDropPayload.into`), `apps/canvas/src/panels/empty-canvas.tsx` (new: the canvas with
  nothing open). `UXI-DND-001` to `UXI-DND-004` and `UXI-FIL-001` of the interaction
  specification ([ADR 1200](1200-the-interaction-contract-is-adopted.md)); the UX strategy's
  §6.3; task DF3 of [`interaction-plan.md`](../interaction-plan.md). Amends
  [ADR 258](258-a-dropped-picture-is-placed-where-it-lands.md). Closes UX audit F-10 and F-02's
  silent and misleading opens; F-40 with the drop zone.

## Context

A file dragged over the canvas showed nothing until it was dropped (F-40): the user could not
tell whether it would open, be placed or replace the document. A dropped picture went into
the SELECTED empty frame when there was one (`placeImage` read the selection first), not into
the frame it was dropped on. The native open picker listed `.paged` and `.idml` only, though
importers open Word, PowerPoint, Excel, PDF and Photoshop files, and the empty canvas named one
format and a menu item that does not exist (F-10). A `.txt` or a damaged `.idml` asked the
replace question, then failed in the engine, after the open document's name and page pictures
had already been reset, with the reason only in a tooltip (F-02).

## Decision

1. **One pure resolver decides what a drop does** (`resolveDropIntent`): from the files, the
   target under the pointer (the empty canvas, a page, the pasteboard, or a frame, by the
   engine's own hit test), whether the open document must be saved first, and the role. The
   intents: `place` (a new frame where the picture lands), `place-in-frame` (an empty graphic
   frame under the pointer takes it), `replace-frame-content` (the frame's picture is
   replaced), `import` (a file an importer claims, with a document open), `open` (nothing is
   open), `replace-document` (a `.paged` or `.idml` over an open document) and `reject`, each
   with a label and, where it matters, a reason ("You will be asked to save your changes
   first."). Several files, a viewer or a filler, and a named file nothing opens are refused.
2. **The label shows before the drop** (`UXI-DND-002`). While a file is dragged the browser
   tells its type, not its name: the resolver decides from the type (`provisional`) and never
   refuses on the type alone, since an importer may claim the file by its extension; an
   unknown type reads "Drop to open or import this file". The ghost label sits at the pointer,
   the frame that would take a picture is outlined, and a refusal shows its reason under a
   not-allowed cursor.
3. **The drop does what the label said.** On the drop the intent is resolved again from the
   file's name and carried out by `dropFileAs`: Place with the frame under the pointer
   (`PlaceDropPayload.into`), never the selection; File ▸ Open's path for the rest, whose
   replace question runs for every replacement (`UXI-DND-003`, ADR 230). A drop on another
   document or edit context than the drag was shown for is refused (`UXI-DND-004`). File ▸
   Place still fills the selected empty frame (ED-6): with no pointer, the selection is the
   target.
4. **Nothing replaces the document with a misleading success** (`UXI-FIL-001`). A file that is
   no ZIP package is refused before the replace question, with a visible reason; a load the
   engine fails resets nothing (the engine keeps the open document) and says so in the
   shell's warnings, not only in the status line.
5. **Every format is offered** (F-10). The open picker's first entry is everything the editor
   opens, every importer's extensions included; Save writes back only over a `.paged` or an
   `.idml`, so a Word or Excel file opened through the picker is never overwritten with
   `.paged` bytes. The empty canvas offers New document and Open…, the local library's recent
   documents (one path with the Library panel's Open, `openLibraryDocument`) and the formats
   the editor opens.

## Consequences

- ADR 258's "a picture is placed where it lands" now reads: on a page or the pasteboard a new
  frame where it lands; over a graphic frame, into that frame.
- Tests: `packages/shell/test/state/drop-intent.test.ts`, `picker-types.test.ts`,
  `test/commands/file-commands.test.ts` (refusals, `dropFileAs`, a file that is no package),
  `test/stores/document-loading.test.ts` (a failed load resets nothing),
  `apps/canvas/test/unit/commands/insert-commands.test.ts` (the frame under the pointer), and
  `UXI-T62`, `UXI-T63`, `UXI-T64` in `apps/canvas/tests/e2e/uxi-drop-intent.spec.ts` with the
  drop zone.
