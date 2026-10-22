# paged.slide documentation

- [concept.md](concept.md) — what the plugin is and how a deck maps onto the engine
- [architecture.md](architecture.md) — crates, packages and the data flow
- [status.md](status.md) — what is built
- [adr/](adr/README.md) — decision records 700–749

## Tests

Each surface the bundle contributes has a test that asserts what it does, tagged with
`covers()` for the surface-conformance gate (the overview is
`platform/extensions/docs/testing-plugins.md`). All of them are in
`packages/slide-bundle/test/`.

| Layer     | Files                                                                                                            | What they assert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit      | `commands-unit.spec.ts`, `activate.spec.ts`, `conformance.spec.ts`, `export.spec.ts`                             | `newSlide` and `importPptx` on a recording fake editor: the one `insertPage` a new slide is, where it goes, its refusals (not a deck, an unknown slide, a refused insert) with the document untouched; the IDML package an import opens, the door it goes through, the deck label it writes as one batch and the source deck it keeps as a container part. The importer on a recording host and on the real engine (a deck with embedded fonts opens with its faces); the exporter writing the original bytes back, and edits (reorder, duplicate, delete, hide, notes) carried into the deck. |
| headless  | `headless/object-model.spec.ts`, `headless/object-model-page-labels.spec.ts`, `headless/template-fields.spec.ts` | The typed commands through `host.objects` on the real engine: an import opens a slide per page, `newSlide` adds one with its layout's placeholders, emptied (undo removes it, redo brings it back), `duplicateSlide` copies one after itself, `slide.index` moves one, `exportPptx` writes the deck; slide data lives on page labels and survives a save. The template field kinds as a filler: read, written, a refused value, a refused write outside the field.                                                                                                                             |
| component | `panels/*.dom.test.tsx` (`bun run test:dom`, happy-dom)                                                          | The Slides panel lists the deck and its buttons (go to, duplicate, hide, delete, new slide) change the document, each one undo step; the Notes panel follows the active slide and writes an edit on blur; the Slide, Transition, Placeholder and Deck schema panels, rendered through the SDK's schema-panel component and a minimal renderer (`panels/schema-renderer.tsx`), show what is selected and write through the object model, with read-only rows as readouts.                                                                                                                       |

The fixtures are the PowerPoint-authored decks in `slide-conformance/fixtures/`.

## Template fields

A template (engine ADR 1000, extensions ADR 335) can open parts of a deck to a filler.
Two kinds, in `packages/slide-bundle/src/template-fields.ts`:

| Kind                                | Definition                                 | Control                                | What a value does                                                                                                       |
| ----------------------------------- | ------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `media.paged.slide.placeholderText` | `{ placeholder?: { type, idx? }, slide? }` | text; one line for a title or subtitle | `placeholder.content`: the placeholder's story text, keeping its formatting; a line break in a body starts a paragraph. |
| `media.paged.slide.visibility`      | `{ slide? }`                               | toggle (on: the slide is shown)        | `slide.hidden`, the flag in the slide's page label.                                                                     |

A placeholder field sits on the placeholder's frame; without a definition the field's item
is the placeholder, with one it names a placeholder by PowerPoint's type and index on
`slide` (a slide address, a page id or a number from 1; the field item's slide when absent).
A slide is a page and carries no field of its own, so a visibility field sits on an item of
its slide (its title, say) or names `slide`.

`placeholderText` grants `text.edit`, which the engine checks on the placeholder's story:
a filler writes the field's placeholder and is refused on any other. `visibility` declares
`item.visibility`, but the engine checks a page label write as `document.metadata` on the
whole document, so a filler can show or hide a slide only in a template that grants
`document.metadata` document-wide; otherwise the field reports that it needs it. Pictures,
charts, tables and notes cannot be fields yet.
