# ADR 254 — Engine values read in words

- **Status:** Accepted 2026-10-20.
- **Scope:** `platform/shared/panel-kit/src/enum-labels.ts` (`enumMemberLabel`,
  `humaniseIdentifier`), `packages/shell/src/catalog/property-field-model.ts` (`optionsFor`,
  `itemTitle`), `packages/shell/src/catalog/use-collection.ts` (`useCollectionNames`), the
  options panels' picker (`AddressListPanel`), the core command dialog, and the panels that
  list hyperlinks, bookmarks, cross-references, stories, spreads and library versions.

## Context

Root R13 of the conformance findings (UX audit F-22): panels showed the engine's own
identifiers. A schema-driven select listed every enum member as itself (`LeftAlign`,
`UserModifiedPath`, `RoundedCorner`, `StrokeStyle/$ID/Japanese Dots`); a reference was shown as
its id (`Color/u12` on a gradient stop, `Hyperlink/u…`, `CrossReferenceFormat/u1`, a story's
`u240c3b`, a guide's `Guide/…`); a create form asked for a `selfId`; a library version was
labelled by its content hash.

## Decision

1. **An enum member reads in InDesign's words**, in the editor's sentence case: the panel kit
   holds one table for every member the engine catalog declares (Paragraph Style Options'
   Left / Center / Full justify / Towards spine, Text Wrap's Bounding box / User-modified path,
   Corner Options' Rounded / Inverse rounded / Bevel, the arrowheads' Simple / Triangle - wide,
   the numbering styles as `1, 2, 3, 4…`), and anything the table lacks is humanised (the last
   segment of an IDML reference; camel case split into words). A label the panel gives still
   wins. No select can show a camel-cased id again.
2. **A reference reads as the name of what it references.** A list item titled by a field that
   picks from a collection is titled by that member's name (`useCollectionNames`); the gradient
   ramp's stop handles likewise. A picker over objects asks the kind's name path (a text
   variable's is `textVariableName`) or a describer (a condition's collection name; a guide is
   "Vertical guide at 100 pt, page 1").
3. **What is not a name is described, not printed.** A hyperlink with no name of its own is
   named after its URL, else "Hyperlink n", as InDesign's panel does; a destination reads as
   its URL or its page ("Page 3"); a cross-reference shows its format's name. The engine adds
   `BookmarkSummary.destinationPage` and `CrossReferenceSummary.formatName` (additive wire
   fields) so the panels need not resolve ids. A spread's folio label, prefixed or roman
   (`B-1`, `iv`), is not a name either: the spread reads "Spread n".
4. **Ids stay out of sight.** A story row drops its id (it stays searchable); a create form
   does not ask for an optional `selfId` (the engine mints one); a library version reads
   "Version n · author", with the hash in the tooltip.

## Consequences

- PN-1, PN-102 to PN-105, PN-107, PN-110, PN-154, PN-156, PN-161, PN-166, PN-167, PN-201,
  PN-205 to PN-207, PN-256 and PN-353 close.
- A new enum in the engine catalog reads in humanised words until the table names it; add it
  there when the generic form is not InDesign's.
