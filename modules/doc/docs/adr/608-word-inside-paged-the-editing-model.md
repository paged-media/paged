# ADR 608 — Word inside paged: the editing model

- **Status:** Accepted 2026-10-24.
- **Amends:** ADR 603 (two entry points).
- **Scope:** `packages/doc-bundle/src/word/*`, `packages/doc-bundle/src/activate.ts`,
  `manifest.json`. Contract: extensions ADR 348; host: editor ADRs 298, 299.

## Context

A Word user must be able to work in paged.doc as in Microsoft Word. A Word document is lowered to
native engine stories (ADR 600), so the editor's caret, selection and text input already edit it
in place; ADR 603 gave it two entry points, Open (the document) and Insert (a frame in a layout).
The sheet program gave its content a frame surface; Word content needs none.

## Decision

- **No frame surface.** Word text is engine text, edited in place (editor ADR 268). What Word
  adds is chrome and keys, contributed to the `wordDocument` edit context.
- **One context, both modes.** Insert mode enters `wordDocument` by Enter, double-click or a
  Type-tool click on the frame. Open mode has no frame to enter: the importer holds the document
  context (`host.shell.setDocumentContext("wordDocument")`) after a standalone open, and the
  bundle holds it again for a reopened document it recognises by its standalone label. Open and
  Insert therefore share the control bar, the shortcuts and the status bar.
- **Home group** in the control bar: the paragraph style box (the document's own styles first,
  generated `docx-auto-*` styles never), font, size, B/I/U/strike/sub/sup, text colour, bullets
  and numbering, indents, alignment, line spacing. Highlight, shading and borders wait for the
  engine to model them on text.
- **Shortcuts** scoped to `wordDocument`, each a command over `host.text`: Character (Cmd+B/I/U,
  Cmd+= subscript, Cmd+Shift+A/K, Cmd+Space, Cmd+Shift+>/<), Paragraph (Cmd+L/E/R/J, Cmd+0,
  Ctrl+Shift+M / Cmd+Shift+M), Styles (Cmd+Alt+1–3 by the document's own heading styles,
  Cmd+Shift+L bullets, Cmd+Alt+C/V copy and paste formatting), Tab / Shift+Tab as the list
  level in a list paragraph. Left out, with the reason in `word/commands.ts`: browser-reserved
  keys, Cmd+Shift+= (the key reports "+"), and targets the engine lacks (double underline, hidden
  text, clearing a paragraph override, the Font dialog, breaks and paragraph moves, find and
  replace, fields, notes, links, comments, track changes).
- **Status bar:** page X of Y, words (the selection's of the document's, Unicode word
  segmentation over the story text) and zoom.
- Enter applying the style's next style is the engine's (its own wave-1 change).

## Consequences

- Word formatting reaches the engine as the same story-range writes the host's panels make, so
  save-back (ADR 602) sees ordinary edits.
- Inserted documents' headers, footers and notes stay unplaced (ADR 603); the editing model
  does not change that.
