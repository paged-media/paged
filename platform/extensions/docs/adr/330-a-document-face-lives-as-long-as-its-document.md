# ADR 330 — A face given to a document lives as long as that document

- **Status:** Accepted, 2026-10-15.
- **Scope:** the lifetime of a face `AssetSurface.registerDocumentFont` gives
  ([ADR 328](328-a-face-for-the-document-where-it-has-none.md)); the optional
  `PagedClient.registerDocumentFont` in `packages/plugin-api/src/editor.ts`; its use in
  `packages/plugin-sdk/src/host-impl.ts`; the headless client in `harness.ts`; the flag
  `assets.documentFont@2`. Amends ADR 328's consequences and DESIGN.md §13.7.

## Context

ADR 328 put a bundle's face in the engine's document font registry. That registry belongs to
the engine session, not to a document: the worker keeps one list, seeds every document it
loads afterwards from it, and can only empty it as a whole (`clearFontRegistry`). It has no
call that removes one face.

So a face given to one document stayed for every document opened after it:

- **The next document laid out with it.** Open document A, whose plugin gives it "Gloria
  Hallelujah"; open document B, which names the family and holds no face. B was drawn in A's
  face, the Fonts collection called the family present, and nothing told the user B lacks it.
- **The door answered `held` in the next document.** A bundle giving B its own face for the
  family was told B already had one, so B kept A's bytes.
- **It hid a missing reload.** A document reopened in the same session still had the face,
  whether or not the bundle that gave it gave it again. The same document opened in a new
  session did not. A bundle that forgot to give the face again on open only failed in the
  second case.

In the editor and in the headless host one engine holds one document at a time, and every load
replaces it. "Closing" a document is the next load.

## Decision

- **A face belongs to the document open when it is given.** The host drops it before the next
  document loads — whatever loads it: File ▸ Open, File ▸ New, a plugin opening a document, the
  same file opened again. The next document never lays out with it, so a document that names
  the family without holding it reports it missing, and the door gives that document its own
  face (`registered`, not `held`).
- **The bundle gives it again on open.** The face is not saved with the document (ADR 328), so a
  bundle whose text needs it gives it from `document.onDidOpen`, out of what the document keeps
  (a source part, an embedded resource). A face given **before** a document opens belongs to the
  document that was open then and goes with it: give it after the open. With no document open
  the call is refused.
- **A call made during a load waits for it.** If the document it was made for closed meanwhile,
  the call is refused ("the document … has closed"), and nothing is registered.
- **The session's faces stay.** Faces registered through anything but this door — the host's
  default faces, a test's or a tool's `registerFont` — are the session's and outlive every
  document, as before.
- **Layout runs again where a face goes.** The host drops the faces by emptying the registry and
  registering the session's faces again, before it posts the load; the engine answers in order,
  so the load sees the rebuilt registry. Each step lays out again the text of the outgoing
  document that names those families and reports the pages, and the editor repaints them, so no
  page shows a face the registry no longer holds. A load that fails leaves the document open, and
  its faces are given back the same way.
- **The client owns it.** Only the engine client sees every registration and every load, so it
  keeps the ledger: each face in the document registry with the document it belongs to, or none
  for the session. The narrow client contract gains an optional
  `registerDocumentFont(family, bytes, style)`, which the editor's client and the headless
  client implement. The SDK forwards the door to it when it exists.
- **`assets.documentFont@2`.** True when the host's client scopes faces this way. A host with
  only `@1` sends `registerFont` itself and the face lives for the engine session, as ADR 328
  described. A bundle that gives its faces on every open needs no probe: on such a host the
  second call answers `held`.

## Consequences

- paged.slide gives a deck's embedded faces after the deck opens, not before (its import path
  registered them first, so the deck would lay out in them from the start); its `onDidOpen`
  handler already gives them again from the source deck it keeps.
- paged.web gives a baked run's face when it bakes. A document reopened later names those faces
  and has none until something gives them again, and paged.web does not: on open it renders web
  frames, while baked text is native text whose faces it does not record. Until it records the
  faces it baked with (in a part, as paged.slide keeps its deck), reopened baked text reports
  the family missing and draws in a substitute, in the same session as in a later one.
- Dropping faces costs a registry rebuild before the next load, and only when the outgoing
  document has faces of its own. The client holds a copy of every face it registered, the
  session's included; the default family's extra faces, registered after every load, are kept
  once.
- An engine scope for a face that lives in the open document only (registered into the loaded
  document and not the session list, so it goes with the document) would replace the ledger and
  the rebuild, and let a host that holds several documents keep their faces apart. The contract
  above would not change.

## Related

- [ADR 328](328-a-face-for-the-document-where-it-has-none.md) — the door this ADR gives a lifetime.
- [ADR 310](310-one-write-door.md) — the write gate the door shares.
- DESIGN.md §13.7.
