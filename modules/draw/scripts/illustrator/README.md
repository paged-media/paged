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

## What is recorded

Recorded with **Adobe Illustrator 30.1.0** (build 136R, de_DE, macOS
26.4) on 2026-10-02. Each fixture's `produced_by` is the authority.

| Probe | Cases | What Illustrator said |
|---|---|---|
| `offset-path` | 17 | Exactly the closed-form miter / bevel / inward geometry. Miter limit is the stroke rule (mitered while `1/sin(angle/2) <= limit`, bevelled past it). Round joins are cubic arcs, one per 90 degrees or less, so areas bulge by about +0.001 %. Every result is clockwise whatever the input. |
| `outline-stroke` | 11 | Exactly the stroke's closed form for all nine cap × join pairs, same miter-limit rule. One SIMPLE clockwise outline that does not overlap itself. |

## Record (or re-record) one probe

```bash
bash scripts/illustrator/run-probe.sh \
  scripts/illustrator/probes/offset-path.jsx \
  packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json

pnpm --filter @paged-media/draw exec vitest run test/oracle
```

The first run from a new terminal or IDE raises a macOS consent prompt
(*„<your terminal>“ möchte Zugriffsrechte, um „Adobe Illustrator“ zu
steuern* / *wants access to control Adobe Illustrator*). Answer
*Erlauben* / *Allow* while the runner waits — `PAGED_PROBE_PING_TIMEOUT=300`
gives you five minutes instead of one.

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

Every difference found so far is written up, with both numbers, in the
header of the spec that pins it.

## How Illustrator is asked

| Operation | Mechanism | Confirmed by |
|---|---|---|
| Offset path | `PageItem.applyEffect('<LiveEffect name="Adobe Offset Path"><Dict data="R mlim 4 R ofst 10 I jntp 2 "/></LiveEffect>')` then `app.executeMenuCommand("expandStyle")` | Recorded. `jntp` is 0 round / 1 bevel / 2 miter (in no dictionary; settled by the recording). `expandStyle` leaves one plain path. |
| Outline stroke | stroke set on the `PathItem` (`strokeWidth`, `strokeCap`, `strokeJoin`, `strokeMiterLimit`), then `app.executeMenuCommand("OffsetPath v22")` | Recorded. No dialog. The live effect `Adobe Outline Stroke` + `expandStyle` returns the identical path. |

The menu versions of Offset Path (Object › Path = `OffsetPath v23`, and
Effect › Path = `Live Offset Path`) open a dialog that `executeMenuCommand`
cannot fill in, so they are unusable with alerts suppressed. Never guess
at a menu command string: one that opens a dialog leaves it open.

Where to look, since `sdef` needs full Xcode:
- the AppleScript dictionary:
  `Adobe Illustrator.app/Contents/Resources/Adobe Illustrator.sdef`;
- the ExtendScript object model: `/Library/Application Support/Adobe/
  Scripting Dictionaries CC/Illustrator 2026/omv.xml`;
- which menu item a command string IS: the map in
  `Adobe Illustrator.app/Contents/Required/UXP/extensions/
  com.adobe.unifiedpanel/js/143.js` (`"Object-Path-Outline_Stroke":
  "OffsetPath v22"`). The keys of `Presets.localized/<locale>/
  Tastaturbefehle/*.kys` list the strings but not what they do.

## Traps

1. **Automation consent is per (controlling app, target app).** A shell
   that may drive InDesign and Word may not drive Illustrator, and the
   failure is a silent timeout (-1712), not an error. The pair does not
   appear in System Settings until a prompt has been ANSWERED, so it
   cannot be pre-granted there: the prompt has to be raised by the shell
   that will record, and clicked while it is up. `run-probe.sh` asks
   macOS first, without prompting (`AEDeterminePermissionToAutomateTarget`:
   0 allowed, -1744 undecided, -1743 denied), and names the state.
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
6. **ExtendScript is ES3 — with its own bugs.** No `JSON`, no `let`, no
   `Array.map`, no trailing commas; the library carries its own
   serialiser. And a NESTED TERNARY is parsed left to right:
   `a ? x : b ? y : z` means `(a ? x : b) ? y : z`. The first recording
   reported every path as counter-clockwise because of it. The replay
   caught it only because the spec recomputes area, bounds and winding
   from the recorded anchors and compares them with what the probe said —
   keep that check in every spec. Sources must be plain ASCII; the runner
   refuses anything else before launching.
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
