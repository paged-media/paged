# ADR 701 — `paged-ooxml` is vendored from the Word plugin until it is published

- **Status:** Accepted 2026-10-05.
- **Scope:** `vendor/paged-ooxml`, `scripts/sync-ooxml.sh`

## Context

`paged-ooxml` (OPC container, relationships, content types, a typed DOM over `ooxmlsdk`) was
written in the Word plugin as the shared OOXML foundation for the Word, spreadsheet and slide
plugins. It is not published, and a path or git dependency from this repository into another
plugin's repository would break the isolation contract.

## Decision

This repository carries a verbatim copy in `vendor/paged-ooxml`. `vendor/paged-ooxml/SYNCED`
records the source commit and a hash of the copied tree; `scripts/sync-ooxml.sh --check` fails
when the copy drifts from that hash, and `scripts/sync-ooxml.sh <plugin-doc checkout>` re-vendors
it. Changes to the crate are made in the Word plugin first.

When the crate is published as its own package, the vendored copy is replaced by a registry
dependency and this record is superseded.

## Consequences

- The two plugins read packages with the same code without depending on each other.
- A fix in one copy needs a re-sync in the other; the drift check makes a local edit visible.
