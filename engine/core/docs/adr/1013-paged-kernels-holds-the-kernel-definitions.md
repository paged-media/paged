# ADR 1013 — `paged-kernels` holds the kernel definitions

- **Status:** Accepted 2026-11-03. Amends image ADRs 450, 451 and 465; completes the plan of
  PM-0014 (the crate table) that ADR 1037 started.
- **Scope:** `engine/core/crates/paged-kernels` (the model, the families that move);
  `modules/image/image-kernels` (re-exports, the registry, the families that stay);
  `docs/development/capability-register.md` (Raster, kernels, blend).

## Context

PM-0014 reserved this number for one thing: a kernel is defined once, and the engine and
paged.image both read that definition. ADR 1037 took the first step because the engine's image
filter stack needed the twenty kernels that have a shipped CPU twin: it moved the pixel type
`Px`, the param blocks of the adjustment and convolution kernels, and the twins into
`paged-kernels` (about 1.1k lines), and said the rest moves "when ADR 1013 is written". This is
that record.

What still lives only in `modules/image/image-kernels` (about 22k lines in `src/families/`):

- the model: `KernelDef`, `KernelClass`, `ReductionKind`, `Tolerance`, `ParamField`,
  `ParamsLayout` and `ABI_VERSION` (`src/lib.rs`), plain data with no behaviour;
- the WGSL and the `KernelDef` static of every kernel, one file per family;
- the `kernel_family!` macro (`family.rs`), the ABI assembler (`abi.rs`), the scalar reference
  prelude and the compose twin;
- the registry: `registry/kernels.yaml` and the `build.rs` that turns it into the dispatch
  table `registry()`, `lookup` and `all_defined`.

The consequence is that an engine feature that wants a kernel's WGSL or its `KernelDef` has to
depend on a module crate (the engine cannot), or copy the definition. The capability register
lists it as open ("`paged-kernels` is ~1.1k lines, `image-kernels/families` ~22k").

## Decision

**A kernel definition moves to `paged-kernels` when the engine can reach the kernel. A family
that only paged.image runs stays where it is.**

What moves, in this order, one step per commit:

1. **The model.** `KernelDef` and the five types it names, and `ABI_VERSION`, become
   `paged_kernels::def`. `image-kernels` re-exports them at its crate root, so every
   `crate::KernelDef`, `$crate::ParamField` in `kernel_family!` and `image_kernels::Tolerance`
   path keeps resolving to the same type.
2. **A family, whole.** A family file that uses only the model and its own params moves by
   `git mv` to `paged_kernels::families::<name>`, text unchanged apart from the `use` line.
   `image-kernels/src/families/<name>.rs` becomes `pub use paged_kernels::families::<name>::*;`,
   so the registry's `rust_path` rows, `ALL_FAMILIES` and every test path stay valid. The first
   family is `conv` (it has no macro use, no twin of its own and no tests inside the file).
3. **The macro and the assembler** (`kernel_family!`, `abi.rs`, `reference_prelude`) move with
   the first family that needs them (the point-op families: `adjust`, `linear`, `arithmetic`, `cast`). The
   macro's `$crate::` paths then name `paged_kernels`; `image-kernels` re-exports the macro.
4. **The remaining engine-reachable families**, judged one at a time against the rule above;
   the candidates are `adjust`, `adjust_ext`, `develop`, `compose`, `select`, `stylize`,
   `gallery` and `blurgal`.

What stays in `image-kernels`, and why:

- **The registry** (`kernels.yaml`, `build.rs`, `registry()`, `lookup`, `all_defined`). A row
  carries the oracle, provenance, tolerance case and test list the image conformance gate
  consumes; the engine has no use for them. The dispatch table points at the moved statics by
  the same `families::<name>::NAME` paths.
- **The families only paged.image runs** until the engine reaches them: `gen`, `geom` (patch
  vote, warp), `warp`, `morph`, `resample`, `render`, `style`, `distort`, `pixelate` and the
  rest of the layer-style and retouch kernels.
