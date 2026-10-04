# scripts/indesign — Adobe InDesign as the oracle for draw's IDML round trip

Roadmap M1.2. paged.draw authors a document through its own surfaces on
the real engine, the engine exports it as IDML, Adobe InDesign opens the
file and says what it sees, and the answer is recorded and replayed. The
model is the Illustrator oracle lane beside this one (`scripts/illustrator/`)
and core's `tools/indesign-export`.

**CI never drives InDesign.** It replays the committed recordings
(`packages/draw-bundle/test/fixtures/roundtrip/<case>.indesign.json`)
against the committed IDML through
`packages/draw-bundle/test/roundtrip/*.spec.ts`. Recording is a
maintainer action on a Mac with InDesign installed.

```
scripts/indesign/
  run-roundtrip.sh          the runner: consent, ping, read, judge, write
  lib/read-document.jsx     handed to InDesign as text: opens the IDML, measures every item
  lib/write-fixture.mjs     judges InDesign's reply, adds the stacking order, writes the recording
packages/draw-bundle/test/roundtrip/
  author.ts                 one document per Tier-A row, built through draw's real surfaces
  generate.spec.ts          writes <case>.idml (env-gated: never in `pnpm test`)
  roundtrip.spec.ts         OUR model vs InDesign's reading, every difference classified
  reimport.spec.ts          InDesign's OWN export re-imported into the engine
  findings.ts               what every difference IS (defect / convention / expected loss)
  view.ts                   one comparable shape for both sides, and the comparison
packages/draw-bundle/test/fixtures/roundtrip/
  <case>.idml               what the engine exported
  <case>.indesign.json      what InDesign read in it
  <case>.indesign.idml      InDesign's own export (re-import cases only)
```

## What is recorded

Recorded with **Adobe InDesign 20.0.1.32** (InDesign 2025, German locale,
macOS 26.4) on 2026-10-03, engine `@paged-media/canvas-wasm` 0.64.0 —
except `offset-path` and `pathfinder-{divide,exclude,intersect}`, whose
IDML the 0.65.0 engine exports differently (joins honoured, every result
wound one way, Exclude as two pieces) and which were regenerated and
re-recorded on 0.65.0 on 2026-10-04, all four still identical. Each
recording's `produced_by` is the authority: app, version, locale, the
reader's sha256 and the IDML's sha256 — the replay refuses a recording
made by another reader or from another IDML.

