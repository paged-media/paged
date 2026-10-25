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

## Amendment 1 (2026-10-25): wave 1's engine model in the chrome

Engine ADRs 1018 and 1021 landed, so the targets ADR 608 left out now have one:

- **Home group** gains highlight (button and colour menu), double underline, hidden text,
  shading (button and colour menu), borders (none / bottom as the rule below / box), Show hidden
  text (¶, `documentShowHiddenText`) and Clear paragraph formatting (the alignment, indent,
  spacing and line-spacing overrides written empty so the style shows through).
- **Styles menu** beside the style box: Update style to match selection (one batch of
  `setStyleProperty` on the paragraph's style), Modify… (`host.shell.openPanel` on the host's
  Style Options with the style as target), New style from selection ("Style N" based on the
  paragraph's style, the selection's format, applied, then its options open to name it) and
  Apply styles (the focus goes to the style box: Cmd+Shift+S stays the host's Save As, a
  reserved key). Based on is edited in the host's Style Options (`setStyleBasedOn`).
- **Lists**: Tab / Shift+Tab are a list level only at the start of a list paragraph or over a
  range (elsewhere a tab), and are one `setListLevel` by a delta on the selection's characters
  (`host.text.characterRange`). Restart / Continue numbering (`restartNumbering`); a multilevel
  menu applies three Word presets (`1. a. i.`, `1. 1.1. 1.1.1.`, `• ◦ ▪`), each a
  `NumberingListDef` with nine levels made once per document.
- **Keys**: Cmd+Shift+D double underline, Cmd+Shift+H hidden text; Cmd+F, Cmd+H and Cmd+G name the
  host's Find, Replace and Go To (editor ADR 303) — Find & Replace is the host's, for every text
  document, not this bundle's. Cmd+G takes the key from the host's Group inside a Word document.
- Still left out: clearing a paragraph's own shading, border or list (a boolean has no inherit
  write), Word's per-side paragraph borders, the Font dialog, the structure keys, fields, notes,
  links, comments and track changes.

