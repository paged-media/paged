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
