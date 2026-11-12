# ADR 315 — Footnotes, destinations, cross-references and index entries are host commands

- **Status:** Accepted 2026-11-11.
- **Scope:** `apps/canvas/src/reference-commands.ts` (the commands, the Type menu rows, the door
  over the live text selection), the typed twins registered in `apps/canvas/src/app/mount.tsx`, the
  Cross-References and Index panels' forms; the shared insert in `platform/shared/helpers`
  (`text-references.ts`); paged.doc's References dialogs (`modules/doc`, doc ADR 612 amended).

## Context

Inserting a footnote or an endnote, a named destination (InDesign's hyperlink text destination,
Word's bookmark), a cross-reference and an index entry existed only as paged.doc commands and its
References panel, writing the engine's own ops (`insertFootnote`, `insertEndnote`,
`insertTextAnchor`, `insertCrossReference`, `insertIndexMarker`). Nothing about them is Word's: an
InDesign or a slide story takes them the same way, and the host's Cross-References and Index panels
only listed what exists.

## Decision

- **One insert, in helpers.** `insertReference(door, insert)` builds the one op at the caret (a
  note at the character offset, the others at the content offset); a door is the text selection,
  the character range and `mutate`. `referenceTypedCommands(door)` makes the five typed commands.
- **Host commands.** `paged.insert.footnote`, `endnote`, `bookmark`, `crossReference` and
  `indexEntry` run it over the live text selection, one undo step; a refusal (no cursor, no name, a
  topic of more than four levels) lands in the Problems panel. Run bare, the bookmark and
  cross-reference commands open the Cross-References panel and the index entry the Index panel,
  where their forms are. The Type menu has Insert footnote, Insert endnote, Insert bookmark…, Insert
  cross-reference… and New index entry….
- **Panels.** The Cross-References panel has a destination name with "New destination at the
  cursor" and "Insert cross-reference" (its text, its page number, or above / below). The Index
  panel has a topic (`Main:Sub`) with "New page reference".
- **Typed twins.** The same five are typed commands (`paged.insert` in the object registry), which
  scripts, the CLI and paged.doc's Word-styled References dialogs call by id. Doc keeps its
  dialogs and keys (Cmd+Alt+F, Cmd+Alt+D); they call the host commands, and on a host without them
  (the headless harness) run the same shared insert through `host.text`.

## Consequences

- Every kind of document inserts footnotes, destinations, cross-references and index entries from
  the host, the same way.
- A text-anchor destination does not appear in the Bookmarks panel (PDF bookmarks); it is the
  destination a cross-reference names.