- **`compose_twin`**, which is a consumer of `paged-blend` rather than a definition.
- The GPU executors (`image-gpu`), the layer fold and every `image-conformance` test.

`paged-kernels` stays a leaf crate (the core-ci `cargo tree` guard): `bytemuck` only.

## What each step must prove

A step is bit-exact or it does not land:

- the registry set-equality gate (`all_defined()` equals `registry()` in both directions) and
  the golden-expansion snapshot of every assembled WGSL module pass unchanged, so no WGSL byte
  and no param layout moved;
- every `naga` validation of an assembled module passes;
- the image conformance suite (the families' parity against the scalar references and the
  recorded Photoshop oracle cases) passes with no golden re-recorded;
- `cpu_twins.rs` holds the shipped twins to their tolerance as before.

## Consequences

- The engine can name a kernel's definition (`paged_kernels::families::conv::CONV_BOX`)
  without a module dependency; the wire from the engine's filter stack to a GPU kernel can be
  added without a copy.
- The image module's isolation (ADR 466: it depends on image-core and the leaf engine crates)
  is unchanged: `paged-kernels` is one of the leaves.
- `image-kernels` shrinks by one family per step; the register's line count for the open row
  becomes the sum of the families that stay.

## Amendment 2026-11-03 — step 3, the macro and the assembler

`kernel_family!` (`family.rs`), the ABI assembler (`abi.rs`) and `reference_prelude.rs` moved
by `git mv`; the text changed in three places only: the macro's `$crate::KernelDef`,
`ParamsLayout` and `ParamField` paths name `$crate::def::…`; `abi.rs` reads `def::KernelDef` and
`def::ABI_VERSION`; `reference_prelude` takes `Px` from `crate`. `GROUPS_PER_TILE` named
`image_core::TILE`, which a leaf crate cannot, so it stayed: `image-kernels/src/abi.rs` is
`pub use paged_kernels::abi::*;` plus that one constant.

The macro's `cfg(feature = "reference" | "cpu")` is evaluated in the crate that expands it, and
the twins it emits name `$crate::reference_prelude`. `paged-kernels` therefore has the same two
features, and `image-kernels`' `reference` and `cpu` forward to them; image-ci's guard against
the reference feature in the wasm tree now matches either crate. `image-kernels` brings the
macro into scope with `#[macro_use] extern crate paged_kernels` and re-exports it as
`image_kernels::kernel_family`.

### Step 4, the point-op families moved so far

`linear`, `arithmetic`, `cast` and `adjust` moved whole by `git mv`; the only text changes are
`use crate::{…}` becoming `use crate::def::{…}` and, in `adjust`, the params re-export naming
`crate::params`. `paged-kernels` takes bytemuck's `min_const_generics` (the 3D LUT block is a
729-entry array, which the workspace dependency already enabled). `families/mod.rs` of
`paged-kernels` lists them; the `image-kernels` files are one-line re-exports, so the registry
rows, `ALL_FAMILIES`, the conformance paths and `cpu.rs` resolve unchanged. Not moved yet:
`boolean`, `relational`, `minmax` and `band` (point operations too, with no engine caller),
`adjust_ext`, `develop`, `compose`, `select`, `stylize`, `gallery` and `blurgal`.

### Step 4, the rest of the engine-reachable families

`boolean`, `relational`, `minmax`, `band`, `adjust_ext`, `develop`, `compose`, `select`,
`stylize`, `gallery` and `blurgal` moved the same way, in three commits. `select` and `gallery`
carry tests of their own that naga-validate their assembled modules; they moved with the family,
and `paged-kernels` takes `naga` as a dev-dependency (the leaf guard reads normal edges). No
family left in `image-kernels` uses `kernel_family!`, so its `#[macro_use] extern crate` is gone;
the re-export `image_kernels::kernel_family` stays. The single-owner baseline for the WGSL
sRGB literals follows `adjust_ext`, `develop` and `select` to their new paths.

