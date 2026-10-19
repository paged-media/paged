# Rust majors (migration step U3)

U2 ran `cargo update` everywhere, which moves only within the declared
requirements. This step moves the requirements themselves: every direct
crates.io dependency whose newest release is outside its requirement (a major,
or a 0.x minor), in the ten Cargo workspaces.

The rule from the plan holds: a dependency update never shares a change with a
move or a rename. Each crate family is its own commit on `main`, in the order
below, and each one passes the same tests as the state before it, plus the
fidelity gates where a family can change rendered or written bytes.

## How the inventory was taken

For every workspace, `cargo metadata --no-deps` lists the direct dependencies
and their requirements. The newest non-yanked stable release of each comes from
the crates.io sparse index. A requirement is incompatible when that release is
outside it (`^1` against 2.x, `^0.41` against 0.42, an exact pre-release pin
against a newer pre-release). Re-run on the top of the stack, the same scan
lists only what is held below.

calamine 0.37 (data) was released on 2026-10-18, after the scan; it joined the
step as a family of its own (13, below).

## Inventory

33 crates had an incompatible release, as direct dependencies of nine of the
ten workspaces (draw had none):

| Workspace | Crates |
| --- | --- |
| engine/core | 17: base64, boa_engine, criterion, getrandom, harfrust, kurbo, lopdf, miniz_oxide, naga, pollster, quick-xml, resvg, sha2, syn, toml, vello, wgpu |
| modules/image | 9: criterion, getrandom, harfrust, miniz_oxide, moxcms, naga, pollster, skrifa, wgpu |
| apps/server/server | 8: aes-gcm, base64, getrandom, hmac, sha2, tungstenite, ureq, zip |
| modules/web/packages/web-render | 8: anyrender, blitz-dom, blitz-html, blitz-paint, blitz-traits, criterion, parley, skrifa |
| modules/data | 5: boa_engine, compact_str, criterion, quick-xml, rqrr |
| modules/slide | 5: base64, compact_str, ooxmlsdk, quick-xml, skrifa |
| modules/doc | 4: base64, compact_str, ooxmlsdk, quick-xml |
| modules/sheet | 3: compact_str, criterion, quick-xml |
| modules/publish | 1: base64 |
| modules/draw | none |

| Crate | From → to | Workspaces | Family | Decision |
| --- | --- | --- | --- | --- |
| vello | 0.10 → 0.11 (0.3 → 0.11 in the vello-eval spike) | core | wgpu | updated |
| wgpu | 29 → 30 (22 → 30 in the spikes) | core, image | wgpu | updated |
| naga | 29 → 30 | core (build), image (dev) | wgpu | updated |
| pollster | 0.4 → 1 | core, image | wgpu | updated |
| objc2 *(transitive; held at 0.6.4 by U2)* | 0.6.4 → 0.6.5 | image | wgpu | updated, see below |
| harfrust | 0.13 → 0.14 (0.6 → 0.14 in image-js) | core, image | fonts | updated |
| skrifa | 0.42 → 0.48 | image, slide (dev) | fonts | updated |
| skrifa | 0.42 | web-render | blitz | held: the version parley 0.10 builds |
| zip | 2 → 9 | server (dev) | zip | updated |
| miniz_oxide | 0.8 → 0.9 | core, image | zip | updated |
| moxcms | 0.8 → 0.9 | image | image colour | held, see below |
| image, png, zune-* | — | — | image colour | no incompatible release |
| resvg | 0.45 → 0.48 | core | vector | updated |
| kurbo | 0.11 → 0.13 | core | vector | held, see below (hayro keeps its own 0.13) |
| blitz-dom, -html, -paint, -traits | =0.3.0-alpha.4 → =0.3.0-alpha.6 | web-render | blitz | updated to the newest alpha |
| anyrender | 0.10 → 0.11 | web-render | blitz | updated with Blitz |
| parley | 0.9 → 0.10 | web-render | blitz | updated with Blitz |
| boa_engine | 0.21 → 0.22 | core, data | boa | updated |
| getrandom | 0.3 → 0.4 | core (paged-canvas-wasm) | boa | updated: Boa 0.22's copy needs the browser backend |
| sha2 | 0.10 → 0.11 | core, server | crypto | updated |
| hmac | 0.12 → 0.13 | server | crypto | updated |
| aes-gcm | 0.10 → 0.11 | server | crypto | updated |
| getrandom | 0.2 → 0.4, 0.3 → 0.4 | server, image | crypto | updated |
| base64 | 0.22 → 0.23 | core, doc, publish, server, slide | serialization | updated |
| toml | 0.8 → 1 | core | serialization | updated |
| compact_str | 0.8 → 0.10 | data, doc, sheet, slide | serialization | updated |
| ooxmlsdk | 0.12 → 0.13 | doc, slide | ooxmlsdk | updated |
| ureq | 2 → 3 | server | server-net | updated |
| tungstenite | 0.24 → 0.30 | server (dev) | server-net | updated |
| criterion | 0.5 → 0.8 | core, data, image, sheet, web-render (dev) | tooling | updated |
| lopdf | 0.42 → 0.45 | core (dev) | tooling | updated |
| rqrr | 0.10 → 0.11 | data (dev) | tooling | updated |
| syn | 2 → 3 | core (idml-coverage) | tooling | updated |
| calamine *(released during the step)* | 0.36 → 0.37 | data | calamine | updated |
| quick-xml | 0.41 → 0.42 | data | calamine | updated with calamine 0.37, which requires it |
| quick-xml | 0.41 → 0.42 | core, doc, sheet, slide | quick-xml | held, see below |
| wasm-bindgen | 0.2.129 | all | — | 0.2.129 is the newest release; nothing to move |

