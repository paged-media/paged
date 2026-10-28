# ADR 349 — The structure doors: headers, footers and notes edited in place (C6)

- **Status:** Accepted 2026-10-28 (C6). The review and spelling doors (C5 margin band, C7
  `host.spelling`, C8 styled clipboard) are recorded here when their waves add them.
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
