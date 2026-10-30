# ADR 703 — Where slide-only data lives

- **Status:** Accepted 2026-10-05.
- **Scope:** `packages/slide-bundle`, the engine's page metadata (protocol 68)

## Context

A slide carries data the engine does not model: speaker notes, a transition, a hidden flag,
animation timing, and the identity of its source parts. Some of it must follow the slide through
duplicate, delete and undo; some describes the whole deck and rarely changes.

The host offers two stores: plugin metadata on page items (undoable, travels with the item) and
container parts under the plugin's own path (persisted with the document, not undoable). Plugin
metadata on pages is added by engine protocol 68.

## Decision

| What | Where |
|---|---|
| Speaker notes, transition (original XML and parsed kind, duration, direction), hidden flag, source slide part, layout id | page plugin metadata |
| Placeholder identity, preset geometry name and adjust values, original shape id, the item's slice of the animation timeline and its parsed build steps | item plugin metadata |
| Original `.pptx`, import fingerprint, layout map, theme map, sections, chart parts, font manifest | container parts under `paged/media.paged.slide/` |

## Consequences

- Notes and transitions follow a slide through every operation the host's undo covers.
- Deck-level parts are not undoable; they change only on import, on export and when a layout is
  created, so this is acceptable.

## Amendment (2026-10-20): the deck label is written by the importer

The deck's own label on the document (`x-paged:media.paged.slide`: name, page size, fonts) was
written by the bundle as a mutation right after the open, so every imported deck opened
"Edited", with that write on the undo stack. The importer now writes it into the package with
the page and placeholder labels (`slide_native::deck_label`), and the open makes no edit: an
imported deck opens clean, with nothing to undo (UX audit F-08). The container parts written
after the open are not edits (they are outside the undo log).

## Amendment (2026-10-24): every slide element names its shape

[ADR 711](711-powerpoint-parity-program.md): every element of a slide's shape carries the
shape's key (`<slide part>#<cNvPr path>`) in its item metadata, together with its placeholder,
its preset and its click action (`link`: URL, slide part, show action, tooltip). Export reads
the key to write the shape back from its own XML.

## Amendment (2026-10-29): the theme is in the deck label

[ADR 713](713-live-theme.md): the theme the document shows (name, slot colours, fonts, variant,
the remap of missing references) and the deck's own theme are kept in the deck label, not in a
container part as the table above has it. Applying a theme writes the label in the same batch as
the swatches and styles it changes, so undo puts both back together.
