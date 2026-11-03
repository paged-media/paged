# ADR PM-0018 — Imported document properties travel as a document label

- **Status:** Accepted 2026-11-03.
- **Scope:** `paged_ooxml::docprops`, the doc and slide native builders, `sheet-xlsx`.

## Context

An OOXML package carries title, author, dates and the producing application in
`docProps/core.xml` and `docProps/app.xml`. Nothing read them. The engine document has no
title or author field, and a new field on the model is a wire change (catalog, plugin-api wire
types, canary bump) for text that no renderer uses.

## Decision

- **One reader**, `paged_ooxml::docprops::read`, returns `(name, text)` pairs in file order (core
  names as written, app names prefixed `app.`); doc, slide and sheet use it.
- **No model field.** doc and slide put the pairs into the engine document's own label
  `x-paged:core.docprops` (the designmap label that already carries plugin metadata, written to
  IDML as a document label and read by `SetDocumentMetadata` consumers) as a flat JSON object.
  Sheet has no engine document: `XlsxDocument::properties` holds them for a host.
- **Read only.** A save keeps both parts as the package had them, byte for byte (they are opaque
  parts; slide export still patches only the slide count of `app.xml`).

## Consequences

A document opened from a package with properties gains one label; one without gains none.
Editing the properties, and writing a changed title back, would need a decision on the model
and is not part of this record.
