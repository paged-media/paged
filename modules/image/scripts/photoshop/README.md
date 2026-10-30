# Photoshop oracle lane

Adobe Photoshop is the oracle for paged.image's blend modes, adjustments,
filters and layer compositing — the way Illustrator is for paged.draw's
path operations. This directory RECORDS Photoshop's answers; CI REPLAYS
them from the committed fixtures and never needs Photoshop.

```bash
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/blend-modes.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/adjustments.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/filters.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/layer-stacks.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/cmyk-stacks.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/vector-masks.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/brush-strokes.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/selection.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/filters-distort.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/filters-render.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/filters-stylize.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/filters-pixelate.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/adjustments-ext.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/mode-conversions.jsx
# vector-paths opens a PSD paged wrote: stage it first (see below)
PAGED_PROBE_STAGE=<dir> bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/vector-paths.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/adjustment-layers-ext.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/psd-containers.jsx
# psd-readback opens files paged WROTE: stage them first (image ADR 478)
PAGED_PSD_READBACK_OUT=<stage>/psd-readback cargo nextest run -p image-conformance \
  --run-ignored only write_psd_readback_inputs
PAGED_PROBE_STAGE=<stage> bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/psd-readback.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/guides.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/warp-text.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/smart-objects.jsx
bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/transform-warps.jsx
# smart-readback opens the smart objects paged WROTE: stage them first (image ADR 482)
PAGED_SMART_READBACK_OUT=<stage>/smart-readback cargo nextest run -p image-conformance \
  --run-ignored only write_smart_readback_inputs
PAGED_PROBE_STAGE=<stage> bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/smart-readback.jsx
# then re-measure and review the ledger diff:
PAGED_PHOTOSHOP_LEDGER=write cargo test -p image-conformance --test it oracle_photoshop::
```

| file                    | role                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `run-probe.sh`          | consent check, launch, ping, run under a timeout, judge, record                                               |
| `lib/probe-lib.jsx`     | ExtendScript helpers prepended to every probe (JSON, open/save, one case per duplicate, ActionManager)        |
| `lib/stimuli.mjs`       | the deterministic 128×128 16-bit untagged PNG stimuli                                                         |
| `lib/write-fixture.mjs` | judges the reply and the files, then copies them into `image-conformance/fixtures/photoshop/` with provenance |
| `probes/*.jsx`          | one probe per family                                                                                          |

The WP5.2 families (`filters-distort`, `filters-render`, `filters-stylize`,
`filters-pixelate`, `adjustments-ext`) and the ActionManager events they
send (the DOM has no method for most of them; ScriptListener-style keys):

