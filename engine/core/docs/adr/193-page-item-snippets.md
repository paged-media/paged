# ADR 193 — Page-item snippets: what Copy takes and Paste puts back

- **Status:** Accepted 2026-10-19; amendment 1 2026-11-13 (the Alt-drag previews the copy it commits).
- **Scope:** `crates/paged-mutate/src/apply/snippet.rs` (`extract_snippet`, `Operation::InsertSnippet` /
  `RemoveSnippet`), `crates/paged-canvas` (`ExportElements` / `ElementsExported`,
  `Mutation::PasteElements`, the Alt+Translate commit), `crates/paged-script`
  (`paged.copyElements`, `paged.pasteElements`), `crates/paged-cli` (`paged read snippet`).
  Rides protocol 74 (rule 4: v0.74.0 was tagged and never published).

## Context

The editor had no Cut, Copy or Paste for page items (editor finding SH-201, UX audit F-28). The
engine could duplicate (`DuplicateNodes`, C-64), but a duplicate needs its source in the
document: after a Cut the source is gone, and after File ▸ Open it is in another document. The
Alt-drag gesture cloned through `CloneTranslate`, which reaches a text frame or a rectangle only:
a group failed at commit (GF-2), and its `<id>_dup_<n>_<m>` ids, minted outside the document's id
line, could collide (GF-3).

## Decision

1. **A snippet is the copied items whole, as JSON.** `extract_snippet` validates as a duplicate
   does (the same refusals, by name) and refuses items on two spreads. It carries every item's
   struct, side-map rows, a group's members, pasted-in children, copies of the text frames' and
   text paths' stories, the hyperlinks those stories' sources own, the roots' union box and the
   source page's origin, the plain text, and the resources the items name — colours, swatches,
   gradients, paragraph, character, object and stroke styles, conditions — found by id over the
   items' JSON and closed over what those name (`BasedOn`, a tint's base).
2. **Copy is a read** (`exportElements`): the editor holds the JSON, so a paste works after the
   items are deleted, in another document, and (through the system clipboard's HTML form) in
   another tab.
3. **Paste is one undoable op** (`pasteElements` → `InsertSnippet`): the copies land on the page's
   spread, on top of its z-order (InDesign pastes in front), centred on a page-space point
   (Paste) or at their page-relative position (Paste in Place), under ids from the canvas
   minter. Resources the target lacks are added (the target's definition wins when both have
   one) and listed on the op for its undo; an item on a layer the target lacks goes to the
   default layer; a hyperlink whose destination the target lacks is dropped, not its text.
   `RemoveSnippet` removes exactly what was added.
4. **Alt+Translate commits as a paste** of the dragged roots (members ride their group), on top,
   at the dragged position, cross-spread included (Track K). A copy the snippet refuses (a
   threaded text frame) keeps the old `CloneTranslate` of a lone frame, with a minted id.

## Consequences

- One copy path for the editor's clipboard, Alt-drag, scripts and the CLI.
- Duplicate stays `DuplicateNodes` (directly above the source, in its group); a paste and an
  Alt-drag copy land on top of the spread, at top level.

## Amendment 1 (2026-11-13): the Alt-drag previews the copy it commits

Protocol 79; editor ADR 1201, decision D-02 (and D-06); task EN4: `UXI-GST-008`, `UXI-GST-009`,
`UXI-GST-011`, proven by `UXI-T06` and `UXI-T11`.

Decision 4's commit read the modifiers the last update left on the session while the preview
moved the originals whatever Alt said, so what the user saw during an Alt-drag (the item
moving) was not what the release made (the item staying, a copy appearing). Now:

- **The preview is the commit.** While Alt is held in a Translate, an update puts the originals
  back at rest and pastes the copy the commit will paste — the same `alt_duplicate_ops`, built
  from the same scene (originals at rest, no copy), so the copy's items, ids and place are the
  commit's — and keeps the ops that take it out again on the session. Each update takes the
  previous copy out first and starts again from the snapshot, so pressing or releasing Alt
  mid-drag switches between move and duplicate with no drift; the release commits what the last
  update showed, as one undo step, and a cancel leaves no copy (`UXI-GST-006`). A copy the
  snippet or the session's policy refuses is not previewed; its commit fails as it did.
- **The press's modifiers begin the gesture.** `BeginGesture` takes the optional `modifiers`
  held at the press (`CanvasModel::begin_gesture_with`); every update replaces them with the
  live ones. The editor's press-drag on an unselected item passes the live Alt instead of
  `false`, so an Alt press-drag released before its first update still duplicates.
- A preview that adds or removes the copy rebuilds as a committed structural edit does (the
  cross-build emit caches go); a plain move keeps them for the whole drag, as before.