## Amendment 2026-11-08 — Blur

The engine and paged.image carried eight CPU blurs. They differ in four ways: the element type
(`u8` or f32), what a pass reads beyond the buffer (the nearest pixel, or transparent black),
where the rounding falls (after each pass, once at the end, rounding or truncating a box mean),
and how the kernel is normalised. None of them un- or re-premultiplies: a blur is linear, and
every caller hands it premultiplied RGBA or a single-channel coverage. So the shared module
takes an explicit edge and rounding, and no premultiply switch: a straight-alpha caller does not
exist and would have to convert around the call.

`paged_kernels::blur` holds the `u8` blurs: `gaussian_kernel`, `gaussian_separable::<C>`
(rounded after each pass), `gaussian_separable_f32_mid::<C>` (the row pass kept in f32, rounded
once), `box_pass::<C>` (an integer running sum), `Edge` (`Clamp`, `Transparent`) and `Round`
(`Nearest`, `Truncate`). What moved onto it, each bit-exact:

| Was                                              | Now                                                     |
| ------------------------------------------------ | ------------------------------------------------------- |
| `paged-gpu` `gaussian_blur_premul` (effects)     | `gaussian_separable::<4>`, `Edge::Clamp`                |
| `paged-gpu` `gaussian_blur_mask` (effect masks)  | `gaussian_separable::<1>`, `Edge::Clamp`                |
| `paged-gpu` `gaussian_blur_premul_xy` (SVG)      | `gaussian_separable::<4>`, `Edge::Transparent`          |
| `paged-gpu` `box_pass` (SVG, σ ≥ 4)              | `box_pass::<4>`, `Edge::Transparent`, `Round::Nearest`  |
| `paged-compose` `box_blur_h` / `box_blur_v`      | `box_pass::<1>`, `Edge::Clamp`, `Round::Truncate`       |
| `image-gpu` `SelectionCoverage::feather`         | `gaussian_separable_f32_mid::<1>`, `Edge::Transparent`  |

The box sizes stay with their callers, since they are each consumer's own approximation: five
Kovesi boxes per axis for the SVG filter (`paged-gpu/src/blur.rs`), three boxes of one radius
for InDesign's feather and shadow masks (`MaskRaster::blur`, which the PDF writer's alpha stamps
share). The proof is `paged-kernels/src/blur_oracle_tests.rs`: the six replaced bodies, kept
verbatim, against the new functions on fixed pseudo-random buffers of odd sizes (narrower than
the kernel included), several σ and reaches, byte for byte. No golden was re-recorded.

What stays, and why:

- **`cpu::gaussian_weights` / `cpu::gaussian_axis`** are already here: the f32 twin of the
  `conv.gaussian_h` / `_v` WGSL, radius capped at 24, exponent times `1 / 2σ²`. The renderer's
  image filter stack and image-js's masked region filter use them. Their weights differ from
  `gaussian_kernel`'s in the last bit, so the two kernels are not merged.
- **image-js `refine.rs` `gaussian`** (Refine Edge's alpha): f32, clamped, the weights divided
  out after the sum instead of normalised first. Moving it onto either kernel changes its output
  in the last bits; it has no golden of its own to state such a change against.
- **image-js `psd_vector_mask.rs` large-σ feather**: three box passes over an f32 running sum,
  zero beyond the canvas, box widths solved in f64. The `u8` integer box differs; the small-σ
  branch already goes through the selection feather above.
- **image-kernels `style::blur`** is the CPU reference twin of the layer-style `style.blur_*`
  WGSL (a per-tap weight from the params, divided by the weight sum, an `outside` value). It stays
  with its family, by this record's rule.
- **The GPU blurs**: Vello's layer blur in `paged-gpu/src/vello_rs.rs` (a sample grid of offset
  layers), and the WGSL of `conv.gaussian_*` and `style.blur_*`. The GPU cannot call Rust; the
  WGSL definitions are already single (`families::conv` here, `style` in image-kernels).