| Case | Row | Verdict |
|---|---|---|
| `pen-open`, `pen-closed` | Pen path, open / closed, with curves | identical |
| `compound-hole` | compound path with a hole | identical |
| `pathfinder-{union,subtract,intersect,exclude}` | the four booleans | identical |
| `pathfinder-divide` | Divide | identical |
| `offset-path`, `outline-stroke`, `simplify`, `join` | path ops | identical |
| `live-corners-rectangle` | every corner style on a source `<Rectangle>` | corners survive; DEFECT absent StrokeColor; CONVENTION bevel spelling |
| `live-corners-polygon` | every corner style on a draw Polygon | DEFECT: corners not exported |
| `dash-presets` | the four dash presets | DEFECT: dash not exported |
| `arrowheads` | line ends | GraphicLine survives; DEFECT: refused on a Pen path (C-62) |
| `stroke-attributes` | weight / cap / join / miter | weight survives; DEFECT: join + miter not exported; cap refused (C-62) |
| `gradient-linear`, `gradient-radial` | gradient fills | gradient, stops, angle, length survive; DEFECT: no read door for the axis on a Polygon |
| `opacity-blend` | opacity 50 + Multiply via a Graphic Style | identical |
| `group` | a group | identical |
| `appearance-bake` | bake: a group of stacked items | DEFECT: Color/Paper undeclared → no fill |
| `repeat-expanded`, `blend-expanded` | expanded repeat / blend | identical (the blend's duplicate stroke swatches were fixed in draw and the case re-recorded) |
| `svg-import` | SVG import | identical |
| `text-on-path` | Type on a Path | DEFECT: not exported, `lost` silent |
| `opacity-mask` | opacity mask | EXPECTED LOSS, named in `lost` |

"Identical" means every anchor and handle within 0.01 pt, every paint and
stroke attribute, z-order, grouping and draw's metadata label agree.
Every finding is written up, with both values and a sentence, in
`test/roundtrip/findings.ts`.

## Record (or re-record) one case

```bash
# 1. the IDML (only when the authoring or the engine changed)
PAGED_ROUNDTRIP_WRITE=pen-closed pnpm --filter @paged-media/draw exec \
  vitest run test/roundtrip/generate.spec.ts

# 2. ask InDesign (takes the app for a few seconds)
F=packages/draw-bundle/test/fixtures/roundtrip
bash scripts/indesign/run-roundtrip.sh $F/pen-closed.idml $F/pen-closed.indesign.json

#    a re-import case also keeps InDesign's own export:
PAGED_RT_REEXPORT=$F/pen-closed.indesign.idml \
  bash scripts/indesign/run-roundtrip.sh $F/pen-closed.idml $F/pen-closed.indesign.json

# 3. replay
pnpm --filter @paged-media/draw exec vitest run test/roundtrip
```

The runner prints where it left the PDF InDesign exported of the page —
that is the visual check; look at it. It stays in the staging directory
(`PAGED_PROBE_STAGE`, default a `mktemp` dir) and is not committed.

Re-record one case at a time and read the diff: a recording is baked
evidence, laid out one anchor per line so a changed answer diffs as
geometry. A changed reader (`lib/read-document.jsx`) makes EVERY
recording stale — the replay checks the sha256 — so re-record all of them
in one deliberate pass and say why in the commit.

Exit codes: `0` recorded · `2` usage · `3` InDesign did not answer ·
`4` it answered with something that is not a recording (nothing is written).

## When the replay finds a difference

Do not widen a tolerance. Classify it in `findings.ts`:

- **DEFECT** (ours is wrong: exporter, engine, or draw's own code): the
  replay keeps it as an `it.fails` naming both values, so it turns red the
  day it is fixed — then delete the entry;
- **CONVENTION** (both right in their own terms): pin both values and the
  sentence that says why;
- **EXPECTED LOSS** (IDML cannot carry it): only if the engine's export
  names it in its `lost` list — the replay asserts that list exactly.

An unclassified difference fails; so does a classified one that no longer
occurs. Where our model holds no value, IDML omits the attribute and
InDesign answers its own default; `INDESIGN_DEFAULTS` in `view.ts` says
which, and the replay requires every entry to have been seen in a
recording.

## How InDesign is asked

| What | How | Measured |
|---|---|---|
| run a script | `«event K2  dosc» <text> given «class doLg»:«constant ****JSLg»` | InDesign's terminology is dynamic; where AppleScript cannot fetch it while compiling, `do script … language javascript` does not compile (core `run-export.sh`). The raw code needs none. |
| open | `app.open(File(idml), false)` under `UserInteractionLevels.NEVER_INTERACT`, closed with `SaveOptions.NO` in a `finally` | the runner pings again after, and refuses a document count that changed |
| coordinates | `scriptPreferences.measurementUnit = POINTS`, ruler origin PAGE, zero point 0,0 | page-local, Y down, the engine's frame. `geometricBounds` is `[top, left, bottom, right]` and is recorded as `[minX, minY, maxX, maxY]` |
| geometry | `paths[i].entirePath` + `pathType` | a corner point comes back as `[x, y]`, a point with handles as `[[left], [anchor], [right]]` |
| enumerations | reverse lookup over the enum object (`EndCap.reflect.properties`) | InDesign hands back four-character numbers |
| stroke style | matched by id against `strokeStyles.itemByName("$ID/…")` | `strokeType.name` is localised ("Durchgezogen") |
| z-order | InDesign's OWN IDML export of the opened document, `Self="u<hex id>"` | see trap 3 |
| warnings | unresolved fonts, links that are not normal, overset stories | see trap 4 |

## Traps

1. **Automation consent is per (controlling app, target app)** and the
   failure is a silent timeout. The runner asks macOS first without
   prompting (`AEDeterminePermissionToAutomateTarget`: 0 allowed, -1744
   undecided, -1743 denied, -600 not running) and launches InDesign with
   `open -g` (LaunchServices; no consent needed) when it is not running.
2. **Judge the artifact.** The reader always returns a JSON string;
   `write-fixture.mjs` refuses one that does not parse, has an `error`,
   could not open the file, sees no item, wrote no PDF or no export, or
   whose item walk disagrees with `spread.allPageItems`.
3. **The DOM does not know the stacking order.** A parent's `pageItems` is
   grouped BY KIND and `index` counts within one kind: the appearance-bake
   group listed its Rectangle first with index 0 and its frontmost Polygon
   also at index 0. The order comes from InDesign's own export instead,
   whose children are written back to front.
4. **Preflight is an idle task.** A script never yields idle time: over a
   document with an overset frame, `waitForProcess(30)` answered false and
   the result list was empty — "no problems" from a check that never ran.
   It is not asked. A suppressed alert (NEVER_INTERACT) is not observable
   from a script at all; what is observable is recorded.
5. **Names are localised, internal names are not.** Swatches answer
   "None" / "Black" on a German install; the PDF preset is
   "[Qualitativ hochwertiger Druck]" (the reader tries the known names).
6. **Swatch names are unique in InDesign.** Three swatches named
   "#000000" come back "#000000", "#000000 2", "#000000 3".
7. **InDesign's own export is a different dialect.** Its single page
   sits at ItemTransform `1 0 0 1 -612 -396` on the spread, every item
   carries the same transform, and every attribute equal to the applied
   object style (`[Normal Graphics Frame]`) is OMITTED. Both bite the
   re-import (`reimport.spec.ts`). The export also carries the reader's
   ruler settings (page origin, zero point 0,0) — view preferences only.
8. **An absent attribute is InDesign's default, not "none".** A
   `<Rectangle>` with no StrokeColor is stroked Black 1 pt; an unknown
   swatch reference (`Color/Paper` on a document that never declared it)
   paints nothing.
9. **ExtendScript is ES3** with its own bugs (no JSON, no nested ternary
   — see the Illustrator README), and asking a DOM object for a property
   it does not carry THROWS, so `x.prop !== undefined` is not a probe.
   Sources must be plain ASCII; the runner refuses anything else.
