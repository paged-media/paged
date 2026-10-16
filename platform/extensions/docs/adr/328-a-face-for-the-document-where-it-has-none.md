# ADR 328 — A bundle may give the document a face where it has none

- **Status:** Accepted, 2026-10-14. Amended 2026-10-15 by
  [ADR 330](330-a-document-face-lives-as-long-as-its-document.md): the face lives as long as the
  document it was given to, not the engine session.
- **Scope:** `AssetSurface.registerDocumentFont` and `DocumentFontOutcome` in
  `packages/plugin-api/src/assets.ts`; its implementation in
  `packages/plugin-sdk/src/host-impl.ts`; the flag `assets.documentFont@1`. Amends DESIGN.md
  §13.3 (document-scope ingestion was closed).

## Context

paged.web bakes a web frame into native text. Each baked run names the face the web engine
shaped it in: a document face, the face the plugin ships, or a face the source's own
`@font-face` rule loads. The last two are faces the document does not hold. The native text
then named a family with no face in the document's registry, so the Fonts collection flagged it
missing and the canvas drew it in a substitute, at other widths than the ones it was measured
at.

The engine has the door: `registerFont` with `scope: "document"` puts a face in the registry
document text lays out with. The plugin API did not expose it. `assets.registerFont` reaches
the scene-layer table only, on purpose (DESIGN.md §13.6): a bundle shipping Inter must not make
a document's missing Inter look present. paged.web sent the message through the `host.editor`
escape hatch.

That rule protects the case where the face does NOT draw the document's text. Here it does: the
text the bundle wrote is laid out and drawn in the face, so the Fonts collection is right to
call it present.

## Decision

- **`host.assets.registerDocumentFont(bytes, family, style?)`** gives the document a face. The
  engine re-lays out the text that names the family, and the outcome lists those pages.
- **It fills a gap and never replaces.** The engine is asked first whether its document
  registry holds the face: the same style, or any face of the family for a call without a
  style. If it does, nothing is sent and the outcome is `held`. A bundle can therefore not
  change how text that already resolves is drawn.
- **Gates.** `capabilities.assets` includes `"fonts"`, as for every asset door (a throw in
  `enforce`), and `capabilities.document.write`, because it changes how the document lays out
  (a refusal, as for every write door).
- **Only faces the canvas can draw.** A face over `ASSET_BUDGETS.maxFontFaceBytes`, WOFF and
  WOFF2 (the canvas reads neither), bytes that are not a TrueType or OpenType face and an empty
  family are refused before anything is sent.
- **An outcome, not an exception.** `registered` with the pages laid out again, `held`, or
  `refused` with the reason (a gate, a budget, the bytes, the engine's answer, a dead channel).
- **Calls for one face at the same time register it once.** Registrations queue per engine
  client, so the second finds the face held.
- **Served by the engine, statically flagged.** No host-injected backend is involved, as with
  `getPlacedImage`; `assets.documentFont@1` says the SDK forwards the call.
- **No disposal.** The face outlives the bundle: the text the bundle wrote names it after the
  bundle is gone.

## Consequences

- paged.web drops its escape hatch for document faces.
- The face is not undoable and is not written into a saved file; a document names its fonts and
  carries no face bytes. The engine keeps the face for the session, for documents opened later
  too. A bundle whose text needs the face in a later session provides it again.
  **Amended 2026-10-15 ([ADR 330](330-a-document-face-lives-as-long-as-its-document.md)):** a
  host whose client scopes the face (`assets.documentFont@2`) drops it before the next document
  loads, so no later document lays out with it; the bundle gives it again each time the document
  opens.
- The editor's canvas repaints the pages the registration laid out again only if it marks the
  pages named in the engine's `fontRegistered` reply dirty. That is the editor's render loop, not
  this door.

## Related

- DESIGN.md §13.6 — scene-layer faces, which never reach the document.
- [ADR 319](319-trust-line.md) — the trust line this door is drawn against.
- [ADR 310](310-one-write-door.md) — the write gate it shares.
