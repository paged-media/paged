# ADR 564 — Data issues: what may be wrong with the placed content, named where it is

- **Status:** Accepted 2026-10-24.
- **Scope:** `packages/data-bundle/src/issues.ts` (the kinds, the resolution floor, the
  Problems rows), `session.ts` (what each placement leaves to check, `computeIssues`,
  `publishIssues`), `data-door.ts` (`issues`), `assets.ts` (a placed picture's pixel size),
  `flow-writer.ts` (a flow's placed and total records); `paged-data-lower`'s `text_words` and
  `text_overset` (`engine/core/crates/paged-data-lower/src/merge.rs`) and their `data-js`
  surface. Serves extensions [ADR 343](../../../../platform/extensions/docs/adr/343-the-data-door.md)'s
  `DataService.issues`; shown by editor
  [ADR 291](../../../../apps/editor/docs/adr/291-the-data-panel.md) (amended 2026-10-24).

## Context

Content placed from data is not reviewed line by line: a catalogue of a thousand records is
generated. A product name longer than its frame, a photo the server did not give, a 300-pixel
logo stretched over a half page or an empty price are found at proof, or in print. Data Merge
reports overset records after a merge, and the record flow paginator reports records it could
not place, each in its own status line, gone at the next command.

## Decision

**The data door serves the issues** (`issues()`), read when asked, each with a kind, a
severity, a message that says what to do, and where it is: the binding, the page item (ADR 131
address) and the record when known.

| Kind              | Severity | From                                                                        |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `overset`         | warning  | a text paged.data placed whose frame chain overflows                        |
| `missingAsset`    | error    | an asset column's reference that could not be had, or a flagged empty one   |
| `lowResolution`   | warning  | a placed picture under 150 ppi at its size in the frame                     |
| `emptyValue`      | info     | a placed variable whose resolved value is empty                             |
| `error`           | error    | a binding in the error sync state, with the last error reported for it      |
| `unplacedRecords` | warning  | a record flow the paginator could not place every record of                 |

- **Overset** checks every story paged.data wrote into: the frames a variable was placed in
  through the door (and a placeholder field's story), the frame a table or a flow was lowered
  into, every frame of the last merge. The host's frame chain is believed when it reports
  overflow. A host that lays text out without fonts (the headless host) never does, so a
  one-frame story is also measured, as Data Merge's overset is (DM-7): the engine lists the
  words (`text_words`), the host measures them at the story's font, and the engine wraps them
  and compares lines × leading with the frame (`text_overset`). The wrap is the engine's; the
  bundle reads the host's geometry. The message suggests what the editor offers: enlarge the
  frame, shorten the text, or turn on Auto-Size in Text Frame Options.
- **Low resolution** is reported only where the pixel size is known cheaply: a picture placed
  through an asset column, whose bytes pass through the bundle (the PNG, GIF and JPEG headers are
  read). A picture placed from a plain link is not checked: its bytes never reach the bundle,
  and the engine's links collection does not carry a pixel size. Fitted proportionally, the
  longer side sets the scale; filled or stretched, the thinner one. The floor is
  `LOW_RESOLUTION_PPI` (150): offset print asks for 300, under 150 the pixels show at reading
  distance. A warning: a coarse picture may be meant.
- **Every fact is the engine's or the host's.** The sync state, the resolved value and the
  paginator's overflow are the engine's answers; the wrap is the engine's; the frame chain and
  the sizes are host reads. Nothing about the data is decided in TypeScript.
- **Problems.** The session publishes the issues under the key `issues` of
  `host.diagnostics` after a lower, a refresh, a merge or a placement, and after an edit, once
  for a burst (250 ms), where the host has a Problems panel listening
  (`diagnostics.publish@1`); every `issues()` read publishes too, and an empty list clears them.
  A diagnostic has no document location, so the page item's address is its `source`; the Data
  panel's issues line selects the items.
- **Off the command path.** No command reads the issues inline: a lower or a merge costs what
  it cost, and a host without a Problems sink reads them only when asked. Whether the host has
  one is asked once, at activation (the W7 boot budget moves by that one call).

## Consequences

- The Data panel shows one line ("2 texts do not fit · 1 picture missing") that selects the
  frames concerned, and the canvas field markers draw an issue's frame in the error red
  (editor ADR 291, amended 2026-10-24).
- A text variable's instances are found only where paged.data placed them through the door: a
  variable placed by Lower into a frame it minted is not in the placements yet, so its story is
  not checked. Rules are not checked separately: they style the stories the variables are in.
- A multi-frame story is believed as the host reports it; it is not measured.