## Order

One commit per family, in this order:

1. **wgpu**: vello 0.11, wgpu 30, naga 30, pollster 1, objc2 0.6.5 (core, image)
2. **fonts**: harfrust 0.14, skrifa 0.48 (core, image, slide)
3. **zip**: server zip 2 → 9, miniz_oxide 0.9 (server, core, image)
4. **image colour**: moxcms 0.9 (image): not landed, held below
5. **vector**: resvg 0.48 (core); kurbo 0.13 landed with it and went back to
   0.11 in a follow-up, held below
6. **blitz**: Blitz 0.3.0-alpha.6 with anyrender 0.11 and parley 0.10 (web-render)
7. **boa**: boa_engine 0.22 (core, data)
8. **crypto**: sha2 0.11, hmac 0.13, aes-gcm 0.11, getrandom 0.4 (core, server, image)
9. **serialization**: base64 0.23, toml 1, compact_str 0.10
10. **ooxmlsdk**: 0.13 (doc, slide)
11. **server-net**: ureq 3, tungstenite 0.30 (server)
12. **tooling**: criterion 0.8, lopdf 0.45, rqrr 0.11, syn 3
13. **calamine**: calamine 0.37 with quick-xml 0.42 (data)

Each commit message lists the breaking changes that touch this code. Families
1 to 6 went to `main` one at a time. 7 to 13 went in one push, as seven
commits on top of the same `main`, after every workspace they touch passed its
gates on the final tree.

Families that reach paged.server were also run through its opt-in lane (a
local `wrangler dev`, `--profile server --run-ignored only`): the worker built
with the new crypto crates, and the sync client on ureq 3 and tungstenite 0.30,
passed all 14 end-to-end tests.

## Decisions worth keeping

### objc2 0.6.5 is not what crashed image's Metal tests

U2 held objc2 at 0.6.4 because image's GPU tests crashed with SIGSEGV in three
of six runs on 0.6.5. The crash reports macOS writes for those processes all
show the same stack, and it is not in objc2: Metal's shader compiler cache
(`MTLCompilerFSCache::getElementImpl` → `fscache_release` →
`is_data_file_invalid` → `fileno` → `flockfile`) faults while wgpu-hal compiles
a pipeline (`create_compute_pipeline`, `load_shader`). nextest runs each test in
its own process, many at once, and they all compile the same shaders through
that one on-disk cache.

The same crash appears on 0.6.4, on wgpu 29 and on wgpu 30, and more often when
the machine is loaded. Interleaved runs of the image workspace on Metal
(`REQUIRE_GPU=1`, five each): wgpu 29 + objc2 0.6.4 crashed in one, wgpu 30 +
0.6.4 in one, wgpu 30 + 0.6.5 in none. Five earlier runs of the base, on a
heavily loaded machine, crashed in two. objc2 0.6.5 itself fixes a miscompilation of
methods that return autoreleased objects, and engine/core and web-render already
lock it, so image moves to it with wgpu 30.

The cache race remains. It is Apple's: pull requests run image's device tests
on lavapipe, and CI meets it only in the Metal job that runs on `main`.

### Blitz moves to the newest alpha, not to the betas

web-render pins Blitz exactly (web ADR 401). 0.3.0-alpha.6 is the newest alpha
and the step takes it, with the anyrender and parley versions it requires.
0.3.0-beta.1 to beta.4 have been released since; they move to anyrender 0.14,
parley 0.12, Stylo 0.22 and Taffy 0.15, and web-render's skrifa follows parley.
Moving onto the beta line is a decision about the engine of its own.

### quick-xml stays on 0.41

- ooxmlsdk (doc, slide) requires quick-xml ^0.41 up to its newest release
  (0.13.2). Moving doc and slide would put two quick-xml majors in each.
  data is the exception: calamine 0.37 requires 0.42, and data's own
  variable-library codec moves with it (family 13).
- sheet stays with doc and slide: its OPC, relationships and splice code is to
  join theirs in one shared OOXML crate (plan step C1), which needs one
  quick-xml.
- engine/core's IDML reader and writer would move alone. 0.42 replaces the
  byte-based API with a `&str`/`Cow<str>` one: idml-import alone fails to
  compile in 436 places across nine files, and idml-export (about 1,300
  references in 33 files, plus its tests) and paged-gen come after it. 0.42
  also changes written bytes: `BytesText::new` and the escape functions write
  `\r` as `&#13;`, and attributes built from strings write tab, line feed and
  carriage return as character references. That changes exported IDML for any
  text or attribute that carries them, which wants its own export review
  against InDesign rather than a dependency step.