| probe              | cases (DOM method or AM event and keys)                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filters-distort`  | Polar Coordinates both ways, Ripple, ZigZag (3 styles), Shear, Displace (DOM `apply*`); the Displace map is the stimulus saved as an 8-bit PSD (a 16-bit map is refused as "cancelled")                                                                                              |
| `filters-render`   | Clouds `Clds`, Difference Clouds `DfrC` (`RndS` seed), Fibers `Fbrs` (`Vrnc`, `Strg`, `RndS`), Lens Flare (DOM); colours black/white, restored after                                                                                                                                 |
| `filters-stylize`  | Solarize `Slrz`, Trace Contour `TrcC` (`Lvl `, `Edg ` `CntE`/`Lwr `·`Upr `), Wind `Wnd ` (`WndM`, `Drct`), Tiles `Tls ` (`TlNm`, `TlOf`, `FlCl`), Extrude `Extr` (`ExtT`, `ExtS`, `ExtD`, `ExtR`, `ExtF`, `ExtM`)                                                                    |
| `filters-pixelate` | Facet `Fct `, Crystallize `Crst` / Pointillize `Pntl` (`ClSz`), Mezzotint `Mztn` (`MztT`), Color Halftone `ClrH` (`Rds `, `Ang1`–`Ang4`)                                                                                                                                             |
| `adjustments-ext`  | Desaturate, Equalize (DOM), Shadows/Highlights `adaptCorrect` (`sdwM`/`hglM` `adaptCorrectTones` `Amnt`/`Wdth`/`Rds `, `BlcC`, `WhtC`, `Cntr`, `ClrC`), Replace Color `RplC` (`Fzns`, `Mnm `/`Mxm ` Lab, `H   `, `Strt`, `Lght`), Match Color `matchColor` (self, `neutralizeColor`) |

- **8-bit-only filters.** Wind, Tiles and Extrude refuse a 16-bit document;
  the case converts its duplicate to 8 bits, applies, converts back and
  records `params.eight_bit` (the output is still a 16-bit PNG).
- **Random filters** (Clouds, Difference Clouds, Fibers, Tiles, Crystallize,
  Pointillize, Mezzotint) carry `params.compare = "stats"`: Photoshop's
  generator is not ours, so the replay compares per-channel mean and
  standard deviation, in 8-bit levels, never pixels.
- **Not recorded:** HDR Toning (without its full descriptor it runs with the
  dialog's last-used settings, which are user state; a recording would not
  be reproducible); Lighting Effects (its descriptor is a large opaque
  light list); the Blur Gallery (Field/Iris/Tilt-Shift/Path/Spin pins are
  only scriptable through its workspace's undocumented descriptor) and the
  Filter Gallery effects (8-bit only and keyed per effect; a later probe).

The PSD-writing probes (image ADR 478): `adjustment-layers-ext` (one adjustment layer of each
kind `adjustment-layers` does not cover, so paged-psd's writer is held to Photoshop's own blocks
byte for byte: `psd_adjustment_blocks_photoshop.rs`; Color Lookup is not recorded, a scripted
`.cube` load makes an empty layer), `psd-containers` (a 16-bit layered document, a PSB, a CMYK
document, an embedded smart object; a linked one is not recorded, its `lnkE` holds an absolute temporary path) and `psd-readback`, which has Photoshop OPEN the
files the layered save writes and report each layer's kind, adjustment descriptor, effects and a
render (`psd_write_photoshop.rs`; the files are rebuilt by the test and held to the recording by
content hash, so they are not committed). A probe file that Photoshop cannot open is an error
the runner refuses — that is how the Curves block's missing `Crv ` extension was found.

Replays: `image-conformance/tests/it/oracle_photoshop.rs` (blend modes,
adjustments, filters → `fixtures/photoshop/ledger.json`, every case
classified `agreement` / `convention` / `defect` / `no-counterpart`) and
`image-conformance/tests/it/psd_composite_photoshop.rs` (the layered PSDs) and
`image-conformance/tests/it/psd_cmyk_photoshop.rs` (the CMYK PSDs, each with
Photoshop's own sRGB conversions under three intent/BPC settings).
`image-conformance/tests/it/mode_conversions_photoshop.rs` (image ADR 479: Image ▸ Mode — the
`colour-sweep` stimulus converted to CMYK (Coated FOGRA39, named), Gray Gamma 2.2 and Lab and back
to sRGB at 16 and 8 bits, each converted document saved as a PSD; and a Levels gamma on the
`deep-ramp` stimulus, 16384 levels, at 16 and 8 bits).
`image-conformance/tests/it/warp_text_photoshop.rs` (Warp Text: each style's
PSD warp opens as the style that made it; paged-warp's meshes held to
Photoshop's warped bounds as a recorded convention) and
`image-conformance/tests/it/psd_vector_masks_photoshop.rs` (vector masks: the
merged composite, and the render Photoshop caches in each masked layer's
channel −2).
`image-js/tests/it/brush_photoshop.rs` (brush strokes: Stroke Path with the
Brush tool -- dab placement, spacing, the round tip's profile, elliptical and
sampled tips under angle and flips -> `fixtures/photoshop/brush-strokes.ledger.json`;
regenerate with `PAGED_PHOTOSHOP_LEDGER=write cargo nextest run -p image-js brush_photoshop`).
The brush probe reads and RESTORES the user's paintbrush options, foreground
colour and current tool, and deletes the one temporary brush preset it
defines, by name. A partial tool-options descriptor resets the unnamed
gates, so the probe names every gate on every call.
`image-conformance/tests/it/oracle_photoshop_selection.rs` (Select ▸ Color
Range and Grow / Similar: each selection is rendered as white through the
selection over black, so the grey is the coverage; its ledger is in the test,
every case `Agreement` or a stated `Convention`, image ADR 470).
`image-conformance/tests/it/psd_vector_paths_photoshop.rs` (image ADR 476: the document's paths
against what Photoshop's DOM reports and byte for byte against its resources, every recorded
`vmsk` re-encoded byte for byte, a Photoshop shape layer opened editable and folded, and the ROUND
TRIP — a PSD paged's layered save wrote, opened by Photoshop). The round trip's input is staged
before the run: `PAGED_VECTOR_PROBE_INPUT=<dir>/input cargo nextest run -p image-conformance
write_probe_input --run-ignored only`, then the probe with `PAGED_PROBE_STAGE=<dir>`; copy
`<dir>/input/paged-vectors.psd` into `fixtures/photoshop/vector-paths/` with the recording.

## Warps: `transform-warps` (image ADR 483)

`transform-warps.jsx` unlocks the `colour-sweep` Background and sends the Transform event
(`Trnf`): each of the fifteen Warp styles at +50 % (the `warp` object — keyed by the STRING id
`warp`; the char id `'warp'` is accepted and silently ignored) and a 75 % width with and without
`contentAware`. Distort and Perspective are NOT recorded: `Trnf` ignores every corner form tried
(`nonAffineTransform` as `Pnt ` objects, doubles or px, `quadCorners`, `quadrilateral`,
`corners`, a `warpCustom` mesh) and hands the layer back untouched, which would have recorded the
identity as Photoshop's answer. The replay is `image-conformance/tests/it/transform_warps_photoshop.rs`.

## Smart objects: `smart-objects` and `smart-readback` (image ADR 482)

`smart-objects.jsx` makes an embedded smart object of a textured square of the colour sweep and
records seventeen cases: transforms (scale and turn, skew, flip, enlargement, a scale down and up
again), smart filters (Gaussian Blur alone, at 50 %, under a switched-off Motion Blur, behind a
filter mask, after a transform; Box Blur — event `boxblur`, `filterID` 840 —, High Pass, Median,
Maximum, Minimum) and an Edit Contents round trip, each as the layered PSD, an 8-bit PNG of the
composite and what the ActionManager reports. `smart-readback.jsx` opens the five files the
layered save writes from them and reports each smart object (its corners, filters and contents),
then has Photoshop draw it again from paged's record (scaled to 50 % and back; each live filter
switched off and on) and saves the composite. Findings: the PSB a new smart object embeds has a
white placeholder composite and is zero-padded to 1 MiB; a filtered object's channels are the
filters' output before the filter mask; Photoshop refuses a `SoLd` whose length is not a multiple
of 4. The replay is `image-conformance/tests/it/smart_objects_photoshop.rs`; the readback inputs
are rebuilt by the test and held to the recording by content hash, so they are not committed.

## Files paged writes: `codecs-open` (engine ADR 1038)

`probes/codecs-open.jsx` asks the opposite question: does Photoshop open
what `paged-raster` writes and reads? Its inputs are not stimuli but files
generated by the engine, staged before the run:

```bash
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/paged-photoshop-probe.XXXXXX")
(cd ../../engine/core && cargo run -p paged-raster --example oracle_files -- "$STAGE/codecs-open")
PAGED_PROBE_STAGE="$STAGE" bash scripts/photoshop/run-probe.sh scripts/photoshop/probes/codecs-open.jsx \
  ../../engine/core/crates/paged-raster/tests/fixtures/photoshop
