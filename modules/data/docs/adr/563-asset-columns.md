# ADR 563 — Asset columns: fetched for a consented origin, kept by content hash, run through an action chain

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/data-bundle/src/assets.ts` (the pipeline), `session.ts`
  (`setAssetColumn`, `assetColumns`, the image lane's resolver), `lower.ts`
  (`commitLoweredImage`'s `resolveUri`), `persist.ts` (`assets` in the session part), the manifest
  (`capabilities.actions.run`, `capabilities.storage.blob`). Decided by
  [PM-0015](../../../../docs/adr/PM-0015-data-and-actions-are-platform-layers.md); runs actions
  through extensions [ADR 344](../../../../platform/extensions/docs/adr/344-the-actions-door.md).

## Context

A catalogue's rows name their pictures: a product photo by URL, a logo by a path relative to a
media server. paged.data placed what the engine resolved as a link (`placeImage`) and nothing
else. It did not fetch a remote picture, keep it, or prepare it: fit, colour conversion,
background removal. A link to an unreachable server became a missing link at export.

## Decision

**A column is declared an asset column**: `setAssetColumn(query, field, { chain?, base? })`,
saved in the session part (`assets`, keyed `<query>.<field>`). An image binding whose expression
is that field places each reference after three steps:

1. **Fetch.**
   - An `http(s)` reference is fetched only for an origin the user consented to: the remote
     sources' gate (editor ADR 218), so a document carrying references fetches nothing until
     allowed.
   - A relative reference resolves against the column's `base`.
   - A `data:` reference is read without the network.
   - Anything else is refused (`file:` included).
2. **Keep.** The bytes are kept by their SHA-256, in memory for the session and in `host.blob`
   (local, per plugin) when the host has one. A refresh fetches only references it has not seen.
   The media type comes from the bytes' signature, else the name's extension.
3. **Act.** The column's chain runs through `host.actions.runChain` (any bundle's registered
   actions). Its result is cached under the chain's key, so a second record with the same picture
   or a re-lower computes nothing. A chain whose output is not an asset is refused.

**What is placed is the asset itself**, as a `data:` URI (core ADR 208: a data URI carries its
picture). The document holds the processed picture, independent of the server, and it exports
like any other placed image.

**A reference that cannot be had is reported, never skipped**: no consent, a failed fetch, no
base, an unknown action, a failed chain. Each is logged with its reason, and nothing is placed
in the frame, so the missing picture shows as an empty frame with a status, not as a stale one.

## Consequences

- The image and draw modules' operations reach catalogue pictures as soon as they register
  them as actions (PM-0014's `paged-raster` and `paged-kernels` move their kernels to the
  engine).
- A data URI makes the document larger than a link would: the price of a document that does not
  depend on a server. A link-only column is a column that is not declared an asset column.
- The pipeline view and the per-column action picker are the Data panel's (editor ADR 291).

## Amendments

- Amended 2026-10-24: the data door serves the asset columns (`assetColumns`,
  `setAssetColumn`, extensions ADR 343; plugin-sdk 0.74.3-canary.24). `setAssetColumn` refuses
  a query that is not defined and a field its records do not have (clearing a column whose field
  went away is allowed), and a chain step without an action or with parameters that are not an
  object; it trims the base, saves the column in the session part and announces a change of the
  query, so a reader (the Data panel) reads the columns again. The editor's per-column picker is
  the Data panel's picture column editor (editor ADR 291, amended the same day).
- Amended 2026-10-28: **a saved `.paged` carries the asset bytes**, so a headless run of `paged
  data apply` (from a script, CI or a server) can place them (core [ADR 1014](../../../../engine/core/docs/adr/1014-bindings-live-in-labels-and-the-engine-applies-them.md),
  amendment 6). `persist.ts` `storeAssets`, called from the session's will-save listener after the
  session part is written:
  - **Parts.** Each asset the asset columns reference now, whose bytes this session holds, is its
    own container part `assets/<sha256>` (under the module's `paged/media.paged.data/`), the hash
    the one the pipeline keeps it by. One part per hash: two references or two columns with the
    same bytes share it, and a part already in the container is not written again.
  - **Index.** `assets.json` beside it: `{ v: 1, refs: { <reference>: { hash, columns } },
    assets: { <hash>: { mediaType, bytes } } }`, keys sorted, so an unchanged index is not
    rewritten. It is its own part, not in the session part: labelled session versions (protocol
    69) never name an asset, and the index needs no version of its own.
  - **What is referenced** is read per asset column from its query's records (the field's value at
    each record). A column whose query has no records yet (a reopened document before a refresh)
    keeps what the document carried for it; so does a reference this session has not loaded,
    while its part is there.
  - **Consent.** Only bytes the session holds are written: fetched through the consent gate, or
    read from the document itself. Nothing is fetched to save; a reference with no consent is not
    written; a `data:` reference is not written either (the data carries its bytes).
  - **Cleanup.** After the new index is written, every `assets/` part it does not name is deleted
    (`storage.parts@2`); an empty index deletes `assets.json`.
  - **Restore.** A reference no cache holds is looked up in the open document's index (read once
    per document, when first needed, not at open, so opening a document costs no extra host
    call). Its part is read, checked against its hash, and kept like a fetched asset (memory and
    `host.blob`). A document opened on another machine shows and re-lowers its pictures with no
    consent and no network. A part whose bytes are not its hash is ignored, and the reference is
    fetched as before.
  - **Size.** A `.paged` grows by the raw bytes of every referenced asset (once per distinct
    picture), on top of the processed pictures it places as data URIs. That is the price of a
    document the command line can fill without the server. A link-only column is still a column
    that is not declared an asset column.
  - **IDML** exports are unchanged: an IDML package carries no container parts, and its pictures
    stay links. `paged data apply` on an IDML input reports an asset id `notHeadless` and says so.
  - An `asset:<id>` image value is placed in the editor too: the id is looked up in the index as
    a reference or a content hash (`carriedHash`, `persist.ts`), the part is read and checked
    against its hash, and the asset pipeline places it (through the binding's column chain when it
    has one). An id the document does not carry is not fetched: its binding says why.
  - A remote reference the document carries is placed headless from its part, with no
    `--allow-origin` and no request (core ADR 1014, amendment 6).
  - Tests: `src/__tests__/persist.test.ts` (one part per hash and an index of every reference,
    nothing rewritten when unchanged, stale parts deleted after the index, carried entries kept,
    nothing written that the session never had, the index read back);
    `src/__tests__/assets.test.ts` (a reference the document carries is read from its part with no
    consent or fetch, and kept; a part that is not its hash falls back to the fetch);
    `test/asset-columns-real-core.spec.ts` (save, reopen in another host, placed from the part
    with no network; the column removed, a save drops the parts and the index).
