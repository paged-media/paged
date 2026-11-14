# ADR 630 — Story view and Story Map: the same story as text, and its flow through the frames

- **Status:** Accepted, 2026-11-14.
- **Scope:** `doc-bundle/src/story/` (new: `story-model.ts`, `story-view.tsx`,
  `story-map-model.ts`, `story-map-panel.tsx`, `contribute.tsx`), `src/activate.ts`,
  `src/messages.ts`, `manifest.json` (the view `media.paged.doc.view.story`, the panel
  `media.paged.doc.panel.storyMap`, the commands `storyView`, `storyMap`, `nextOverset`, the
  View menu's three rows), `src/panels/references-panel.tsx` (the host's numeric field). Task
  CM5 of the editor's interaction plan; the UX strategy's §7.4; the interaction specification's
  §10.4 (Text: the story caret; Escape back to the frame).

## Context

Writing a long text in a layout means writing inside frames: a heading on one page, the next
paragraph two frames later, overset text invisible until the thread grows. Word gives a writer a
column of text; InDesign gives the Story Editor. The strategy asks for two views of the same
content — Story view for distraction-free continuous writing, Layout view for the paginated
canvas — without a second text model, and for a Story Map that shows how text flows across
frames and spreads, overset and disconnected stories included, with the user taken to a frame by a
click. The editor already draws thread lines and overset markers on the page (editing aids, editor
ADR 1212); nothing showed a story's whole path, and nothing let the user write its text outside the
frames.

## Decision

1. **Story view is a module view** (extensions ADR 345): **View ▸ Story view** (and the command
   palette's "Story view") shows it in place of the canvas; **Layout view** in its bar, the same
   command again, or the host's own close gives the canvas back where it was. It shows the story
   of the text caret, else the one shown last, else the first; a picker in its bar switches.
2. **No second text model.** The view reads the engine's story (`storyContent`) and reads it
   again after every document change. Each paragraph is a field over the engine's paragraph; an
   edit is the smallest `deleteRange` + `insertText` that turns the paragraph's old text into the
   new one, written through `host.document.mutate` at the engine's story offsets (UTF-8 bytes
   plus one `\n` per paragraph boundary). Enter writes a paragraph break where the caret is (the
   engine splits the paragraph, as Enter on the page does); Backspace at a paragraph's start
   deletes the mark before it; the arrows walk between paragraphs. A run of typing in one
   paragraph is one undo step (its later writes `amend` the first while it is the last step);
   Cmd/Ctrl+Z in the view writes what is typed, then is the document's undo. A paragraph changed
   elsewhere (on the page, by an undo) shows the engine's text unless the user is typing in it.
3. **Structure.** Paragraphs in a heading style are set as headings (Title and Heading 1–6, by
   id or name), list styles with their marker; a Headings list beside the text jumps to a
   heading; **Show in layout** (↗) on a paragraph closes the view and reveals that paragraph on
   its page (`viewport.revealText`, a recorded jump: Go back returns, editor ADR 1211). A word
   count is in the bar. Where the story oversets, a rule marks the first paragraph that does not
   fit and the overset paragraphs are set in the warning colour.
4. **Story Map** (a panel; **View ▸ Story map**): every story as its thread — one chip per frame
   in thread order, named by its page ("p. 3", or Pasteboard), arrows between them — then
   **Overset** where the last frame cannot hold the text, or **Not placed** for a story no frame
   shows. Problems come first: overset stories, then unplaced ones, then the rest, longest first.
   A chip selects its frame and brings its page into view (`selection.set`,
   `viewport.goToPage`, a recorded jump); Overset goes to the last frame; **Story view** opens the
   story as text. The map reads the stories collection, each story's `frameChain` and the frames'
   pages, again after every document change.
5. **Overset navigation.** **View ▸ Go to next overset story** walks the overset stories round
   the document, to each one's last frame.
6. **One numeric field.** The References panel's page setup (margins as lengths in the
   document's unit, columns) is the host's `NumericField`; the file leaves the
   `raw-number-input` baseline.

## Conformance (interaction specification §21.3)

| Item | How |
|---|---|
| Owner and focus | The view's fields own their keys (a form field, UXI-KEY-002); the canvas is not mounted while it shows. |
| Entry and exit | The command, the menu, the map's Story view; Layout view, the command again. Leaving keeps the camera where it was. |
| Preview, commit, cancel | A paragraph commits after a pause, on leaving the field, Enter, Backspace's join, or Cmd/Ctrl+Z. |
| Undo | The document's, one step per run of typing in a paragraph; Cmd/Ctrl+Z in the view is the document's undo. |
| Permission refusal | Every write is `mutate`, which the engine's role policy refuses; a refused write leaves the field's text, and the next read shows the engine's. |
| Keyboard alternative | Every action has its key or a focusable button; the map's chips are buttons of at least 24 px. |

## Consequences

- `test/story-model.spec.ts` (blocks, offsets in bytes, writes, joins, the map's order and the
  overset walk), `test/panels/story-view.dom.test.tsx` (the view and the panel over fake doors),
  and the editor's `tests/e2e/doc-story-view.spec.ts` (typing in the Story view changes the
  engine's story as one undo step; Layout view returns to the same camera; the map's chip
  navigates and Go back returns).
- The editor's Stories panel stays the list with the per-story inspector; the map is the flow
  picture. Thread lines and overset markers on the page stay the editing aids of editor ADR 1212.
- The view sets text in one face; the layout's typography stays the Layout view's. Tables,
  anchored frames and notes are paragraphs of text here (their characters), not drawn.
