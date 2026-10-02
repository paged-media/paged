# scripts/illustrator — Adobe Illustrator as the oracle for paged.draw

Ask Illustrator what the right answer to a path operation is, record it,
and replay the recording against the real headless engine. The model is
plugin-doc's Word probes (`docx-conformance/fixtures/*.word.json`) and
core's `tools/indesign-export`.

**CI never drives Illustrator.** It replays the committed fixtures in
`packages/draw-bundle/test/fixtures/oracle/*.illustrator.json` through
`packages/draw-bundle/test/oracle/*.spec.ts`. Recording is a maintainer
action on a Mac with Illustrator installed.

```
scripts/illustrator/
  run-probe.sh            the runner: consent check, ping, run, judge, write
  lib/probe-lib.jsx       prepended to every probe: JSON, coordinates, measuring
  lib/write-fixture.mjs   judges Illustrator's reply; writes the fixture
  probes/<probe>.jsx      ONE Illustrator operation, explicit inputs in points
packages/draw-bundle/test/
  oracle/oracle.ts        fixture shape, loader, area / bounds / winding
  oracle/<probe>.spec.ts  engine vs the recording (and vs closed form)
  fixtures/oracle/<probe>.illustrator.json   the recorded answer
```

## Status: nothing is recorded yet

As of 2026-10-02 **no fixture exists**. Illustrator 30.1.0 (build 136,
a German install) is installed and launches, but macOS had not been allowed to let
the recording shell control it, and the prompt could not be answered from
that shell:

- `AEDeterminePermissionToAutomateTarget` for `com.adobe.illustrator`
  answered **-1744** (`errAEEventWouldRequireUserConsent`); the same call
  answered 0 for InDesign and for Word, which is why those oracles work
  from the same shell.
- Every Apple event to Illustrator then timed out (**-1712**) while a
  `UserNotificationCenter` alert sat on screen. Its text was not readable
  from the shell (no Screen Recording, no Accessibility); macOS 26.4's own
  string table gives the German wording as: *„Antigravity IDE“ möchte
  Zugriffsrechte, um „Adobe Illustrator“ zu steuern. Durch die Erlaubnis
  zum Steuern kann auf Dokumente und Daten in „Adobe Illustrator“
  zugegriffen werden und Aktionen können in dieser App durchgeführt
  werden.* — buttons *Nicht erlauben* / *Erlauben*, with the controlling
  app's own line *An application in Antigravity IDE wants to use
  AppleScript.*
- Illustrator's main thread was idle in its event loop the whole time
  (`sample`): no modal dialog, no running script. The events never arrived.

So the offset-path probe has been checked against everything except
Illustrator: the object model on disk, an ES3 parser, and a fake DOM. Its
first real run is still ahead, and `offset-path.spec.ts` carries an
`it.todo` — not a pass — where the replay will be.

## Record (or re-record) one probe

```bash
bash scripts/illustrator/run-probe.sh \
  scripts/illustrator/probes/offset-path.jsx \
  packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json

pnpm --filter @paged-media/draw exec vitest run test/oracle
```

The first run from a new terminal or IDE raises the consent prompt above;
answer *Erlauben* / *Allow* (or System Settings › Privacy & Security ›
Automation › *your terminal* › Adobe Illustrator) and run it again.

Re-record **one probe at a time** and read the diff: a fixture is baked
evidence, and the file is laid out one anchor per line so that a changed
answer diffs as geometry. `produced_by` says which Illustrator version,
build and locale answered, and carries the sha256 of the exact script
text it was handed.

Exit codes: `0` recorded · `2` usage, or a probe that cannot be sent ·
`3` Illustrator did not answer · `4` it answered with something that is
not a recording (nothing is written).

## When the recording disagrees with the engine

Do not widen a tolerance to make it pass. The tolerances are stated in
`oracle.ts` (area 0.1 % relative, bounds 0.05 pt, anchor count exact) and
compare SHAPE — start point and direction may differ. Classify:

- **convention** (miter-limit semantics, how many cubics an arc gets):
  assert the recorded difference with both numbers in a comment;
- **defect**: `it.fails`, both numbers in the title or a comment, so it
  is visible and turns red the day the engine is fixed.

One is already there without Illustrator's help: the engine's
`offsetPath` ignores `join` and `miterLimit` — every outward corner is a
bevel (rect +10 pt: area 9400 for all three joins; a miter is 9600, a
round join 9514.16). See the header of `offset-path.spec.ts`.

## How Illustrator is asked

