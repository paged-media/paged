# ADR 345 — The ML doors: seven typed capabilities, two tiers, nothing off the machine

- **Status:** Accepted 2026-10-24.
- **Scope:** `MlSurface` and its request and result types in `packages/plugin-api/src/ml.ts`
  (`host.ml`); `capabilities.ml` (`manifest.ts`, `manifest.schema.json`, `bin/paged-plugin.mjs`);
  `packages/plugin-sdk/src/doors-ml.ts` (`createMlRegistry`, `checkMlRequest`, the gated
  surface), `ml-host-client.ts` (the local host's client and its Tier-B provider),
  `ml-commands.ts` (`paged.ml.generate`, `paged.ml.edit`), `host-impl.ts` (`options.ml`, the
  live `ml.*@1` flags), `harness.ts`, `testing.ts` (`fakeMlProvider`). Served in the editor by
  its ML service (editor [ADR 290](../../../../apps/editor/docs/adr/290-the-ml-service.md)),
  in `paged-node` by the local host (`apps/cli/src/ml.ts`). Decided by
  [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md) (record "extensions 338–342":
  the ML doors; numbered 345 because 338 to 344 were taken or reserved when it landed).

## Context

The image module's selection, removal and neural filters, a host-level Generate Image in every
module, and text-to-vector all need the same few model capabilities. A bundle must not ship a
model runtime or weights of its own: they are large, their licences differ, and two bundles would
download the same model twice. PM-0014 puts the ML service in the host (L3); this record is the
door bundles reach it through.

Two kinds of model answer:

- **Tier A:** small ONNX models (segmentation, matting, fast inpainting, super resolution, face
  landmarks), each up to a couple of hundred megabytes, run in the browser.
- **Tier B:** a large local generative model (Qwen-Image 2.1 under stable-diffusion.cpp), which
  in-browser WebGPU cannot hold, run as a native process on the user's machine.

## Decision

**Seven capabilities, each its own door.** `ml.segment@1`, `ml.matting@1`, `ml.inpaint@1`,
`ml.superres@1`, `ml.landmarks@1`, `ml.generate@1` (text to RGBA image) and `ml.edit@1` (an image
changed by a prompt, inside an optional mask, guided by up to ten references). Each has a typed
request and result. Images cross as `MlImage` (8-bit RGBA, straight alpha), masks as `MlMask`
(one byte per pixel). Tensors never reach a bundle.

**Every result says who answered:** `provider`, `tier` (`"A"` or `"B"`) and `model`. A feature
can show "generated locally by Qwen-Image 2.1", and a test can assert the route.

**`supports("ml.<capability>@1")` is live.** It is true only while a healthy provider for that
capability is registered: a Tier-A model installed and verified, or the local host running with
a configured model. It moves when a model is installed or removed and when the host starts or
stops; `host.ml.onDidChange` fires then. Without a provider the call rejects with what is missing,
in the words the features show: "local image model not running" for generation, "no model
installed" for the others.

**One shared backend, providers register into it.** The editor builds one `createMlRegistry()`,
injects it into every bundle host (`options.ml`) and registers its providers. The registry routes
each call to a healthy provider: Tier A first for the analysis capabilities, Tier B first for
`generate` and `edit`, or the tier the caller asks for (`options.tier`). A provider is any object
with `status()` and `run()`, so a test's `fakeMlProvider`, the editor's worker models and the local
host's client are interchangeable, and an Apache-licensed generative model can replace Qwen-Image
without a feature noticing.

**The gate and the checks are the host's.** `capabilities.ml` lists the capabilities a bundle
calls; an unlisted one is a `PluginCapabilityError`. `checkMlRequest` refuses malformed input
before a provider sees it: an RGBA buffer of the wrong length, a mask of another size, an empty
prompt, a size that is not a multiple of 8 from 64 to 4096, more than ten references.

**Progress and cancel.** `onProgress` reports steps; an `AbortSignal` cancels, and for Tier B the
host stops the job's process.

**The local host's client lives in the SDK** (`createMlHostClient`, `mlHostProvider`), because
two hosts use it: the editor (through its same-origin `/api/ml` route) and `paged-node` (on the
loopback). Its wire is the host's HTTP API v1 (`apps/ml-host/README.md`): JSON jobs, progress as
server-sent events, PNG results. The PNG codec is the caller's.

**Typed commands for scripts and the CLI.** `mlObjectModel(backend, codec)` gives a host
`paged.ml.generate` and `paged.ml.edit` (PNG bytes in and out), so
`paged-node invoke doc paged.ml.generate '{…}' --result-out out.png` and a `paged.*` script can
generate in a batch.

**Nothing leaves the machine.** Tier A runs in the page's worker. Tier B runs on the loopback and
never opens an outbound connection. Model weights are downloaded only by the user's explicit
install (Tier A) or installed by the user themselves (Tier B, never by paged).

## Consequences

- WP8.2 and WP8.3 build their features (Select Subject, Remove, Generative Fill, Generate Image)
  on these doors without a model or runtime in any bundle.
- A bundle's tests run against `fakeMlProvider` (deterministic answers, progress, abort, a health
  switch) through the harness's shared backend.
- `ml.segment@1` takes points and a box, but the generic Tier-A adapter of editor ADR 290 feeds the
  image alone; prompt-driven segmentation (a SAM encoder and decoder pair) needs an adapter of its
  own when such a model is admitted to the registry.
- plugin-sdk and plugin-api 0.74.3-canary.21.
