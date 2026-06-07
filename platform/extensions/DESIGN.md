# The Paged Plugin SDK — API design (v0.2)

**2026-06-06 · status: implemented in this repo · informed by:** the
paged.draw build-out (plugin-draw `BREAKAGE_LOG.md` B-01…B-13), the
paged.web concept (`thoughts/docs/paged/plugin-web/base-idea.md` §9.1),
an audit of `editor/apps/canvas` (61 panels, registries, gesture spine,
bundle prototype, cockpit) and `core/` (wasm surface, Operation channel,
Boa, hit-testing), and the brand system (`brand/editor/ui_kits/editor`).

This document is the deliberation; the code in `packages/` is the
contract. When they disagree, fix one of them in the same change.

---

## 1. What the SDK is for

Two first-party plugins define the existential test (companion papers):
**paged.draw** proves the platform hosts a *tool* (gestures, path
mutations, overlays, panels); **paged.web** proves it hosts a *foreign
document model* (a new object type, an embedded engine, diagnostics,
assets). The SDK is the narrowest surface that lets both be built out of
repo — everything else is deliberately absent.

The corollary (paper §9, and the strongest lesson from Adobe CEP→UXP):
**nothing enters the surface speculatively.** Every member below maps to
a proven consumer need, cited as `[draw B-NN]` or `[web §9.1.N]`.

## 2. Design tenets

1. **Types from the API, values from the host.** `@paged-media/plugin-api`
   is *type-only*. Every runtime value a bundle touches arrives through
   `BundleHost` at `activate()`. Consequences: bundle module graphs stay
   host-free (unit-testable without React/wasm), and the same bundle
   source runs in-process today and behind an isolate RPC later — the
   host object is the thing that gets proxied, not the bundle.
2. **Facades, not object-graph leakage.** Bundles never see the raw
   registries or the raw `CanvasClient`. Raw registries would let a
   plugin unregister core contributions; the raw client exposes 100+
   methods we'd freeze by accident. The host hands *scoped facades*
   that (a) enforce the namespace rule, (b) track every registration
   for automatic teardown, (c) define the freeze candidate. Prior art:
   VS Code's `vscode.*` + `ExtensionContext.subscriptions` (good);
   Figma's ambient `figma.*` global (bad for multi-plugin isolation —
   we take the handle-passing shape instead).
3. **Disposable by default; deactivation is structural.** Everything a
   bundle registers returns a `Disposable`, and the host *also* tracks
   it. `dispose()` on the bundle handle must leave the shell exactly as
   found — the platform-honesty smoke test is enforced by construction,
   not convention.
4. **Snapshots + events, never live objects.** State crosses the
   boundary as serializable snapshots; changes arrive via `onDid*`
   subscriptions. This is the RPC-readiness rule: anything that
   couldn't be `structuredClone`d (React elements, class instances with
   methods) is either a declared v0 exception (see §6) or doesn't cross.
5. **Expected failures are results, not throws.** `document.mutate()`
   resolves to `{ applied: true | false }` — mirroring the editor's
   mutate-never-throws convention and keeping undo/validation semantics
   in one place (the engine).
6. **Capability detection over version sniffing.** `host.supports("…")`
   answers "can I?", `apiVersion` ranges answer "may I install?". Both
   exist because they fail differently: supports() degrades gracefully
   at runtime, the manifest range fails loudly at load.
7. **One namespace rule.** Every contributed id is
   `<manifest.id>.<anything>`. Enforced at the facade with a thrown
   error (loud during dogfooding). This single check is where the
   future capability gate attaches — same chokepoint, stricter policy.
8. **Native UI by construction (v0 = convention, v1 = schema).** Panels
   are expert-leaf React composed from `@paged-media/ui` primitives and
   the `--pg-*`/`--chrome-*`/`--status-*` token layer; icons follow the
   24×24/currentColor/1.5–1.9-stroke rule. The declarative panel schema
   stays a *catalog* concern [draw B-01] — the SDK will adopt it when
   the catalog grows it, not invent a rival.

## 3. The package layering (unchanged from v0.1, sharpened)

