# ADR 1108 — An edit context names what entering it does (`editLabel`)

- **Status:** Accepted 2026-11-14.
- **Scope:** `packages/plugin-api/src/host.ts` (`EditContextContribution.editLabel`); the editor's
  `packages/shell/src/state/frame-content.ts` (`frameLevels`). plugin-sdk passes the field
  through unchanged. plugin-sdk and plugin-api move to the next canary. Amends
  [ADR 1106](1106-an-edit-context-says-how-it-is-left.md).

## Context

ADR 1106 gave a context a `label`, its name in the editor's language, shown in the breadcrumb,
the context toolbar and the editor's Frame / Content / Edit control. In the level control the name
reads as a noun beside "Frame" ("Frame · Spreadsheet"), while the control's other levels are what
the user does there: a picture frame's third level is "Edit image". The UX strategy asks for a
clear transition from a selected sheet frame to "Edit cells"; the module knows the verb, the host
does not.

## Decision

One optional field on `EditContextContribution`:

- **`editLabel?: string`** — what entering the context does, as a verb in the editor's language
  (`host.strings.t`): "Edit cells", "Edit source". The host names the frame's Edit level with it
  in the level control; the breadcrumb and the context toolbar keep `label`, the context's name.
  Absent or blank: the label (ADR 1106), else the type as words.

No feature flag: a host that does not read the field shows the label, as before.

## Consequences

- paged.sheet declares "Edit cells" (sheet ADR 532): a selected sheet frame reads
  **Frame · Edit cells**; inside, the trail reads "Spreadsheet".
- A community context that declares nothing is unchanged.
- No field is required; the canary moves because the contract's text changed.
