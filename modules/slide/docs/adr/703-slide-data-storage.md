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