| Package | Role | Discipline |
|---|---|---|
| `@paged-media/plugin-api` | the contract: manifest, lifecycle, `BundleHost`, curated wire/contribution type re-exports | **type-only**, frozen at v1 |
| `@paged-media/plugin-sdk` | the runtime: `createBundleHost` (the in-process host adapter), `loadBundle`, gesture helpers, version negotiation, `defineBundle` | value code; faster-moving; owns `API_VERSION` (the api package can't — it has no runtime) |
| `@paged-media/plugin-cli` | validate/package tooling | zero-dep ESM |

The non-obvious move: **the host adapter lives in `plugin-sdk`, not in
the editor.** `createBundleHost(getEditor, manifest)` is a pure function
over the editor handle — the editor's only job is one `loadBundle()`
call per bundle. This keeps the entire contract implementation in this
repo (reviewable, versioned with the types it implements) and makes the
isolate migration a *second implementation of the same interface*
(`createBundleHostProxy` over RPC), not an editor refactor.

## 4. The `BundleHost` surface, area by area

Each area lists its justification. Reserved areas are typed and
documented but throw `PluginApiNotImplemented` — visible seams, never
fake-interactive (brand honesty rule applied to API design).

### 4.1 `host.manifest`, `host.log`
Own manifest (read-only) and a namespaced logger. The logger is the
seed of the **diagnostics channel** [web §9.1.4] — same sink, levels,
plugin-id prefix; the problems-panel UI consumes it later.

### 4.2 `host.contribute` — the contribution surface
`tool / panel / command / keybinding / overlay`, each `(c) => Disposable`,
each namespace-checked. These wrap the five proven registries
(`ToolContribution` with `gesture()` factories *is* the tool API — it
carried the whole pen/anchor build [draw D2]).
Reserved: `editContext` [draw B-02, web §8] and `objectType`
[web §9.1.2] — declared now so manifests and docs can reference them;
they throw until the shell work lands.

### 4.3 `host.document` — read broadly, write through one door
- `mutate(m: Mutation): Promise<MutationOutcome>` — *the* write door.
  Undo/validation/collab semantics stay engine-owned.
- reads: `collection(name)`, `meta()`, `pathAnchors(id)`,
  `hitTest(pageId, pt, filter)` [draw: scissors/anchor tools],
  `elementGeometry(ids)`, `tree()`.
- `undo()` / `redo()` — shared history, no plugin-local stacks.
- `onDidChange(l)` — typed `mutationApplied | undoApplied | redoApplied`
  events (every panel audit showed this exact subscribe pattern,
  hand-rolled 20+ times in `apps/canvas/src/panels`).

Capability note: this is the "read-broad / write-scoped" default. v0
enforces namespace only; write-*scoping* (subtree restriction) attaches
at this same `mutate` chokepoint when edit contexts land.

### 4.4 `host.selection`, `host.viewport`
`selection.get()/set()/onDidChange` (the post-insert select pattern
every drawing tool needs) and `viewport.camera()/pxToPt(px)` (the
zoom-constant-tolerance idiom from `pencil/scissors/pen` — [draw B-11]
showed every tool re-derives it).

### 4.5 `host.overlay`
`setToolPreview(shape | null)` — the polyline/rect preview signal (the
one overlay channel that exists [draw B-07]). Scene layers and retained
plugin overlays are the P2 channel; reserved, not faked.

### 4.6 `host.storage`
Namespaced KV (`paged.plugin.<id>.*`), JSON values. Needed by
paged.web's frame-options defaults and any tool's preferences; trivial
in-process (localStorage), trivially proxyable. Injectable backing for
tests/headless.

### 4.7 `host.diagnostics`
`set(key, Diagnostic[]) / clear / onDidChange` — per-plugin diagnostic
store with console mirroring [web §9.1.4: parse errors, unsupported-CSS
warnings]. The host-side problems UI is future; the *channel* must be
in the contract from day 1 or every plugin invents its own.

### 4.8 `host.supports(feature)`
Feature strings of the form `"area.member@major"` (e.g.
`"contribute.tool@1"`, `"document.hitTest@1"`). The implemented set is
exported as `HOST_FEATURES` so tests and docs can't drift from code.

### 4.9 `host.editor` — the marked escape hatch
The raw `PagedEditor`, present in v0 **by design**: gesture handlers
receive it from the spine anyway (`onActivate(paged)`), and pretending
otherwise would push bundles to smuggle it. The rule: *any use of
`host.editor` that isn't reachable through a facade is a
`BREAKAGE_LOG` entry* — it's the API-gap detector, and it gets removed
at the isolate boundary (the one v0 member that cannot survive RPC).

## 5. What `plugin-sdk` adds on top

- **`loadBundle(getEditor, bundle)`** — manifest sanity check, apiVersion
  negotiation (`satisfiesApiVersion`), host construction, `activate`,
  combined teardown. The editor calls this once per bundle.
- **Gesture kit** [resolves draw B-11]: `beginPageDrag`, `endLocalFor`,
  `pxToPt`, `commitAndSelect` — the page-anchored-drag bookkeeping every
  drawing tool repeats, extracted from `editor/packages/tools/src/
  handlers/shared.ts` so bundles can ship complete tools with zero
  editor-internal imports.
- **`DisposableStore`** — the subscriptions idiom.
- **`API_VERSION` + `satisfiesApiVersion`** — caret/exact/`*` ranges
  (deliberately minimal semver; full semver when publishing starts).
- `defineBundle` (inference helper).
- **`createHeadlessHost`** (resolves [draw B-13]) — the conformance
  harness the paper (§12.4) puts in the SDK tier. NOT a mock: it boots
  the PUBLISHED `@paged-media/canvas-wasm` in Node (`initSync` over the
  `_bg.wasm` bytes — the `--target web` loader's synchronous entry needs
  no fetch; the only Node-hostile import the wasm reaches is
  `globalThis.crypto`, present on Node ≥ 19) and drives the SAME
  `handleMessage` JSON envelope the editor worker drives, so a bundle's
  mutations round-trip through the true parse→apply→inverse engine path
  with real undo/redo. The document/selection/diagnostics/storage doors
  are REAL; the contribution surfaces (tool/panel/command/keybinding/
  overlay) become RECORDING no-ops that capture every contribution in an
  assertable log; `editContext`/`objectType` stay reserved (throw). That
  pairing — replay against a real engine + an assertable contribution
  log — IS the conformance semantics: a bundle can no longer pass
  against fiction. The protocol is PINNED: the loader reads the vendored
  wire's `Synced from …@<version>` stamp, derives the expected protocol
  (the package minor), and asserts the booted wasm matches — a wasm/wire
  skew fails loudly. Residuals (gesture REPLAY + overlay PREVIEW
  assertions) stay recorded-only, carried in B-13.

## 6. RPC-readiness audit (the isolate migration debt, stated)

| Member | Clonable? | Migration note |
|---|---|---|
| manifest, storage, diagnostics, supports, log | yes | trivial proxy |
| document.*, selection.*, viewport.* | yes | async already; promises proxy 1:1 |
| overlay.setToolPreview | yes | plain data |
| contribute.command/keybinding | yes | worker-kernel prototype already proved this (`shell/src/bundles/sample-bundle.worker.ts`) |
| contribute.tool (`gesture()` factory) | **no** | the factory becomes an event subscription: host streams `CanvasPointerEvent`s (already plain data) to the isolate, which runs the same machine and replies with preview/mutation messages — the draw-tools machines were shaped event-in/intent-out for exactly this |
| contribute.panel (React component) | **no** | v0 exception; resolves to the catalog schema (compositions are pure JSON) + `customCanvas`/`codeEditor` host widgets [web §9.1.1] |
| host.editor | **no** | dies at the boundary, by design (§4.9) |

Three knowingly non-clonable members, each with a written exit. That is
the entire isolate debt.

## 7. Versioning & freeze policy

- `plugin-api` 0.x: breaking changes allowed, each one logged in
  consumers' `BREAKAGE_LOG.md`. `1.0` freezes when (a) paged.draw runs
  fully bundle-registered, (b) paged.web W1 ships against it, (c) the
  breakage logs have drained.
- Editor releases declare a supported range; bundles declare
  `apiVersion`; `loadBundle` refuses mismatches loudly.
- Deprecation: a member leaves the surface only at a major, with a
  `@deprecated` release in between. (`host.editor` is born deprecated.)

## 8. Explicitly rejected alternatives

- **Ambient global (`paged.plugin.*`)** — breaks multi-plugin teardown
  and isolate routing; handle-passing costs one parameter.
- **Exposing `ShellRegistries`/`CanvasClient` directly** — freezes 100+
  members by accident; kills the namespace/capability chokepoints.
- **A plugin-side mutation queue with local undo** — two histories is
  how collaborative editing dies; the engine owns history.
- **Inventing a richer panel-binding language in the SDK** — the
  catalog's ceiling is host policy [draw B-01]; the SDK must not fork it.
- **Host adapter inside the editor repo** — would make the contract's
  implementation invisible to this repo's review and version it apart
  from its types.

## 9. Manifest additions in this change

`contributes.objectTypes` [web §9.1.2] — declared + schema-validated
(reserved at runtime).

`capabilities.wasm` [web §9.1.3, W-07] — ADDED 2026-06-07. The original
v0.2 note deferred it ("a packaging concern with zero contract surface
yet; it earns a member when the W0 spike defines one"). W-07 is that
moment: the lane now has a concrete contract surface — a manifest field,
CLI validation, and a host-side loader door. The full deliberation
(manifest shape, budgets + rationale, the no-ambient-authority trust
line, non-goals) is in `docs/wasm-packaging.md`; §10 below is the
summary.

## 10. The plugin-shipped WASM lane (W-07)

A bundle declares every wasm module it ships under `capabilities.wasm`
(`{ name, path, purpose, maxBytes? }`) — a *capability*, not a
contribution (it registers nothing). `purpose` is a closed vocabulary
(`layout | codec | compute`, like `rendering`) so the host can reason
about a module's role before granting it. The loader
(`plugin-sdk/loadBundleWasm`) enforces **declared-only** access (a name
absent from the manifest never loads), a **host grant** (wasm is opt-in;
no grant = refuse), the **budgets** (8 MiB/artifact, 16 MiB/bundle, 3 s
load-time, 256 MiB memory ceiling — `docs/wasm-packaging.md` §3 carries
the rationale), and instantiates with **no ambient authority**: the
module gets only the imports the caller passes — no engine/DOM/network
handle. The wasm is strictly downstream of the bundle's already-gated
JS, so shipping a module grants ZERO new host reach. Non-goals: no native
plugins, no wasm-side direct engine access, no threads/SAB in v1. The
editor-side serving wiring (asset base, grant UX, `instantiateStreaming`)
is the named residual.
