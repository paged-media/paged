# ADR 721 — Transitions and shader effects are pure WebGPU/WGSL

- **Status:** Accepted 2026-10-25. Amends [ADR 706](706-transitions-run-on-webgpu-with-gl-transitions.md):
  the shaders are WGSL written for this module, not gl-transitions GLSL translated at build time.
  Part of the parity program ([ADR 711](711-powerpoint-parity-program.md)).
- **Scope:** `packages/slide-bundle/src/show/shaders` (the shader library, its manifest and
  renderer), `slide-shaders` (the Rust checks), `pptx-core` (`TRANSITION_KINDS`,
  `PRESET_TRANSITIONS`), the repository's `tests/gpu` lane

## Context

ADR 706 put slide transitions on WebGPU and planned to take the shaders from gl-transitions:
vendored GLSL, translated to WGSL with naga when the bundle is built, mapped to PowerPoint kinds
by a table. That leaves three problems:

- gl-transitions has no counterpart for most of PowerPoint's catalogue. Vortex, prism, ferris,
  gallery, conveyor, honeycomb, shred, and the 2013 presets (curtains, wind, fracture, page curl,
  airplane, origami, …) would all fall back to a fade.
- A GLSL → WGSL step at build time adds a toolchain to the bundle build, and a shader that does
  not translate drops out silently.
- Two shading languages in one renderer means two sets of conventions for one contract: two
  images, a progress value, parameters.

ford442/image_video_effects shows a structure that fits: one shared prelude that declares the
bindings and a standard uniform struct, a JSON manifest per shader that maps parameters to uniform
fields, and ping-pong textures for multi-pass effects. Its shaders are a different kind of effect
(1,395 single-image effects, no two-image transitions). Its licence is only an "MIT License" line in
the README, with no LICENSE file and no copyright holder, and many of its shaders were generated
by a bot and have no stated provenance.

## Decision

1. **Every PowerPoint transition is a WGSL fragment shader** in
   `packages/slide-bundle/src/show/shaders/`, one `<name>.wgsl` per effect with an `fs_main` entry
   point. There is no GLSL and no translation step.
2. **One prelude, one contract.** `_prelude.wgsl` declares the only bindings a transition may use
   (`@group(0)`: sampler, `from` texture, `to` texture, uniform buffer) and the uniform block
   `Uniforms { progress: f32, time: f32, resolution: vec2f, direction: u32, params: array<vec4f, 2> }`,
   plus shared helpers: the direction vectors, a soft reveal edge, hashes and value noise, and a
   pinhole-camera ray–rectangle intersection for 2.5D cards and cubes. `_fullscreen.wgsl` is the
   shared vertex stage (one full-screen triangle). A shader starts with
   `// #include "_prelude.wgsl"` and may include another `_*.wgsl` library (`_curl.wgsl`, the page
   curl). The loader splices them in. A unit test rejects any shader or library that redeclares a
   binding, the uniform block or a binding name.
3. **The manifest maps PowerPoint to shaders.** `manifest.json` keys each transition by its
   PowerPoint id (`p:push`, `p14:vortex`, `p15:prstTrans`, `p159:morph`). Each entry names its
   shader, its `dir` values and default, and the XML attributes that set parameters (`thruBlk`,
   `orient`, `pattern`, `spokes`, `isInverted`, `hasBounce`, `invX`, `invY`). `prstTrans` maps
   each `prst` preset to its own shader. Each shader lists its passes and its named parameters,
   with uniform slots and defaults. `dir` becomes `Uniforms.direction` through one code table that
   the prelude's `DIR_*` constants match. A test keeps the two in step. Motion vectors point the way
   the content moves (`dir="l"` moves leftwards).
4. **The renderer** (`createTransitionRenderer(device, format)`) implements the show runtime's
   `TransitionRenderer` (`supports(kind)`, `render({kind, from, to, progress, params, target})`).
   It runs on the caller's device, so the deck needs no second GPU stack. It compiles pipelines
   lazily and caches them, with one explicit bind-group layout, so a shader may leave a binding
   unused. A multi-pass shader ping-pongs through two textures: pass k reads pass k-1 as `from`
   (`flythrough` adds a radial motion blur this way). `resolveTransition({kind, dir, xml})` turns a
   deck's transition into a render key and parameters. It reads the attributes beyond `dir` from
   the transition XML that import keeps on the page (ADR 703). `prepare()` compiles everything
   and reports WGSL diagnostics.
