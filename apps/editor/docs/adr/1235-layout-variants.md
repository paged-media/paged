# ADR 1235 — Layout variants

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/repository/src/library.ts` (`variants`, `createVariant`, `promoteVariant`,
  `removeVariant`, `variantRef`, a save on a variant's ref), `packages/shell/src/state/library-document.ts`
  (the layout open: `currentLibraryRef`, a save commits there), `state/open-library-document.ts`
  (`variant`); `apps/canvas/src/variants/variants.ts` (new: making, opening, promoting, and the
  shared changes' plan and application), `panels/variants-panel.tsx` (new: Layout variants), the
  compare dialog of [ADR 1234](1234-named-checkpoints.md), `panels/built-in-panels.tsx`,
  `panels/window-categories.ts`. The UX strategy's Concept D; task PX5 of
  [`interaction-plan.md`](../interaction-plan.md). Builds on [ADR 225](225-the-local-library.md).

## Context

A designer who wants a compact, an image-heavy and a long-description version of one layout
duplicates the file, and from then on every change to a shared style or picture is made three times
or forgotten. Undo is no answer: it walks back through one line of states and throws the
alternative away. The strategy asks for named alternatives of one layout without duplicating the
document, compared side by side (changed frames, typography differences, content substitutions),
with shared style and picture changes propagated only when the user asks, and the variants'
own overrides kept.

## Decision

1. **A variant is a branch of the document's repository**: a draft ref of the library's person,
   `drafts/<person>/variants/<slug>`, branched from main, listed in `repos/<id>/variants.json`
   (its name and the main version it was branched from). It shares main's history and stores
   each part once; no file is duplicated. New variant… in Window ▸ Object & Layout ▸ Layout
   variants keeps the open layout, saved or not, as the variant's first version; the open document
   stays what it was.
2. **Opening a variant makes the editor's saves commit there.** Open (the replace question first
   when the open layout has unsaved work) loads the variant's version and records it as the open
   layout (`currentLibraryRef`); File ▸ Save commits to the variant's ref, never main; opening the
   main layout, another document or a file makes main the target again. The panel marks the
   layout that is open.
3. **Side by side.** Compare with main, or any two layouts, opens the compare dialog of ADR 1234
   with both read from the library into a second engine: two read-only renders with the regions
   that differ boxed, and the frames moved, resized, restyled, added or removed, the pictures
   substituted, the text, formatting and style definitions that differ, listed.
4. **Make main is a new version of main.** It keeps the open layout as the checkpoint "Before
   promoting <name>", commits the variant's state on main ("Restore …"; main's versions stay in its
   history), and opens the main layout. The variant stays a variant. Remove takes a variant off the
   list; its versions stay in the history (the repository never deletes a ref).
5. **Shared changes only when applied.** Apply shared changes to variants… (offered while the
   main layout is open) reads three states for each variant in a second engine — main as it was
   when the variant was made, main's saved version now, the variant now — and previews, per
   variant, the paragraph and character style properties main changed and the variant did not,
   the pictures main replaced and the variant did not, and what the variant changed itself and
   keeps as its own override. Nothing changes until Apply: each variant is then opened in a second
   engine, given main's style properties (`setStyleProperty`, one batch) and pictures
   (`relinkImage` with the picture's bytes from main, its frame and fitting kept), and saved as a
   new version of the variant. The open document is not touched.

## Consequences

- A variant is a layout, not a step: it is never on the undo history, and undo never crosses into
  another variant.
- Shared changes cover style definitions and placed pictures, by their ids in both layouts; a
  frame, a story or a swatch changed on main stays main's until the user copies it.
- Saving a variant also writes or downloads the `.paged` file as every save does (ADR 1203): a
  file is a projection of whichever layout was saved last; the library keeps them apart.
- Tests: `packages/repository/test/library.test.ts` (a variant branches from main and shares its
  history; a save on it leaves main; slugs; promote is a new version of main; remove),
  `apps/canvas/test/unit/variants/plan.test.ts` (what a variant takes and what it keeps),
  `apps/canvas/test/panels/variants-panel.dom.test.tsx`, `apps/canvas/tests/e2e/px-variants.spec.ts`
  (New variant, Open and a save on the variant, Compare with main listing the moved frame, Make
  main opening main with the variant's layout, a style main changed applied after its preview and
  nothing left to apply).
