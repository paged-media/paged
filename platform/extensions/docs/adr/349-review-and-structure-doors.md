# ADR 349 — The structure doors: headers, footers and notes edited in place (C6)

- **Status:** Accepted 2026-10-28 (C6); amendment 1 2026-10-29 (C5, the margin band). The
  spelling and clipboard doors (C7 `host.spelling`, C8 styled clipboard) are recorded here
  when their waves add them.
- **Scope:** `packages/plugin-api/src/{editor,host,contributions}.ts`,
  `packages/plugin-sdk/src/{host-impl,harness}.ts`. Editor side: editor ADR 301. First consumer:
  paged.doc (doc ADR 611). DESIGN.md §29.

## Context

paged.doc places a Word section's headers and footers on masters (engine ADR 1022): every page
shows them, and their stories are ordinary stories the text operations address. Word users edit
a header where they see it: double-click the header area of a page, type, Esc back to the body.
The host knows nothing of headers, and should not: which part of a page is a header, which
master a page shows and which story stands in it are the bundle's lowering. A bundle had no way
to answer a double-click on a page (the edit-context door answers a double-click on an ELEMENT,
and master items are not elements the hit test returns) nor to put the user into a story on a
given page.

## Decision

- **C6 `contribute.subContextProvider({ editContext, resolve })`**: the host offers every page
  double-click, while that context (or the document context) is active, to the bundle first;
  the bundle answers a `SubContextSpec` (`kind`, `pageId`, `storyId`, `bounds`, optional
  `masterId`, `frameId`, `label`, `commands`, `offset`) or `null`. The provider borrows the edit
  context's declaration (ADR 348's gate); no manifest field.
- **`host.shell.enterSubContext(spec)` / `exitSubContext()` / `subContext()` /
  `onDidChangeSubContext()`** enter one from a command (Insert ▸ Header, a footnote reference
  jumping to its note), leave one's own, read and follow the one shown. The host owns the
  chrome: the caret in the story on that page, the veil, the bar with the bundle's commands,
  Escape.
- **Probes:** `contribute.subContextProvider@1` (static), `shell.subContext@1` (dynamic, the
  editor's `subContexts` registry). The headless harness wires the registry and plays the
  double-click (`doubleClickPage`).
- The plugin-sdk / plugin-api versions move in lockstep at integration.

## Consequences

- The host stays format-neutral: a sub-context is "this story, shown on this page, in this
  area", which a slide's notes or a sheet's header and footer can use as well.
- `kind: "note"` waits for the engine to put a caret into a footnote's text; until then a
  bundle can use it for a note it keeps in a story of its own.
- Additive: an older host warns and answers false / null.

## Amendment 1 (2026-10-29): the markup margin band (C5) and `text.contentRange`

paged.doc's review wave (doc ADR 613; engine ADRs 1037 and 1020) needs Word's markup area: a
balloon per deletion, formatting change and comment thread beside the page, level with its
text. Two additive members:

- **C5 `contribute.marginBand({ id, scope: { editContext }, title?, width?, order?, items(),
  onDidChange(listener), render })`.** `items()` answers `MarginBandItem { id, anchor:
  { storyId, start, end }, kind?, color? }`, the anchor in CONTENT offsets (the caret's);
  `render` is React in the host realm, called once per item with `MarginBalloonProps { item,
  editContext, active }` (`active`: the caret or the selection touches the anchor). The host
  places, stacks and keeps the balloons with their text (editor ADR 300) and reads `items()`
  again after `onDidChange`. Gates as a status item (ADR 348): namespaced id, the scope's
  context declared and registered by the same bundle; no manifest field.
- **`host.text.contentRange({ storyId, start, end })`**: story CHARACTERS (what the engine's
  `trackedChanges` and `comments` collections, story-range addresses and find hits'
  `charStart` count) as content offsets (what `viewport.revealText`, `selection` and an anchor
  take), `null` when the story does not read. Gated on `capabilities.document.read`. The pure
  conversion is exported as `charToContent` beside `contentToChar`, for a bundle converting
  many ranges of one story at once.
- **Probes:** `contribute.marginBand@1` and `text.contentRange@1` (static);
  `shell.marginBand@1` (the editor's `marginBands` registry, `ShellRegistries.marginBands`).
- **Harness:** `createHeadlessHost` records the bands (`marginBandsContributed()`); the fake
  editor carries a `marginBands` registry.
- The review commands themselves need no new door: they are engine mutations
  (`acceptChange`, `rejectChange`, `insertComment`, `replyComment`, `resolveComment`,
  `deleteComment`, `editComment`, `set` on the document's `documentTrackChanges*` and
  `documentMarkupView`) through `document.mutate`, and reads through `document.collection`.
- Versions: the lockstep plugin-sdk / plugin-api bump happens at integration.
