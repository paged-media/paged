# ADR 705 — PowerPoint is the oracle

- **Status:** Accepted 2026-10-05.
- **Scope:** `scripts/ppt-*`, `slide-conformance`

## Context

The format specification does not say where PowerPoint draws a shape whose placeholder inherits
from a layout, how it wraps text after autofit, or which preset geometry guide formula it
evaluates with which rounding. The Word plugin answered the same question by recording Word's
own output.

## Decision

Fidelity is judged against PowerPoint. Scripts drive PowerPoint through AppleScript to export each
deck as PDF and one PNG per slide, and to dump each shape's position, size, rotation, autofit state
and effective run sizes as JSON. The recordings are committed under `slide-conformance/fixtures`;
tests compare the engine's render of the imported deck with them. Only maintainers with PowerPoint
re-record.

Feature fixtures (preset geometries, placeholders, autofit, lists, tables, transitions, builds,
notes, embedded fonts) are authored through PowerPoint itself, so every fixture is a file
PowerPoint wrote.

## Consequences

- Tests run anywhere from the recordings; recording needs a Mac with PowerPoint.
- A PowerPoint update can change an answer; recordings carry the version they came from.
