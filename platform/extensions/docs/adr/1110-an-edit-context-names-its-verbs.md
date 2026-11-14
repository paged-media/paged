# ADR 1110 — An edit context names its verbs (`verbs`)

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/plugin-api/src/host.ts` (`ObjectVerb`, `EditContextContribution.verbs`),
  `index.ts` (the export). plugin-sdk passes the field through unchanged (its `editContext`
  stamps a copy of the contribution). plugin-sdk and plugin-api move to the next canary. Decided
  with the editor's [ADR 1242](../../../../apps/editor/docs/adr/1242-every-object-answers-the-same-verbs.md).

## Context

The editor gives every object one set of verbs — inspect, transform, copy, bind to data, style,
version, validate, export — as host commands in the context menu and the palette (editor ADR
1242, the strategy's Concept J). Inside a module's frame most of them mean something the module
does better: a sheet's Copy copies the selected range's values, its Export writes the sheet as
CSV; an image's Transform is its Free Transform, its Version a snapshot of its own journal. The
host cannot know a module's commands, and a table of module command ids in the editor would be
module identity in host code.

## Decision

One type and one optional field:

- **`ObjectVerb`** — `"inspect" | "transform" | "copy" | "bindData" | "style" | "version" |
  "validate" | "export"`.
- **`EditContextContribution.verbs?: Partial<Record<ObjectVerb, string>>`** — for each verb the
  module implements, the id of a command the bundle registered, run with no payload on what the
  context edits. While the context is active, or its frame is selected, the host's verb command
  runs it; a verb not named falls back to the host's own. A named command the editor does not
  have falls back too.

## Consequences

- The built-ins name theirs: sheet (Copy → `copySelection`, Export → `exportCsv`), image
  (Transform → `freeTransform`, Version → `newSnapshot`, Export → `exportAs`), data
  (Bind to data → `bindProperty`). The other contexts answer with the host's verbs.
- A community module gets the same reach with no host change.
- plugin-sdk and plugin-api `0.74.3-canary.105`.
