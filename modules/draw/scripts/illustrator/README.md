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
26.4) on 2026-10-02 (`perspective-grid` on 2026-10-24, `nine-slice` on 2026-10-29). Each fixture's `produced_by` is the authority.

| Probe                 | Cases | What Illustrator said                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `offset-path`         | 17    | Exactly the closed-form miter / bevel / inward geometry. Miter limit is the stroke rule (mitered while `1/sin(angle/2) <= limit`, bevelled past it). Round joins are cubic arcs, one per 90 degrees or less, so areas bulge by about +0.001 %. Every result is clockwise whatever the input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `outline-stroke`      | 11    | Exactly the stroke's closed form for all nine cap × join pairs, same miter-limit rule. One SIMPLE clockwise outline that does not overlap itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pathfinder-boolean`  | 8     | The set operation, exactly on rectangles and within 0.1 pt² on a circle. Subtract is back minus front. Exclude is two separate paths, not a compound path. Every result is COUNTER-clockwise — the opposite of the two probes above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pathfinder-region`   | 9     | Divide: one piece per face, the overlap in the FRONT fill. Trim: front whole (with the crossing points inserted), back minus front. Merge: Trim, unless the fills are equal. Crop: back clipped to front, in the BACK fill. Outline: open zero-weight strokes cut at the crossings. Minus Back: FRONT minus back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `compound-path`       | 9     | Make Compound Path keeps the fill rule NON-ZERO and rewrites direction by PAINT ORDER: the backmost path clockwise, every other counter-clockwise, whatever the inputs were. So overlaps are knocked out, and a shape nested three levels deep is solid again (31600, where even-odd would give 31200).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `offset-compound`     | 14    | (2026-10-25) A compound path's hole moves the OTHER way (outset 10: 220² − 40² for the ring [100,300]² minus [170,230]²), vanishes when it shrinks past nothing, an island moves like an outer contour, outer contours that meet merge into one path. An OPEN path becomes the band of width 2·delta, BUTT-ended for miter and bevel, ROUND-ended for round. Outer contours clockwise, holes counter-clockwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `divide-many`         | 3     | (2026-10-25) Divide over 20, 50 and 100 generated rectangles and circles: 30, 199 and 1057 pieces, none compound, each in the fill of the frontmost input covering it; ten of them are Illustrator's own slivers under 0.01 pt².                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `perspective-grid`    | 15    | Each plane of the default two-point grid is ONE homography: fitted to one rectangle it predicts the others to 0.05 pt. The walls' verticals stay vertical, their ground lines vanish on one horizontal horizon, and the floor vanishes at those same two points; draw-geometry's construction from those points reproduces every corner after rescaling the two plane axes (0.1 pt). An ellipse keeps FOUR anchors (control points mapped; ours subdivides onto the conic — a convention).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `eps-import` (engine) | 6     | Placing an EPS and embedding it interprets the PostScript into Illustrator paths. The recording lives with the engine (`engine/core/crates/paged-ps/tests/fixtures/`) and is replayed by paged-ps's `oracle.rs`: every painted path within 0.05 pt and its RGB colour within 1/255. Convention: the arc case comes back 0.08 pt right of and below the box (60.08..140.08 against 60..140); the others sit on it. A CMYK fill is recorded converted to RGB by the document's colour settings, so only its geometry is compared.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pdf-ai-export`       | 8     | Not a path operation: what Illustrator WRITES. Each case saves the artwork as `.pdf` (Acrobat 7) and `.ai` (PDF compatible; one case without) into `PAGED_PROBE_OUT` and records Illustrator's own model of it. The fixture and the files live in `modules/publish/crates/pdf-import/tests/fixtures/illustrator/`; `tests/illustrator_oracle.rs` there replays them through publish's page reader (publish ADR 658). Illustrator writes an ellipse without closing it (`h`), joins curves with zero-length lines, and the stand-in page of a file saved without PDF content is localized (German here). That case's `.ai` is NOT committed: its stand-in page embeds a Myriad Pro subset, which may not be redistributed; the replay builds the page from bytes instead. Do not commit it after a re-recording.                                                                                                                                                    |
| `interchange-open`    | 2     | Draw ADR 364, recorded 2026-10-28. Generated by `packages/draw-bundle/test/oracle/gen-interchange-open.ts` (re-run it when the exporters change, then re-record). `svg-export`: Illustrator OPENS the SVG paged.draw's exporter writes and reads all four test paths exactly (bounds, paints, widths). `illustrator-dxf`: Illustrator BUILDS the drawing and exports it as DXF (AutoCAD 2010, mm, true colours); the replay (`crates/draw-dxf/tests/illustrator_oracle.rs`) reads it with draw-dxf exactly. Illustrator writes a fill as a SOLID `HATCH` of line edges plus the boundary again as an uncoloured `LWPOLYLINE`, curves as `SPLINE`, a circle as `CIRCLE`, its layer ("Ebene 1" here) as the DXF layer. Illustrator opening paged's DXF is NOT recorded: the DXF/DWG Options dialog cannot be driven (no `OpenOptionsAutoCAD` constructor; `app.open` refuses the preference object; a suppressed dialog cancels the open; placing refuses the file). |
| `nine-slice`          | 6     | 9-slice scaling of a symbol instance, expanded by Break Link: the corners keep their size, the edge regions stretch along their own axis and the centre in both — draw-geometry's `nineSlicePoint` (the engine renderer's formula) puts every anchor within 0.05 pt, a 0.8 × shrink included. Break Link inserts an anchor where a cut crosses an edge (the engine clips copies and inserts none), so the comparison is of shape. `getSymbol9SliceGrid` answers `[0, 0, 0, 0]` for a new symbol.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`vector-effects` (2026-10-29, engine ADR 1042) records Illustrator's live
vector effects through `applyEffect` + `expandStyle`; the fixture and its
replay live with the engine (`engine/core/crates/paged-vector-fx/tests/`).
The effect names and dictionary keys are strings in the plug-ins
(`Adobe Zigzag` `amount ridges roundness absoluteness`, `Adobe Punk and
Bloat` `d_factor` — a PERCENTAGE, `Adobe Twirl` `angle`, `Adobe Round
Corners` `radius`, `Adobe Roughen` `asiz size dtal smth absoluteness`,
`Adobe Transform` `scaleH_Percent … numCopies`, `Adobe Scribble and Tweak`
`horz vert ahor aver anch in out`). Recorded: Zig Zag, Pucker & Bloat and
Round Corners exactly; Transform's copies exactly; Twist to whole points
(Illustrator rounds); Offset Path; Roughen and Tweak statistically (their
random sequence is Illustrator's own; two recordings of one case differ).
NOT recorded: `Adobe Deform` (Warp) answered every dictionary tried with
the input unchanged; and a discovery probe with out-of-range values
(`DeformValue 50`, a Free Distort in a unit frame) left Illustrator
computing past the probe timeout — keep every parameter in its dialog's
range. Free Distort's `src*`/`dst*` frame is not settled.

`appearance` (engine ADR 1043) is written and NOT YET RECORDED. It builds
an object's several fills and strokes with the Appearance panel's own
commands (`Adobe New Fill Shortcut`, `Adobe New Stroke Shortcut`; the DOM's
`fillColor`, `strokeColor`, `strokeWidth`, `opacity` and `blendingMode`
then write the targeted layer, or the object -- which one is what the
recording says), exports each case as PNG-24 into `PAGED_PROBE_OUT`, and
records Object > Expand Appearance part by part. Record it with
`PAGED_PROBE_OUT` pointing at
`engine/core/crates/paged-renderer/tests/fixtures/illustrator/appearance/`;
a replay that rasterises the same appearance on the CPU lane and compares
the PNGs is the follow-up.

`clipboard-copy` (2026-10-28) is not a path operation: it records what
Edit › Copy puts on the macOS clipboard, for the editor's vector clipboard
(apps/editor ADR 289). Its runner, `run-clipboard-probe.sh <out-dir>`,
runs the probe through `run-probe.sh`, then reads the pasteboard and
writes, beside the geometry, every type with its size
(`clipboard-copy.pasteboard.json`) and the SVG flavour
(`clipboard-copy.illustrator.svg`); the recording lives in
`apps/editor/apps/canvas/test/fixtures/clipboard/`. Illustrator 30.1 put
`com.adobe.illustrator.aicb` (EPS), `public.svg-image`, `com.adobe.pdf`,
`com.adobe.illustrator.svg`/`.svgm`, `public.utf8-plain-text` (the SVG
source again), `public.png` and its PGF (the pasteboard also lists `public.tiff`, which its one item does not carry). The PDF and AICB
flavours are recorded by type and size only: Illustrator embeds the
account's user name in their private data. The probe replaces the
clipboard; the runner puts its previous plain text back.

Each fixture's `script_sha256` identifies the exact text (library + probe)
that produced it. The library has grown since the first recording (stroke,
paint and fill-rule fields), so older fixtures carry fewer fields; re-record
a probe to pick them up.

## Record (or re-record) one probe

```bash
bash scripts/illustrator/run-probe.sh \
  scripts/illustrator/probes/offset-path.jsx \
  packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json

(cd packages/draw-bundle && bun test test/oracle)
```

The first run from a new terminal or IDE raises a macOS consent prompt
(_„<your terminal>“ möchte Zugriffsrechte, um „Adobe Illustrator“ zu
steuern_ / _wants access to control Adobe Illustrator_). Answer
_Erlauben_ / _Allow_ while the runner waits — `PAGED_PROBE_PING_TIMEOUT=300`
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

| Operation                                           | Mechanism                                                                                                                                                                                                                                                                      | Confirmed by                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offset path                                         | `PageItem.applyEffect('<LiveEffect name="Adobe Offset Path"><Dict data="R mlim 4 R ofst 10 I jntp 2 "/></LiveEffect>')` then `app.executeMenuCommand("expandStyle")`                                                                                                           | Recorded. `jntp` is 0 round / 1 bevel / 2 miter (in no dictionary; settled by the recording). `expandStyle` leaves one plain path.                                                                                                                                                 |
| Outline stroke                                      | stroke set on the `PathItem` (`strokeWidth`, `strokeCap`, `strokeJoin`, `strokeMiterLimit`), then `app.executeMenuCommand("OffsetPath v22")`                                                                                                                                   | Recorded. No dialog. The live effect `Adobe Outline Stroke` + `expandStyle` returns the identical path.                                                                                                                                                                            |
| Unite / Minus Front / Intersect / Exclude           | group the inputs (`groupItems.add` + `move`), `app.executeMenuCommand("Live Pathfinder Add" \| "… Subtract" \| "… Intersect" \| "… Exclude")` on the group, then `expandStyle`                                                                                                 | Recorded. No dialog (only Soft Mix and Trap have one). The Pathfinder PANEL's buttons have no script entry point; these are the same operations as Effect › Pathfinder.                                                                                                            |
| Divide / Trim / Merge / Crop / Outline / Minus Back | the same, with `"Live Pathfinder Divide"` … `"Live Pathfinder Minus Back"`                                                                                                                                                                                                     | Recorded. No dialog. Inputs carry explicit fills (`fill: [r, g, b]`) because Merge, Divide and Crop answer in paint; every measured path records `filled`, `stroked`, `fill`, `stroke`, `strokeWidth`.                                                                             |
| Make Compound Path                                  | all inputs selected, `app.executeMenuCommand("compoundPath")`                                                                                                                                                                                                                  | Recorded. No dialog. Make leaves the anchors where they were, so these cases set `allowUnchanged` and the probe checks instead that exactly one `CompoundPathItem` exists. Every subpath records `evenodd`.                                                                        |
| Drawing on the perspective grid                     | `Document.showPerspectiveGrid()`, `Document.setPerspectiveActivePlane(plane)`, then `pathItems.rectangle` / `pathItems.ellipse(top, left, width, height)`: with the grid shown and a plane active the arguments are that plane's coordinates and the item comes back projected | Recorded. `PageItem.bringInPerspective` answers PARM ('MRAP') for every plane and position in 30.1, and `selectPerspectivePreset("[2P-Normal View]")` is refused on a German install (preset names are localized), so the document's default grid is used.                         |
| 9-slice scaling                                     | `Symbols.addWith9SliceScaling(art)`, `Document.setSymbol9SliceGrid(index, l, h - t, w - r, b)` (the CENTRE slice, read from the art's BOTTOM-LEFT corner, Y up), `SymbolItems.add(symbol).resize(sx %, sy %)`, `SymbolItem.breakLink()`                                        | Recorded. The expanded art lands in a SUBLAYER named after the symbol, which the probe moves back onto the layer. A grid rectangle that misses the art leaves the instance unsliced, silently — the first attempt read the rectangle from the top-left and recorded plain scaling. |

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
