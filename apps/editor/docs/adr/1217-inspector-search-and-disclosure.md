# ADR 1217 — Inspector search and disclosure

- **Status:** Accepted 2026-11-13.
- **Scope:** `apps/canvas/src/panels/properties-panel.tsx` (the sections, the search, the
  groups, the scope header), `panels/inspector/inspector-disclosure.ts` (new: the remembered
  disclosure, setting `paged.inspector.disclosure.v1`), `packages/shell/src/catalog/property-search.tsx`
  (new: the search's terms and its context), `catalog/leaves.tsx` (a collapsed composition
  section opens on a match), `state/selection-context.tsx` (`SelectionSubset`),
  `catalog/object-model.tsx` (`commitEach`), the control bar's "More…"
  (`apps/canvas/src/cockpit/control-bar.tsx`, `cockpit/inspector-focus.ts`) and the search
  highlight in `styles/globals.css`. `UXI-PNL-001`, `UXI-PNL-003`, `UXI-PNL-010`, `UXI-SEL-016`
  and `UXI-SEL-017` of the interaction specification
  ([ADR 1200](1200-the-interaction-contract-is-adopted.md)) and decision D-16 of
  [ADR 1201](1201-interaction-decisions.md); the UX strategy's §5.1 and §5.3 to §5.6; tasks FI2
  and FI3 of [`interaction-plan.md`](../interaction-plan.md).

## Context

Properties stacked every section the selection allows, open, in one column: a text frame
with a caret showed Character, Paragraph, the frame's Transform and Stroke, about sixty fields,
and finding "tracking" or "corner radius" meant knowing which section held it. Plugin
sections (a web frame's, a draw recipe's) sat among them with no group. A multi-selection
read "Frame · 3 frames" whatever the frames were, and a section that applied to some of them
(Fitting, for the frames holding a picture) wrote to all and was refused as one batch (ADR 249).
The control bar repeated the inspector's fields with no way into the rest.

## Decision

1. **Search.** Properties has a search field. A query matches a section by its title, its
   group, its keywords and synonyms (one localized message per section: "border, outline,
   weight" finds Stroke, "Kontur" too), the labels, titles, sub-labels, option labels and
   binding paths of the compositions it renders (`compositionTerms`), and the text a plugin's
   section shows (its schema rows' labels, read from the rendered section). Matching sections
   open and are marked for as long as the query lasts, the others hide, and the labels that
   matched are highlighted; a collapsed sub-section ("Dashes & arrows") that holds a match
   opens too (`PropertySearchProvider`). Enter goes to the first matching field; Escape clears
   the query; no match says so. Clearing restores the disclosure the user left.
2. **Disclosure.** Each section is common or advanced: common sections start open, advanced
   ones collapsed (in text, the frame's Stroke). What the user opens or closes is remembered
   per inspector kind (text, image, frame, page) in `paged.inspector.disclosure.v1`, read with
   a shape check (ADR 247). Collapsed sections stay mounted and hidden, so their bindings are
   live and search can read them.
3. **Groups.** Sections are grouped Frame (Transform, Stroke), Content (Fitting, a plugin's
   own section) and Text (Character, Paragraph), each group named when more than one is shown.
   Text still leads with a caret (PN-22).
4. **Scope.** A multi-selection states what it holds: "3 objects · 2 text frames, 1 image",
   with the objects listed on request and each one selectable on its own, and a line saying
   that a relative entry ("+=5 mm", "*110%") changes each object by its own value (ADR 1216).
   A section that applies to part of the selection says "Applies to 2 of 3", edits those
   objects only (the stated subset of D-16: `SelectionSubset` narrows the selection its
   bindings see) and offers to select them. Properties written through the object model
   (`useObjectProperty`) gain `commitEach`, so a relative entry over a mixed selection is one
   batch, one undo step.
5. **The control bar is an accelerator** (the strategy's §5.6). It keeps the common fields per
   selection type (an object's position, size, angle, stroke, opacity and arrangement; text's
   styles, font, size, leading and alignment) and ends with "More…", which opens Properties and
   focuses the matching field (an object's X, text's size); Enter or Escape there gives focus
   back to "More…" through the focus-return service ([ADR 1206](1206-focus-returns-to-the-opener.md)).

## Consequences

- The section order inside a kind follows the groups: an image's Fitting comes after its
  Transform and Stroke.
- A field in a collapsed section is in the DOM but hidden; a spec that types into one opens
  its section first.
- Tests: `apps/canvas/test/panels/properties-inspector.dom.test.tsx` (search by synonym, label
  and sub-section; no match and Escape; disclosure per kind and its storage; groups; the scope
  header; "Applies to 1 of 2" writing the subset), and `tests/e2e/uxi-fields.spec.ts`
  (`UXI-PNL-001`, `UXI-PNL-010` and "More…" in the running editor, with the document and the undo
  log).