5. **The WGSL ships as a generated module** (`sources.generated.ts`, `bun run gen:shaders`).
   Vite and the Bun runtime understand `?raw` imports, but `bun build` does not. A test fails while
   the generated module and the `.wgsl` files disagree.
6. **Exact where practical, 2.5D where not, and labelled.** A transition that PowerPoint draws in
   3D (prism, flip, doors, window, switch, gallery, conveyor, fall over, prestige, origami's folds)
   is a real perspective projection of textured rectangles. Effects that would need a mesh or a
   simulation (vortex, honeycomb, fracture, crush, airplane, origami, drape, prestige, ferris)
   carry an `approximation` note in the manifest, and `resolveTransition` returns it. Morph needs
   the object model, not two images, so it plays as a cross-fade with that note. The show runtime
   can do better later. Random picks from a pool by a `seed` parameter.
7. **Licensing: nothing is vendored.** No code from image_video_effects is used: it is a reference
   for the structure only, for the reasons above. If one of its effects is wanted later, its
   author is asked for a LICENSE file first, and the effect is then vendored with attribution.
   Every shader here was written for this module. None is ported from gl-transitions, so there is
   no third-party notice. ADR 706 allowed hand ports of gl-transitions (MIT) with attribution, and
   a future port needs a THIRD_PARTY notice beside the shaders.
8. **Three checks.**
   - `bun test` in slide-bundle (`test/transitions.spec.ts`): the manifest against the importer's
     kind list (`pptx_core::TRANSITION_KINDS`, `PRESET_TRANSITIONS`), files against passes, the
     prelude include, the binding rule, slots, directions, the generated module, and the XML →
     parameter mapping.
   - `cargo test -p slide-shaders`: every assembled shader parses and validates with naga (the
     WGSL front end wgpu uses), and the manifest covers the kind list.
   - `tests/gpu` (`bun run test:gpu`): Chrome with WebGPU compiles every shader with Tint (which is
     stricter than naga: it caught an operator-precedence error that naga accepted). It renders
     every transition and its variants between two test slides at 64 × 48 and checks three things:
     progress 0 is the outgoing slide, progress 1 the incoming one, and 0.25 / 0.5 / 0.75 differ
     from both and match golden PNGs (`test/fixtures/transitions`). It also measures GPU time at
     1920 × 1080 with timestamp queries against a 2 ms budget. The lane skips without a WebGPU
     adapter (Linux CI); `PAGED_REQUIRE_GPU=1` makes that a failure.

## Consequences

- Every one of the 42 transition kinds the importer can produce has a shader or a mapping: 21
  from ECMA-376 (random included), 19 from PowerPoint 2010, `prstTrans` (whose 12 presets each
  have their own shader), and morph. That is 51 effect shaders and one extra pass.
- The budget is measured, not assumed. Apple GPUs ramp their clock with load, so the lane warms
  up for 200 frames before it times anything (cold numbers read 5–15× slow). Tint guards every
  loop it emits for Metal, which keeps loops from being unrolled. Hot shaders write their taps out,
  and the fracture shader was restructured so that a pixel needs one shard, not a search.
- Shaders use explicit-LOD sampling (`textureSampleLevel`), so they may sample in non-uniform
  control flow. Hashes avoid `sin` (Dawn compiles Metal without fast math) and integer multiplies
  (slow on Apple GPUs). They round their input to quarter units, so a computed cell centre hashes
  the same across the cell and across GPUs.
- ADR 706's points 1, 3, 4 and 5 change. The frame contract (two snapshots, progress following
  `dur` or `spd`) stands. The mapping table moves from `slide-js` to the manifest. The native
  "any gl-transitions shader" option is withdrawn. A device without WebGPU shows a plain cut with
  a notice (plan, Part B), not ADR 706's Canvas2D cross-fade.
