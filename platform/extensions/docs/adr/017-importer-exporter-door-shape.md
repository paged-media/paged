# ADR 017 — Importer / exporter door shape: resolve-by-extension, load-into-engine (K-2)

**2026-06-12 (records a 2026-06-10 decision) · decision record · status:
ACCEPTED (records the shipped K-2 contribution contract — pure SDK +
editor, no wire/protocol change, no npm publish).**

**Sources:** the internal gap register, K-2 (the shipped shape +
the explicit reversal of the originally proposed `read(bytes)→MutationBatch` design);
`editor: packages/shell/src/registries/document-io.ts` (the host-owned importer/exporter
registries + `resolve(name,mime)` before the default IDML load); SDK
`ContributionSurface.importer()/exporter()` + `ImporterContribution`/
`ExporterContribution` + `HOST_FEATURES` `contribute.importer@1` /
`contribute.exporter@1`.

## The decision

**An importer is resolved by file extension/MIME *before* the default IDML load,
and it loads the bytes into the *plugin's own engine* — it does NOT produce a
`read(bytes)→MutationBatch` that the host applies to the current document.** The
editor owns the importer/exporter registries (`document-io.ts`): the Open +
drag-drop flow `resolve(name, mime)`s a contributed importer by extension; a
match routes that file's **bytes to the plugin's `import()`** (replacing the
load target with the plugin's content) rather than mutating the open document.
Exporters surface as one-click outputs in the Export Center, where the **host
owns blob→download**. Shipped as a pure SDK contract + editor consumption — no
wire/protocol change, no publish.

## Why this reverses the original `read(bytes)→MutationBatch` shape

The originally proposed importer shape assumed every importer produces a *mutation
batch* applied to the open document. That assumption is wrong for the real
consumers:

- **An importer usually replaces the document, it doesn't patch it.** paged.sheet
  opening a `.xlsx` loads a whole workbook into *its own* engine and presents it
  as the document — there is no meaningful `MutationBatch` against the previous
  (possibly empty or unrelated) document. Forcing the result through mutation ops
  would mean re-expressing an entire foreign format as a diff against IDML, which
  is both lossy and absurd.
- **Resolve-before-default-load is the correct dispatch point.** Extension/MIME
  resolution must happen *before* the host commits to parsing the bytes as IDML,
  or a `.xlsx` would be handed to the IDML parser and fail. The host checks the
  importer registry first; only an unmatched file falls through to the default
  IDML load. This mirrors how `commands` are id-only mirrored in
  `PluginContributions.importers[]/exporters[]` (rich object at register, id-only
  in the manifest, CLI namespace-checked).
- **The host owns the I/O surface, the plugin owns the format.** Exporters return
  an `ExportResult`; the host turns it into a download. The plugin never touches
  the DOM or a file handle — `host.shell.pickFile` (K-5) and blob→download stay
  host capabilities. This keeps the isolation boundary intact (a plugin cannot
  reach the filesystem directly).

## Consequences

- **The contribution mechanism is ready for plugins that open a NEW document**,
  but a clean "open into a fresh host document" still needs a
  `host.document.open(bytes)` door (noted in the internal gap register for
  plugin-image's I-05 — a PSD importer that creates a new document). K-2 ships
  the *registration + routing*; the new-document door is out of scope and
  sequenced separately.
- **No wire/protocol change** — K-2 is entirely SDK contract + editor wiring, so
  it shipped on the `d03` branch via `link:` with **no npm publish**. The
  contract HEAD is therefore ahead of the published canary (a known governance
  residual — [ADR 006](https://github.com/paged-media/core/blob/main/docs/adr/006-protocol-coupled-versioning.md)
  consequences).
- **S-06 + S-11 resolved:** `.xlsx` opens via paged.sheet through File/Open and
  drag-drop; exporters surface in the Export Center. The door shape generalizes
  to every future format plugin (image's PSD, web's HTML) without a new core door.

## Amendment — 2026-10-02

Checked against the code at `d90f727`. The door shape stands: `contribute.importer` and
`contribute.exporter` are declared at `packages/plugin-api/src/host.ts:422-439`, their
contribution types at `packages/plugin-api/src/editor.ts:339-376`, the adapter at
`packages/plugin-sdk/src/host-impl.ts:1560-1581`, and the two feature flags at `:126-127`. Two
statements in Consequences no longer match the code.

**1. The open-document door exists.** The first Consequences bullet says a clean open into a
fresh document "still needs a `host.document.open(bytes)` door" that is "out of scope and
sequenced separately". The door has been built, under a different name:
`host.nativeDocument.open(bytes)`.

- `packages/plugin-api/src/host.ts:1320-1322` — `open(bytes: Uint8Array): Promise<void>` on
  `NativeDocumentSurface` (`:1310-1323`), which replaces the active document by loading "a
  native/importable package"; `:1599` puts the surface on `BundleHost`.
- `packages/plugin-api/src/manifest.ts:69-73` — the call requires
  `capabilities.document.openNative`.
- `packages/plugin-sdk/src/host-impl.ts:1667-1672`, `:2755-2764` — the adapter checks the
  capability and forwards to a backend injected by the host app; with no backend the call
  rejects. `:3154-3161` adds the feature flag `document.openNative@1` only when a backend is
  injected.
- `editor: apps/canvas/src/plugin-native-document.ts` — the editor's backend.

Three importers call it, each after converting or passing through to a package the engine can
load:

- `plugin-doc: packages/doc-bundle/src/open.ts:137` — the Word importer opens a skeleton
  package, then fills it through mutations.
- `plugin-publish: packages/pdf-bundle/src/io/pdf.ts:70`, `:79` — the PDF importer opens its
  reconstructed document, or an image-per-page fallback.
- `plugin-publish: packages/publish-bundle/src/io/idml.ts:63` — the IDML importer passes the
  file's bytes straight through.

plugin-image, the consumer the bullet names, does not call the door (at `f7d21e5`).

**2. The contract is published.** The second Consequences bullet says K-2 shipped "via `link:`
with **no npm publish**" and that "The contract HEAD is therefore ahead of the published
canary". This repo now publishes its packages under the `canary` dist-tag on every push to
`main` (`.github/workflows/publish.yml:15-17`, `:78-90`; see
[ADR 306](306-canary-releases.md)), and the editor pins `@paged-media/plugin-api` and
`@paged-media/plugin-sdk` by version number, not by `link:`
(`editor: apps/canvas/package.json:36-37`, the version in `packages/plugin-api/package.json:3`).

**Added since, superseding nothing above.** `host.shell.saveFile` sits beside `pickFile`: a
bundle hands bytes to the host to save, outside the exporter registry
(`packages/plugin-api/src/host.ts:1160-1181`, `packages/plugin-sdk/src/host-impl.ts:2397-2406`).
The bytes still leave through the host, as the third reason requires.