| Operation | Mechanism | Confirmed by |
|---|---|---|
| Offset path | `PageItem.applyEffect('<LiveEffect name="Adobe Offset Path"><Dict data="R mlim 4 R ofst 10 I jntp 2 "/></LiveEffect>')` then `app.executeMenuCommand("expandStyle")` | effect name and the keys `ofst` / `jntp` / `mlim` are strings in `OffsetPath.aip`; `applyEffect` and `executeMenuCommand` are in the object model. **Not yet run.** The `jntp` values (0 round, 1 bevel, 2 miter) are in no dictionary on disk — the spec checks them against the closed form on first recording. |

The menu versions of Offset Path (Object › Path and Effect › Path) open a
dialog that `executeMenuCommand` cannot fill in, so they are unusable with
alerts suppressed.

Not written yet — the brief was one proven slice before the next, and the
slice is not proven. What the app's own files already say about them, as
leads and nothing more:

- **Outline stroke**: `OffsetPath.aip` also registers a live effect named
  `Adobe Outline Stroke`; `PathItem` has `strokeWidth`, `strokeCap`
  (`BUTTENDCAP` / `ROUNDENDCAP` / `PROJECTINGENDCAP`), `strokeJoin`,
  `strokeMiterLimit`.
- **Booleans and region verbs**: the keyboard-shortcut table lists
  `Live Pathfinder Add / Subtract / Intersect / Exclude / Divide / Trim /
  Merge / Crop / Outline / Minus Back`. These are effects on a GROUP and
  need `expandStyle` afterwards.
- **Compound paths**: `compoundPath` / `noCompoundPath`;
  `PathItem.polarity` and `.evenodd` are in the object model.
- Also present: `OffsetPath v22`, `OffsetPath v23`, `simplify menu item`.

Where to look, since `sdef` needs full Xcode: the AppleScript dictionary
is `Adobe Illustrator.app/Contents/Resources/Adobe Illustrator.sdef`; the
ExtendScript object model is `/Library/Application Support/Adobe/Scripting
Dictionaries CC/Illustrator 2026/omv.xml`; menu command strings are the
keys of `Presets.localized/<locale>/Tastaturbefehle/*.kys`.

## Traps

1. **Automation consent is per target app.** A shell that may drive
   InDesign and Word may not drive Illustrator, and the failure is a
   silent timeout, not an error. `run-probe.sh` asks macOS first, without
   prompting, and names the state in its message.
2. **`get version` is not a ping.** It returned `30.1.0` while every
   real event to the app timed out, so it proves nothing about
   reachability. The runner pings with `do javascript`.
3. **`activate` works without consent** (it is LaunchServices, not an
   Apple event). A launched, frontmost, unreachable Illustrator is what an
   unanswered prompt looks like.
4. **Illustrator scripts in points, Y up**, whatever unit the rulers
   show (recorded as provenance, never used). The library maps through
   the scratch artboard's own rectangle and records it, so fixtures are
   page-local, origin top-left, Y down — the engine's frame. Mirroring Y
   flips the sign of an area: `winding` is stated in the engine's frame,
   and Illustrator's signed `area` and `polarity` are kept raw beside it.
5. **The probe is handed over as text**, library prepended, read by
   AppleScript. Illustrator never reads a file, so there is no staging
   directory it must be able to reach (the Office probes' most expensive
   trap). The runner's own staging defaults to `mktemp` under `$TMPDIR`;
   set `PAGED_PROBE_STAGE` to keep it somewhere specific. It is kept on
   failure, with the raw reply.
6. **ExtendScript is ES3**: no `JSON`, no `let`, no `Array.map`, no
   trailing commas. The library carries its own serialiser. Sources must
   be plain ASCII — the runner refuses anything else before launching.
7. **Judge the artifact.** The probe always returns a JSON string, with
   an `error` per failed case; `write-fixture.mjs` refuses a reply that
   does not parse, has no cases, has any `error`, has a case with no
   resulting path, or reports a different number of open documents after
   than before. A refused reply writes nothing. One `error` is raised by
   the library itself: a case whose result IS its input. An effect name
   the app does not recognise does nothing and says nothing, and the
   untouched input would otherwise be recorded as Illustrator's answer.
8. **No dialog may wait.** The probe sets
   `UserInteractionLevel.DONTDISPLAYALERTS`, restores it, and closes its
   scratch document with `SaveOptions.DONOTSAVECHANGES` in a `finally`.
   The runner pings again afterwards: an app that stopped answering has a
   modal open. Do not `kill -9` it — a killed Adobe app returns with a
   recovery dialog.
9. **The engine's straight edges are cubics** with handles at the third
   points, snapped to a 1/64 pt grid (up to 0.011 pt off the chord);
   Illustrator's are corner points. `oracle.ts` counts curved SEGMENTS
   with a 0.02 pt tolerance for exactly this reason.