rm -rf ../../engine/core/crates/paged-raster/tests/fixtures/photoshop/stimuli   # not used by this probe
```

It opens a layered TIFF (a PSD's layers in tag 37724) and records the
layers Photoshop reads back, colour samples of its composite and of each
layer alone; it opens a Radiance HDR and two OpenEXR files and saves what
it read as 32-bit float TIFFs. The cases record `values` and `files`, no
PNG output. The replay is `engine/core/crates/paged-raster/tests/it/oracle.rs`,
which first regenerates every input and checks it is the recorded copy.
Findings of the 2026-10-28 recording: the big-endian layered TIFF opens
with its three layers (an earlier attempt with a little-endian TIFF
carrying big-endian layer data is unconfirmed: Photoshop stopped answering
Apple events during it, so the writer stays big-endian, the byte order
Photoshop's own layer data then matches); OpenEXR colour is associated
with its alpha; a Radiance mantissa is read at the middle of its step (a
convention, see the replay).

`image-conformance/tests/it/psd_guides_photoshop.rs` (ruler guides: the
grid-and-guides resource 1032 of PSDs Photoshop saved -- whole, fractional
and off-canvas positions, a guide placed in inches at 300 ppi, none -- read
exactly, adopted by the image workspace, and re-encoded to Photoshop's own
bytes; image ADR 475).

## Traps, and what each step does about them

- **Consent.** macOS gates Apple events per (controlling app, target
  app). The runner asks without prompting first and explains `-1743`
  (denied) / `-1744` (macOS is about to ask).
- **Silent hangs.** A sign-in screen, a licence dialog, crash recovery
  or an unanswered consent prompt all look like a hang. The runner pings
  with `app.version` under a 60 s timeout before sending a probe and
  pings again afterwards; `-1712` is reported as "a modal dialog is
  probably open". Never SIGKILL Photoshop — it comes back with a
  recovery dialog.
- **Files.** Photoshop reads and writes a `mktemp` directory under
  `$TMPDIR` without any prompt (verified with Photoshop 27.10 on
  macOS 26.4). The probe text itself is handed over as a STRING, so the
  app never has to read a script from disk.
- **Colour.** The stimuli are untagged 16-bit PNGs. With dialogs
  suppressed Photoshop opens them in the working RGB space without
  converting a number; every probe's outputs record the document profile
  (`none`) and Color Settings (recorded per fixture; the recording used
  "Europe General Purpose 3", whose RGB working space is sRGB
  IEC61966-2.1). Each probe carries an `identity` case that the replay
  holds to agreement — the proof that no conversion happened. The user's
  Color Settings are read, never changed.
- **CMYK.** `cmyk-stacks.jsx` names its profile (Coated FOGRA39) when it
  creates each document, so the recording does not depend on the user's
  Color Settings; it READS the Color Settings' conversion options (engine,
  intent, black-point compensation) through the ActionManager and records
  them as the fixture's `findings`. Every conversion runs on a duplicate
  whose layers were merged first, with dither OFF (the default is on,
  which would make the conversion non-deterministic).
- **Merged data.** `layer-stacks.jsx` and `cmyk-stacks.jsx` set "maximize compatibility" for
  the run (restored afterwards) so every PSD carries Photoshop's real
  merged composite; the replay checks resource 0x0421 says so.
- **Judge the artifact.** `osascript` exiting 0 says only that a string
  came back. `write-fixture.mjs` refuses a reply with any case error, a
  document left open, a missing output, or an output that is not a
  16-bit PNG of the stimulus size.
- **What the DOM cannot say.** The scripting DOM sets no fill rule, no
  multi-subpath component and no invert flag on a vector mask.
  `vector-masks.jsx` writes such a case with the DOM, patches the one
  field in the saved bytes (BINARY file I/O), has Photoshop OPEN the
  patched file and SAVE it again — so the recorded PSD and its composite
  are still Photoshop's own.
- **Grow and Similar** answer "the command is not available" through the
  ActionManager with a tolerance key; `selection.jsx` calls the DOM
  (`selection.grow(tolerance, antiAlias)`, `selection.similar(...)`), which
  takes the tolerance as an argument.
- **ExtendScript** is ES3 and the text crosses an Apple event: plain
  ASCII only (the runner checks), no `JSON`, no `let`.

## Not probed: retouching (WP5.8)

Checked against Photoshop 27.10 on 2026-10-24, and recorded here instead of as fixtures:

- **Clone Stamp and Healing Brush cannot be driven by a script.** `PathItem.strokePath` with
  `ToolType.CLONESTAMP` or `ToolType.HEALINGBRUSH` refuses with "the area to copy was not
  defined (Alt-click to set the source)", and no ActionManager event sets the source
  (`setd` on `cloneSource`, `cloneSourceToolOptions` and `setCloneSource` are all "not
  available"). The source is set only by an interactive Alt-click, so the offset, transform
  and membrane-tone behaviour has no Photoshop oracle; paged's conventions are pinned by the
  Rust tests in `image-js/src/clone_source.rs`, `heal.rs` and `stroke.rs`.
- **Content-Aware Fill, Move, Remove and Spot Healing** are not reproducible numerically from
  run to run or version to version, so no ledger case could hold them. Their quality is
  measured on synthetic stimuli with a known ground truth instead (mean colour error and seam
  excess, `image-js/src/patchmatch.rs` tests; ADR 469).
