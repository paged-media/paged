# ADR 1106 — An edit context says how it is left, what it is called, and whether it edits placed pictures

- **Status:** Accepted 2026-11-13.
- **Scope:** `packages/plugin-api/src/host.ts` (`EditContextContribution.exitPolicy`, `.label`,
  `.editsPlacedImages`; `EditContextExitPolicy`), `packages/plugin-sdk/src/host-impl.ts`
  (`CreateBundleHostOptions.editContextExitPolicy`, `supports("editContext.exitPolicy@1")`). The
  editor's side is editor ADRs 1211 (one way out of a context) and 1212 (frame, content, edit).
  plugin-sdk and plugin-api move to the next canary.

## Context

The editor now leaves an edit context through one resolver that weighs why the user is leaving
and whether the context holds unfinished work (the interaction specification's D-04). Only the
module knows whether committing its work is always safe, whether it must ask, or whether its
in-flight work may be thrown away. The editor also showed a context by its type, an identifier
("rasterImage"), and could not tell which context edits a placed picture's pixels, which D-05's
"Edit image" needs.

## Decision

Three optional fields on `EditContextContribution`:

- **`exitPolicy?: "commit-if-safe" | "ask" | "discard-allowed"`.** `commit-if-safe`: `onCommit`
  keeps the work and the document can undo it, so every exit but an explicit cancel commits
  without asking; Escape commits a clean context, a dirty one asks on Escape and on a document
  switch. `ask`: a dirty context is never left without the user's answer (Commit, Discard,
  Cancel). `discard-allowed`: Escape and a document switch may cancel without asking; every other
  exit still commits. A clean context is left at once whatever the reason. Absent means
  `discard-allowed`, the host's behaviour before the field existed. `isDirty` is what "dirty"
  means here, as before.
- **`label?: string`** — the context's name in the editor's language (`host.strings.t`), shown
  in the breadcrumb, the context toolbar and the frame-level control. Absent: the type as words.
- **`editsPlacedImages?: boolean`** — this context edits a placed picture's pixels. The host
  offers the first such context as a picture frame's explicit Edit level and enters it on that
  frame whether or not its matcher claims it; `onEnter` takes the picture in.

`supports("editContext.exitPolicy@1")` is true when the host resolves exits by the policy (the
editor sets `editContextExitPolicy`). The SDK passes the fields through unchanged.

## Consequences

- The built-in contexts declare a policy and a label: draw's vector graphic, web frame,
  spreadsheet, image, Word document, chart and data binding are `commit-if-safe` (their work is
  a document edit as it lands, or kept by `onCommit`/`onExit`); paged.image declares
  `editsPlacedImages`.
- A community context that declares nothing behaves as before.
- No field is required, so no bundle breaks; the canary moves because the contract's text
  changed.
