# ADR 452 — The frozen shader kernel ABI (v1, amended to v1.1)

- **Status:** Accepted. Recorded retroactively on 2026-10-02 from the code at `f7d21e5`.
- **Scope:** `image-kernels/src/abi.rs`, `KernelDef` in `image-kernels/src/lib.rs`, the pipeline layout and dispatch in `image-gpu`

## Context

Every kernel is compiled into a compute pipeline by `image-gpu` and dispatched by the two
engines ([ADR 454](454-two-evaluation-engines.md)), by direct calls from `image-js`, and
by the test harness. One binding interface for all kernels lets one pipeline builder and
one dispatch routine serve all of them.

The interface was fixed in the first commit (2026-06-07) and listed among the frozen
interfaces in the repo's hard rules, which allow changes only as versioned amendments
(`CLAUDE.md:88-91`). The header of `abi.rs` gives two reasons for details of the design:
inputs are read with `textureLoad` and no sampler, to avoid "filterability traps"
(`image-kernels/src/abi.rs:30`), and the selection mask is part of the interface so that
kernels are "selection-ready from day one" (`image-kernels/src/abi.rs:32`).

## Decision

**v1.** A kernel module has four bind groups: group 0 the input textures (`in0`, plus `in1`
for a binary kernel); group 1 a uniform `Params` struct that repeats the Rust `#[repr(C)]`
parameter block field for field and ends in `_abi_pad: u32`; group 2 the selection mask
texture; group 3 an `rgba16float` write-only storage texture. The entry point is `main`
with `@workgroup_size(16, 16, 1)`. For an expression kernel
([ADR 451](451-one-kernel-definition.md)) `abi::assemble` writes the whole module and ends
it with `mix(a, result, splat4(m))`, so the mask is applied outside the kernel body. When
no mask is passed the dispatcher binds a texture of ones. `ABI_VERSION` is `1` and is
exported through the wasm surface.

**v1.1** (commit `9a245a9`, same day). `KernelDef.module = true` means the `wgsl` field is
a complete handwritten module, passed through unchanged. Such a module must declare the v1
bindings and workgroup size itself. A `Windowed` kernel receives `in0` as the output region
expanded by its radius and applies the mask itself against the centre sample. A `Resample`
kernel receives the source window and writes its result unmasked. `ABI_VERSION` stayed `1`.

Two conventions were added later without a version change: procedural generators declare
one input and ignore it, and newer windowed modules compute their halo from the texture
sizes instead of assuming the radius.

## Evidence

- `image-kernels/src/abi.rs:19-33` — the v1 statement
- `image-kernels/src/abi.rs:133-189` — `assemble`: the bindings, the entry point, the mask
  mix, and the pass-through for modules at `:134-136`
- `image-kernels/src/abi.rs:86-132` — the contract for handwritten modules
- `image-gpu/src/pipeline.rs:36-47`, `:59-115` — non-filterable inputs, the four layouts,
  `min_binding_size` from the parameter layout, the `Rgba16Float` write-only output
- `image-gpu/src/execute.rs:408-422` — the constant-one mask
- `image-kernels/src/lib.rs:36-38`, `image-js/src/lib.rs:131-134` — `ABI_VERSION`, exported
- `image-kernels/src/families/gen.rs:24-34` — generators as unary modules, `in0` unused
- `image-js/src/lib.rs:2348-2402` — the whole-image door picks the windowed dispatcher by
  kernel class and builds an edge-clamped halo

## Alternatives considered

A separate zero-input lane for generators was not built; the family header says the dummy
input was chosen over amending the frozen interface
(`image-kernels/src/families/gen.rs:24-34`).

For windowed kernels on the whole-image path, commit `5b82355` made the kernels derive
their halo, on the belief that changing the dispatcher would amend the frozen interface.
Commit `78278e5` then fixed the caller instead: a windowed dispatcher already existed, and
the door had not been choosing it. No amendment was needed.

## Consequences

One routine builds the pipeline for all 128 kernels, and a kernel can be handed to either
engine or to the harness without adaptation. The version number does not distinguish v1 from v1.1. A module kernel carries obligations
the pipeline layout cannot check: whether it applies the mask, and whether its WGSL
`Params` matches the Rust block. Tests cover both
(`image-conformance/tests/it/gpu_module_kernels.rs:19-53`); the mask checks need a GPU adapter.

Comments contradict the code in three places. `image-kernels/src/abi.rs:122-124` still says that giving windowed kernels a halo on
the one-shot path needs an amendment to the frozen interface; since commit `78278e5` the whole-image door sends `Windowed` kernels to
the windowed dispatcher with a halo (`image-js/src/lib.rs:2367-2402`), and no amendment was made. The one-shot dispatcher itself is
unchanged and still sizes `in0` at the output dimensions (`image-gpu/src/execute.rs:262-275`). The same comment says `conv.box` and
the Gaussian pair are dispatched only through the expanding path (`image-kernels/src/abi.rs:106-108`). Engine A passes every apply
node, whatever its class, to `execute_tile_once` with the output tile's width and height (`image-pipeline/src/schedule.rs:299-307`),
which creates the input texture at those dimensions (`image-gpu/src/execute.rs:262-275`), and the adjustment chain builds both
Gaussian passes as Engine A nodes (`image-js/src/ingest.rs:1073-1083`). `image-kernels/src/lib.rs:97-99` documents `inputs: 0` for
generators; no generator declares zero inputs.

## Related

- [ADR 451](451-one-kernel-definition.md) — expression kernels and module kernels
- [ADR 453](453-tolerance-not-golden-bytes.md) — the checks that run against this interface
- [ADR 454](454-two-evaluation-engines.md) — the engines that dispatch through it
- [ADR 455](455-pixel-model.md) — the pixel format behind the `rgba16float` output