So quick-xml 0.42 is a change of its own for engine/core, and one for
doc, slide and sheet together once ooxmlsdk accepts it.

### moxcms stays on 0.8

moxcms 0.9 moves the colour image converts, and image's conformance suite
measures it. Five tests that pass on 0.8 fail on 0.9 (Metal, the same run
otherwise):

- `prop_colour`: the sRGB to sRGB transform is no longer the identity on the
  moxcms backend; a channel value of 1 comes back as 0.
- `psd_cmyk_photoshop`, the ink transform against Photoshop's default CMYK
  view: the mean error grows on every recorded stack, for example patches
  against relative colorimetric with black point compensation 0.47 → 0.64,
  `normal-stack` 0.55 → 0.79, `opaque-stack` 0.91 → 1.21, `blend-modes`
  0.60 → 0.82 (levels in 255).
- `psd_cmyk_photoshop`, converted CMYK layers blended in RGB: nine of twenty
  modes exceed their recorded error, for example `saturation` max 75 → 91 and
  p95 ΔE00 9.88 → 10.83, `color-dodge` max 153 → 158.
- `psd_cmyk_photoshop`, CMYK layer stacks: `opaque-stack` imports as
  (25, 25) where (25, 24) is recorded.
- `prop_layer_cache`: after a blend, the resident fold no longer equals the
  reference fold.

Those numbers are measurements against Photoshop, so they are not re-recorded
in a dependency step. moxcms 0.9 wants its own change, which finds what moved
(the identity transform first) and compares the result with Photoshop again.

### kurbo stays on 0.11

kurbo 0.12 rewrote the stroker and the curve offsetter. paged-mutate's outline
stroke and offset path are built on them, and paged-renderer strokes the band a
drop shadow casts with the same kurbo. On 0.13 the draw suite failed: the
butt-miter outline in the Illustrator oracle (`outline-stroke.spec.ts`)
overlaps itself in an inner-join loop of area 50 where the oracle records about
10, and the raw expansion carried 10 anchors instead of 9; the recorded
InDesign round trips for outline stroke and offset path no longer matched what
the engine wrote. The corpus gate saw a change too, within its thresholds: 14
pixels of one `rect-shadows` page. Both crates went back to 0.11.3; the draw
suite passes again, and all 660 corpus pages match the state before the step
byte for byte. hayro, which interprets placed PDFs, speaks kurbo 0.13 and keeps
it under the `kurbo13` name, as before this step. Moving kurbo is a change to
stroke and offset geometry, measured against Illustrator and InDesign, of its
own.

### Kept behaviour

- **zip and flate2.** The server's zip 9 takes `deflate-flate2` with flate2's
  `rust_backend`, as engine/core does: zip 9's `deflate` feature would switch
  flate2 to zlib-rs for the whole graph. doc, slide and sheet keep the zip
  features they had.
- **boa.** 0.22 turns `temporal` on by default; data's sandbox keeps the
  features 0.21's defaults gave it. A tripped runtime limit is an engine
  error now, not a native one; paged-script reports it in 0.21's words
  (`runtime budget exceeded: RuntimeLimit: Maximum loop iteration limit 1000
  exceeded`), which the budget classifier, the hosts and the CLI's golden
  output read. 0.22 also gives every Error an inherited `stack`; a thrown
  Error still prints as `Name: message`, with a stack only when the script
  set one. The wasm clock keeps `Date` at the epoch.
- **resvg.** svgz decoding became a feature of its own in 0.48; it stays on.
- **ureq.** The client keeps reading a problem's JSON from an error response,
  reads bodies without ureq 3's 10 MB cap, and sends compact JSON as ureq 2 did.
- **quick-xml in data.** 0.42's `escape` also writes a carriage return as
  `&#13;`. The variable-library writer escapes with its own function, the five
  characters 0.41 escaped, so the XML it writes stays byte for byte the same;
  the reader still takes text raw, without end-of-line normalization.
- **Blitz.** CSS `filter` / `backdrop-filter`, passed with layers since
  alpha.5, are not lowered (the scene layer has no filter item): the content
  paints unfiltered, as before.

## Found on the way

- `pipeline_resident::resident_chains_equal_the_per_tile_scheduler…` (image
  conformance, a property test) fails on the base as well for the input
  `dims = (40, 300), seed = 0, stages = [Sharpen(0.1), Sharpen(0.1),
  Blur(0.5)], selection = false`: `Queue::write_texture` is handed 7,680 bytes
  for a copy that needs 14,080. Random inputs reach it rarely; it is not caused
  by any update here. It has since been fixed on `main` (090c1c9b9: the
  requested region is part of a node's cache key).
- Vello renders on Metal are not bit-identical from run to run: two runs of the
  base differ on 67 of 660 pages, by at most 71 pixels at one level in 255.
