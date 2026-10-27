# ADR 564 — Data issues: what may be wrong with the placed content, named where it is

- **Status:** Accepted 2026-10-24; amended 2026-10-25 (every placed text, threaded stories,
  pictures from plain links; whose word an overset is, runs at their own sizes, tables).
- **Scope:** `packages/data-bundle/src/issues.ts` (the kinds, the resolution floor, the
  Problems rows), `session.ts` (what each placement leaves to check, `computeIssues`,
  `publishIssues`), `data-door.ts` (`issues`), `assets.ts` (a placed picture's pixel size),
  `flow-writer.ts` (a flow's placed and total records), `property-session.ts` (a text
  variable's frame in the placements); `paged-data-lower`'s `text_words`, `text_overset`,
  `text_overset_chain`, `text_run_words` and `text_overset_runs`
  (`engine/core/crates/paged-data-lower/src/merge.rs`) and their `data-js` surface;
  `merge.ts`'s `storyFaces` (a story's runs and their faces). Serves extensions [ADR 343](../../../../platform/extensions/docs/adr/343-the-data-door.md)'s
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

- **Overset** checks every story paged.data wrote into: the stories a variable was placed in
  (by the door, by Lower, by a record dropped on a design; a placeholder field names its own),
  the frame a table or a flow was lowered into, every frame of the last merge. The host's frame
  chain is believed when it reports overflow. A host that lays text out without fonts (the
  headless host) never does, so the story is also measured, as Data Merge's overset is (DM-7):
  the engine lists the words (`text_words`), the host measures them at the story's font, and
  the engine wraps them and compares lines × leading with the frame (`text_overset`). A story
  threaded over several frames is wrapped through the chain's frames in order, each at its own
  width and holding the lines its height takes (`text_overset_chain`); what is left after the
  last frame is the overset, named at that frame. Each run is measured in its own face
  (`text_overset_runs`): the font, style and size it sets directly (`StoryContent`'s runs),
  the story's where it sets none; a line is as tall as the largest leading on it. The wrap is
  the engine's; the bundle reads the host's geometry.
- **Whose word it is.** Where the host lays the text out, its report is authoritative and
  complete: it is the real composer, so text wrap around other items, tables in the story
  (a cell whose text does not fit its row oversets its story, engine `OversetTextDropped`),
  mixed sizes and every other setting are in it. The measurement is a fallback for a host
  that cannot lay out (the headless host without fonts, which reports no overflow at all), and
  is only asked when the host reported none. Reproducing the composer in the bundle (text wrap
  depends on the geometry and wrap settings of every other page item, a table's rows on cell
  insets, spans and grow rules) would be a second layout engine, with its own drift from the
  first; it is not built. So a measured overset says so in its message ("as measured, an
  estimate"): a user knows when a notice is a measurement rather than the composer's word. The
  `DataIssue` contract is unchanged; the distinction is in the text.
- **Tables.** A table paged.data lowered is checked at its frame like any placed text. When
  the host reports its story overset, the message says that the table does not fit its frame
  or a cell's text does not fit its row: the host reports a cell's overset as its story's, so
  which it is is not known here. The cell is not named, and cells are not measured where the
  host cannot lay out: a row's grow rule (`AutoGrow`, `MaximumHeight`) is not a read the host
  serves, and a cell measured against a row that grows to fit it would be a false notice.
- **Where a text variable is.** A text variable's instances (ADR 559) are not fields the
  document lists by story, and the object model has no selector from a variable to the stories
  its instances are in. So the session keeps the story of every instance it places (the
  placement's own answer), the placements report the story's first frame for the binding, and
  that frame is the binding's element label like a placeholder field's; a reopened document
  finds the story again from the label's frame. The message suggests what the editor offers: enlarge the
  frame, shorten the text, or turn on Auto-Size in Text Frame Options.
- **Low resolution** needs the picture's pixel size. A picture placed through an asset column
  passes through the bundle, whose PNG, GIF and JPEG header read gives it. A picture placed from
  a plain link is asked of the host: `assets.getPlacedImage` answers the engine's decoded copy
  with its natural width and height (the manifest declares `assets: ["images"]` for it). That
  answer carries the file's bytes, so it is read once per placement (a re-lower of the binding
  reads it again) and not while the engine has not drawn the picture yet (it answers nothing
  then, and the picture is not checked until it has). A picture the user relinks by hand keeps
  the size read at its placement until the next one. Fitted proportionally, the longer side sets
  the scale; filled or stretched, the thinner one. The floor is
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
- Every story a data field's text variable has an instance in is checked, a copy the user
  pasted by hand included: a story's runs name the variable they are an instance of
  (`RunContent.textVariable`, engine protocol 76 additive), and paged.data reads every story's
  runs once per document state. Rules are not checked separately: they style the stories the
  variables are in.
- The measured wrap is greedy and per word, as Data Merge's is. A run's size and face come
  from the run, else its character style, else its paragraph's style (read through the object
  model), else the story's. Text wrap and table rows are the host's to report (Decision, "Whose
  word it is"): where the host lays out, its overflow is the composer's and complete.

## Amendments

- Amended 2026-10-25: every text paged.data placed is checked. The session keeps the stories
  its text variables are in (a Lower, a door placement, a record drop), so the placements name
  their frames and the issues check them; a threaded story is measured through its chain
  (`text_overset_chain`, the one-frame rule over a sequence of frames, equal to `text_overset`
  for one); a picture placed from a plain link is checked through the host's
  `assets.getPlacedImage`.
- Amended 2026-10-25: whose word an overset is. The host's report is the composer's and
  complete (text wrap, tables, every size); the measurement is a fallback for a host that
  cannot lay out, and its message says it is an estimate. The measurement sets each run in
  its own face (`text_run_words`, `text_overset_runs`, equal to `text_overset_chain` for one
  face), so a large run in a small story is found where one size would call it fitting. A
  table's overflow names its cells in the message; a cell is not named or measured (no host
  read of a row's grow rule). A copied text variable instance stays unchecked: no host read
  lists the instances (Consequences).
- Amended 2026-10-25: copied instances and style sizes. `RunContent.textVariable` (plugin-sdk
  0.74.3-canary.30) names the variable a run is an instance of, so every story holding one of
  paged.data's text variables is checked, a hand-pasted copy included. A run without its own
  size is measured at its character style's size, else its paragraph style's (`style:<family>/
  <id>` through the object model).
