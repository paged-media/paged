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
7. **One namespace rule, plus the capability gate (W3.10).** Every
   contributed id is `<manifest.id>.<anything>`, enforced at the facade
   with a thrown error (loud during dogfooding). That same chokepoint
   now also runs the **capability gate**: a door a bundle USES must be
   DECLARED in its manifest (§11). The namespace rule fires FIRST (the
   outer guard); the capability gate is the stricter policy the
   trust-line record (W0.11) promised — advisory → enforced.
8. **Native UI by construction (v0 = convention, v1 = schema —
   LANDED).** Panels are expert-leaf React composed from
   `@paged-media/ui` primitives and the `--pg-*`/`--chrome-*`/
   `--status-*` token layer; icons follow the 24×24/currentColor/
   1.5–1.9-stroke rule. The declarative panel schema stays a *catalog*
   concern [draw B-01] — the SDK adopts it, never invents a rival. W3.1
   landed that adoption: `host.contribute.schemaPanel` +
   `host.bindings`, rendered host-side from the catalog (§12).

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
`editContext` [draw B-02, web §8] and `objectType` [web §9.1.2] — the
last two reserved doors — LANDED (W3.2, 2026-06-07). A bundle registers
an `EditContextContribution` (`{ type, entry, matches?, toolIds?,
panelIds?, onEnter?, onExit? }`) or an `ObjectTypeContribution`
(`{ type, matches, editContextType?, bakedFallback }`). Capability-gated
on the OBJECT arrays `contributes.editContexts[]` /
`contributes.objectTypes[]` (the `type` — a content-type NAME, not a
namespaced id — must be declared; the namespace rule does not apply, the
capability gate is the only gate). The SDK adapter STAMPS the bundle's
own `x-paged:<id>` `metadataKey` so the shell resolves the candidate's
`metadata` from THIS plugin's envelope only. The SHELL owns the edit-
context STACK (Esc pops one level), the breadcrumb, the tool/panel swap,
and the SELECTION-SPACE write-scope (`EditContextRegistry` +
`resolveDoubleClick` router: object types claim a double-click FIRST by
metadata, edit contexts by KIND second, group descent last). True
engine-level subtree isolation is the isolate's job (documented residual,
draw B-02). The headless harness records both
(`editContextsContributed()` / `objectTypesContributed()`).

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

### 4.6b `host.network` — the consent door [paged.data D-03]
`requestConsent(origins, purpose) → ConsentResult` + `consentedOrigins()`.
The first plugin needing network is paged.data (external datasets;
base-idea §11 — "the largest attack surface in the suite"), so the door is
designed against *its* threat model, not a generic fetch. Three deliberate
choices: (1) **the manifest is the OUTER bound** — `capabilities.network`
declares a per-origin allow-list (or `"consent"` for author-supplied
sources); consent is the *inner* gate, so a bundle can never request an
origin it did not declare. (2) **No fetch on open** — a document carrying
queries is treated as carrying code: external origins are inert until the
user reviews the data-source manifest (origins + purpose) and consents,
per-origin and rememberable. (3) **The host does NOT proxy bytes** — a grant
authorizes the *bundle's own* reach (so the vendored DuckDB-WASM `httpfs`
connector works unchanged — connector breadth is the product); the editor
enforces the boundary with a CSP `connect-src` derived from the granted set.
The host adapter owns the consent *logic* (allow-list check, the remembered-
grant store in `host.storage`, default-deny); the editor injects the consent
*UI* via `CreateBundleHostOptions.consent` (a `ConsentBackend`). Absent a
backend the door denies every origin and `supports("network.consent@1")` is
false — the honest no-consent posture, mirroring `host.assets`. Editor
follow-up: the consent-prompt UI + the CSP enforcement. The host-proxied
`host.network.fetch` alternative was rejected (breaks DuckDB `httpfs`, adds a
large chokepoint for no isolation gain over CSP-per-grant). Full RFC:
`thoughts/docs/paged/plugin-data/rfc-network-consent.md`.

### 4.6c `host.dataProviders` — the cross-plugin data-provider registry [D-09]
`register(registration) → handle` (provider side) + `discover(category) /
get(id) / onDidChange(id, listener)` (consumer side). The §7.1 composition: one
plugin PUBLISHES a resolved dataset (paged.data — a governed query result) and
another DISCOVERS + reads it (paged.sheet — a sheet sourced from that query),
**without any inter-plugin contact** (§2.1). They rendezvous only here. Four
deliberate choices: (1) **a SHARED registry, not per-host** — unlike
`host.bindings` (a plugin's own reactive values), this spans plugins, so the
editor creates ONE `createDataProviderRegistry()` and injects the SAME instance
into every plugin host via `CreateBundleHostOptions.dataProviders`; the per-plugin
capability gate lives in the surface (`publish` ∋ category to register, `consume`
to discover/get). (2) **lazy snapshots** — `register` takes a `getSnapshot()`
invoked only on a consumer pull, in the PROVIDER's realm under the provider's own
capability/consent, so a consumer pulling cannot induce a fetch the provider is
not consented to (composes with D-03 without weakening it). (3) **revision
etags** — the provider bumps an opaque `revision` via the handle; consumers
re-pull through `onDidChange`. The data engine's revision is permutation-invariant
(stabilized content hash), so a row reorder is no spurious refresh. (4) **no
identity leak / no control** — discovery is by category; `DataProviderInfo`
carries no backing-plugin identity, and the consumer API has no parameter to hand
the provider a query/source. Absent a wired registry the door is the honest
no-registry posture (discover empty, register a no-op, `supports("dataProviders@1")`
false). The interchange is the Arrow-aligned columnar shape the engine emits
(`ProviderRecordSet` — fields keyed `ty`, not `type`). Editor follow-up: create
the registry once + inject it into every `loadBundle`. Full RFCs:
`thoughts/docs/paged/plugin-data/rfc-data-provider.md` (contract owner),
`thoughts/docs/paged/plugin-sheets/rfc-data-provider-consumer.md` (consumer).

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
  overlay, and — since W3.2 — `editContext`/`objectType`) become
  RECORDING no-ops that capture every contribution in an assertable log
  (the harness has no shell stack, so the un-reserved doors take the
  recording-stub path; `editContextsContributed()` /
  `objectTypesContributed()` read them back). That
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
| contribute.panel (React component) | **no** | v0 exception (expert-leaf escape hatch, same-realm only) |
| contribute.schemaPanel (`PanelSchema` data) | **yes** | W3.1 — pure data + named bindings; the isolate-ready panel form that RESOLVES the row above (§12) |
| host.bindings (publish/get/onDidChange) | **yes** | plain JSON; the dynamic half of schema panels (§12.2) |
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

`capabilities.keybindings: boolean` [W3.10] — ADDED 2026-06-07. The one
new field the capability gate (§11) needed: keybindings have no
contribution id to list under `contributes`, so a boolean is their
declaration. Schema + types + CLI validation gained only this. Every
other gated door maps to an existing field — the contract addition is
minimal and additive.

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

## 11. Capability-scope enforcement (W3.10)

The trust-line record (W0.11) made manifest-capability **enforcement** a
hard prerequisite for any third-party loading. W3.10 lands the engine of
it: `createBundleHost` now gates every door against the bundle's manifest
declarations — advisory → **enforced**. The verdict is one of:
contribution + read doors **throw** `PluginCapabilityError`; the write
doors **return a non-applied `MutationOutcome`** (mutate-never-throws,
DESIGN.md §2.5). Same loud-honesty style as the namespace gate, which
still fires FIRST (the outer guard).

**v1 stance (unchanged by this):** in-process, no isolation. This is
HONESTY + accident-prevention, *not* a security boundary — a bundle
holding the raw `host.editor` handle (§4.9) still bypasses the facade.
The gate makes declaration↔use drift loud so the manifest stays a
truthful description of what the bundle touches; the real boundary is the
isolate (the trust-line's other gates).

### The chokepoint → declaration map

| Door (chokepoint) | Manifest declaration required | On violation |
|---|---|---|
| `contribute.tool(id)` | `contributes.tools[]` lists `id` | throw |
| `contribute.panel(id)` | `contributes.panels[]` lists `id` | throw |
| `contribute.command(id)` | `contributes.commands[]` lists `id` | throw |
| `contribute.keybinding` | `capabilities.keybindings: true` | throw |
| `contribute.overlay(id)` | `capabilities.rendering` ∋ `"overlay"` | throw |
| `document.mutate` / `setMetadata` | `capabilities.document.write` | non-applied outcome |
| `document.undo` / `redo` | `capabilities.document.write` | throw |
| `document.collection`/`meta`/`pathAnchors`/`elementGeometry`/`tree`/`getMetadata`/`onDidChange` | `capabilities.document.read` | throw |
| `document.hitTest` | `document.read` **and** `rendering` ∋ `"hitTest"` | throw |
| `selection.set` | `capabilities.document.write` | throw |
| `selection.get` / `onDidChange` | none (ambient UI state) | — |
| `overlay.setToolPreview` | `capabilities.rendering` ∋ `"overlay"` | throw |
| `viewport.*` | none (read-only camera snapshot) | — |
| `storage.*` | none (already per-bundle scoped: `paged.plugin.<id>.*`) | — |
| `diagnostics.*` | none (per-bundle keyed store) | — |
| `loadBundleWasm(name)` | `capabilities.wasm[]` lists `name` + host grant | throw (§10) |
| metadata namespace (`x-paged:<id>`) | derived; foreign key refused | non-applied (always loud) |

**New manifest vocabulary (additive):** `capabilities.keybindings:
boolean` — keybindings carry no id to list under `contributes`, so a
boolean is their declaration (first-party bundles let the host derive
activation shortcuts from the tool registry, B-15, so it stays absent
for them). Every other door maps to an EXISTING field; the schema +
types + CLI gained only this one optional field. Existing valid
manifests stay valid (additive contract).

**`capabilityMode: 'enforce' | 'warn'`** (host option, default
`'enforce'`). `'warn'` logs each violation through `host.log.warn` and
proceeds — the migration escape hatch for a host loading not-yet-adopted
manifests. The namespace gate and the metadata-namespace gate are
UNAFFECTED by the mode — they are always loud.

**Why these and not more.** `viewport`/`storage`/`diagnostics` need no
capability: the camera is a read-only ambient snapshot; storage is
already namespaced per-bundle (no cross-plugin reach); diagnostics is a
per-bundle keyed store. Reading `selection` is ambient UI state every
bundle may observe; *changing* it is a document-level action, so
`selection.set` rides `document.write`. Over-declaring (a capability
listed but unused — e.g. paged.web declares `rendering: ["hitTest"]` it
does not exercise in the source lane) is allowed: the gate catches USE
without declaration, never the reverse.

## 12. The declarative panel-schema mechanism (W3.1 — closes draw B-01)

§2.8 deferred the declarative panel schema as a *catalog* concern, to be
adopted "when the catalog grows it, not invent a rival." It has now
grown (the editor's curated primitive leaves + `CompositionRenderer`
ship live), so this section lands the SDK's adoption — the v1 mechanism
that closes plugin-draw **B-01**.

**The B-01 problem, restated.** The concept paper's panels used a
`visibleWhen`/`enabledWhen` CONDITIONAL BINDING LANGUAGE
(`strokeType == "dashed"`). That was *rejected by design*: the editor
catalog's binding ceiling is `literal | selectionProperty` (+ coerce) —
no expression language, and the SDK must not fork one (§8 rejected
"inventing a richer panel-binding language"). B-01 recorded the
resolution DIRECTION — "derived bound values from plugin state + expert
leaves, not conditionals." W3.1 makes that direction a contract.

### 12.1 The shape

A bundle registers a `SchemaPanelContribution` through a new
`host.contribute.schemaPanel` door (gated identically to
`contribute.panel`: namespace rule first, then the capability gate —
the id must be in `contributes.panels[]`). The contribution carries a
`PanelSchema` — **pure data**, sections → rows → widgets:

- a ROW names a catalog **widget id** from the EXISTING vocabulary
  (`paged.input.numeric-scrub`, `paged.input.color-swatch`,
  `paged.input.toggle-group`, `paged.readout`, …), supplies static
  `props`, and optionally a `value` binding — a `WidgetValueBinding`
  that is the §11.5 ceiling UNCHANGED (`literal | selectionProperty` +
  `coerce`);
- a ROW or SECTION's `visible` / `enabled` is a `SchemaGate`:
  `boolean | { bind: string; negate?: boolean }`. The `{bind}` form
  names a value the plugin PUBLISHES (next section); the host LOOKS IT
  UP. `negate` is the only transform (a NOT) — publishing both `x` and
  `!x` is wasteful; anything richer is computed by the plugin.

No React crosses the boundary. A schema panel is `structuredClone`-able
data — it is the **panel/overlay isolate exit** the trust line needs:
DESIGN.md §6 lists the panel React `component` as the one knowingly
non-clonable contribution member; a schema panel removes it. Expert-leaf
React (`contribute.panel`) stays the escape hatch for genuinely custom
UI — **same-realm only**, by definition.

### 12.2 The bindings door (the dynamic half)

`host.bindings` is a new `BundleHost` member — a per-bundle, in-memory,
JSON-only `publish(name, value) / get / delete / onDidChange` store. The
plugin computes a gate's boolean in ITS OWN realm (from tool state,
selection, a document read — anything) and PUBLISHES the result under a
name; schema rows reference it via `{ bind: name }`. The host stores it
and re-renders any schema row that reads it. **There is no expression to
evaluate** — the binding ceiling stays intact, and conditional
visibility comes from a derived bound value, exactly as B-01 recorded.

The door is plain data, so it proxies across the isolate unchanged: the
bundle posts `{ name, value }`, the host re-renders.

### 12.3 Who renders

The host adapter (`createBundleHost`) synthesizes the registry
`PanelContribution` from a `SchemaPanelContribution`; its `component`
delegates to a host-injected `SchemaPanelRenderer`
(`createBundleHost({ schemaPanelRenderer })` — the same injection shape
as `widgets` / `shell`). The editor injects a renderer that walks the
schema through the catalog's `CompositionRenderer` (mapping each row's
`WidgetValueBinding` 1:1 onto a catalog `Binding`) and subscribes to the
bundle's `bindings` so gates react live. When NO renderer is injected
(headless hosts, an editor that hasn't wired the catalog),
`contribute.schemaPanel` registers a visible SEAM panel ("schema panel
needs a host renderer") — never a throw, never fake UI. The headless
harness records every schema panel VERBATIM (a `schemaPanel` recorded
contribution carrying the schema) so conformance asserts the schema, the
gates, and the binding refs without a UI.

`resolveGate(gate, lookup)` is the shared host-side evaluation (exported
from the SDK; the editor mirrors it) — absent→true, literal→itself,
`{bind}`→`Boolean(lookup(bind))` (a missing name reads `false`, a
visible seam), `negate`→inverse. It is a LOOKUP, not a DSL.

### 12.4 Honest limits (recorded, not hidden)

- **No lists, no custom canvases.** The row widget set is the curated
  catalog primitive leaves (numeric / length / color / toggle / select /
  readout / section). There is NO list primitive — layer/style lists
  stay expert-leaf React (the catalog calls them expert-leaf territory),
  and a custom on-canvas widget is an expert leaf. paged.draw's
  `layers.panel.json` prototype therefore CANNOT adopt the schema yet;
  its note records why.
- **The binding evaluation is a host-side LOOKUP keyed by name, NOT an
  expression language.** `{bind:"x"}` reads value `x`; it cannot say
  `x && !y` or `strokeType == "dashed"`. The plugin publishes the
  already-combined boolean. This is the whole point — the catalog
  binding ceiling stays.
- **`value` bindings resolve only against the SELECTION (or a literal).**
  A widget cannot bind its displayed VALUE to a published `bindings`
  value in v1 — only `visible`/`enabled` can. That keeps every WRITE on
  the typed property door (the apply-an-entity ceiling). A value-from-
  bindings widen is a possible v2, not v1.
- **The renderer is in-process React (the §6 non-clonable exit).** Across
  the isolate the host renders schema-side from the cloned schema + a
  bindings RPC channel — a SECOND `SchemaPanelRenderer` implementation,
  not a contract change.

### 12.5 Additivity

Wholly additive: new `host.contribute.schemaPanel` + `host.bindings`
members, new `PanelSchema` / `SchemaPanelContribution` /
`WidgetValueBinding` / `BindingRef` / `SchemaGate` types, the
`schemaPanelRenderer` host option. No existing member changed; no new
manifest field (a schema panel is a panel — `contributes.panels[]`).
The catalog binding ceiling is UNCHANGED — that is the point.

## 13. The capability-gated asset store (W-06 — `host.assets`)

paged.web's W1 font-parity pass (plugin-web BREAKAGE_LOG W-01·W1) proved
that the `fonts` collection door crosses font family **NAMES** but the
preview cannot inject real `@font-face` because **no door serves font
face BYTES**. The preview substitutes-and-badges; closing the bytes gap
is **W-06**. This section lands the door it needs.

### 13.1 The shape — a READ-ONLY, capability-gated asset accessor

`host.assets` is a new `BundleHost` member — a per-bundle facade over a
host-injected `assetSource` (the same injection shape as `widgets` /
`diagnosticsSink` / `schemaPanelRenderer`: a value the host app passes at
`loadBundle` time; absent → the door answers `null` and
`supports("assets.fonts@1")` is false). **v1 scope is exactly one
read:**

```ts
interface AssetSurface {
  getFontFace(family: string, style?: string): Promise<FontFaceAsset | null>;
}
interface FontFaceAsset {
  bytes: Uint8Array;          // the face's raw OpenType/TrueType bytes
  format: "truetype" | "opentype" | "woff" | "woff2";
  postscriptName?: string;    // when the host knows it
  family: string;             // the family the bytes resolve (host-canonical)
  style?: string;             // the style the bytes resolve, when style-specific
}
```

`getFontFace` serves **DOCUMENT-registered face bytes only** — the bytes
the engine already holds for a face the *document* loads/embeds (the same
faces the `fonts` collection NAMES). It is **not** an arbitrary
filesystem or network reader: a bundle cannot ask for `/etc/passwd` or
`https://evil/x.ttf`; it can only ask "give me the bytes for a family the
document already uses," and the host answers from what the document
already has (or `null`). `null` is the honest, frequent answer (a family
the host has no bytes for — including every family in v1 of the editor
adapter; see §13.4).

### 13.2 Capability gate — `capabilities.assets: ["fonts"]`

A new **additive** manifest field. `capabilities.assets` is a closed
array vocabulary (like `rendering`): v1 has exactly one member,
`"fonts"`. The capability gate (§11) refuses `host.assets.getFontFace`
unless the bundle declares `capabilities.assets` ∋ `"fonts"` — a
contribution/read door, so the verdict is **throw** in `'enforce'`, **log
+ proceed** in `'warn'` (the same enforce/warn split every other read
door takes). plugin-cli `validate` enforces the vocabulary
(unknown member rejected) and the array shape; the schema + types + CLI
gain only this one optional field. Existing valid manifests stay valid.

`"images"` is **OPEN since core v42 (2026-06-12, C-5 / I-04)** — the
former v2 reservation is honored: the engine serves a placed image's
ORIGINAL bytes through the `requestPlacedAssetBytes` wire query, so the
door gained `getPlacedImage(elementId)` and validation now accepts the
declaration. Unlike `getFontFace` (which routes through the editor's
injected byte source and stays conditional — §13.4), the image read is
engine-served: no injection, `supports("assets.images@1")` is
unconditional at the pinned canvas-wasm, and `found:false`/channel
failure answer `null` (the honest no-bytes mode). No size clamp —
document-scale originals (PSDs) are the use case, and the engine only
serves what the document already holds. URL-import bytes remain future
work on the same door shape.

### 13.3 Budgets + trust line

- **Per-face size cap** — `ASSET_BUDGETS.maxFontFaceBytes = 8 MiB`,
  consistent with the wasm lane's per-artifact ceiling (§10). The host
  facade refuses (returns `null` + a `log.warn`) a face whose bytes
  exceed the cap, so a bundle can never be handed an unbounded buffer.
  Per-face, not per-bundle: a bundle pulls faces lazily, one family at a
  time, and never accumulates a host-held cache it could exhaust.
- **READ-ONLY door** — there is NO `setFontFace`/`registerAsset`. Bundles
  never WRITE assets. The engine's host→worker `registerFont` (document
  font ingestion) is NOT exposed: a plugin cannot inject faces into the
  document. The door only READS what the document already embeds/loads.
- **Offline-forever = no network on the bundle's behalf.** The bytes come
  from what the document ALREADY has (its embedded/loaded faces). The
  host MUST NOT fetch a font from the network to satisfy a
  `getFontFace` — that would make a "render offline forever" document
  silently depend on a live URL. If the host has no bytes, it returns
  `null`. (A future image lane obeys the same rule: bytes baked at edit
  time, served from the package, never re-fetched at render.)
- **No ambient authority** — like the wasm loader (§10), the asset door
  grants ZERO new host reach: it is a pure read of document-owned bytes,
  in-process today, a serializable `{family, style} → bytes|null` RPC
  across the isolate tomorrow (`Uint8Array` clones 1:1).

### 13.4 The editor adapter, honestly (the bytes-reachability verdict)

Tracing the editor (`apps/canvas`): document fonts are referenced by
**name** (IDML `Fonts/Font_*.xml` carries no bytes). The only font bytes
the **main thread** ever holds is the single default-shaping font
(`/fonts/Inter.ttf`, fetched in `shell/.../document-loader.ts` and passed
as `loadDocument(bytes, fontBytes)` — the engine's *fallback* font, NOT a
named per-family registration). The corpus family→file map
(`fonts.sh` → `client.registerFont`) lives ONLY in the Playwright
fidelity driver (`tests/fidelity/`), never the app. Once `registerFont`
ingests bytes they live **worker-side / wasm-side** in the engine's
`BytesResolver`; `fontRegistered` replies `{family}` only — there is **no
read-back door** that returns a registered face's bytes.

So **document face bytes by family are NOT reachable on the editor main
thread** in v1. The editor therefore injects an `assetSource` whose
`getFontFace` returns `null` for every family — the HONEST door, not a
fake (serving Inter-as-Helvetica would be a lie; serving the default font
under an arbitrary family name would mislead the preview into showing the
wrong face as "the document's"). The door is real, gated, and budgeted;
it simply has no bytes to serve until the engine exposes them.

**The precise core/client follow-up that would make the door serve real
bytes:** a worker→main read on the engine's font registry —
`client.fontFaceBytes(family, style?) → Uint8Array | null`, backed by a
new `requestFontFaceBytes` wire message the worker answers from the
engine `BytesResolver` (the same store `registerFont` fills). That is a
core change (a new `MainToWorker`/`WorkerToMain` pair + a `BytesResolver`
accessor); when it lands, the editor adapter's `getFontFace` calls it
instead of returning `null`, and nothing else in the door/gate/budget
changes. Tracked as the W-06 residual in plugin-web's BREAKAGE_LOG.

### 13.5 Additivity

Wholly additive: a new `host.assets` member + `AssetSurface` /
`FontFaceAsset` / `AssetKind` types, a new `assetSource`
`CreateBundleHostOptions` field (+ `BundleAssetProvider` shape), the
`ASSET_BUDGETS` export, and one optional manifest field
`capabilities.assets`. No existing member changed. The capability gate,
the namespace rule, and every other door are untouched.

## 14. The capability-gated clipboard (K-6 / S-14 — `host.clipboard`)

The sheets-mode grid's range copy/paste (cells + values) had nowhere to
land (RFI §6 K-6). `host.clipboard` is the door: a read/write surface over
the SYSTEM clipboard with a rich `{ text?, tabular? }` payload. The
manifest already declared a `clipboard` enum (`none | vector | full`) ahead
of any surface; this change gives it teeth.

### 14.1 The payload — TSV is the floor, a cell grid is the ceiling

`TabularClipboard = { rows: string[][] }` is the canonical interchange — a
RECTANGULAR grid of cell DISPLAY strings (already number-formatted; the
consumer owns re-parsing on paste). `ClipboardPayload` carries a `text`
half and/or a `tabular` half: a grid copy carries BOTH (the grid AND a TSV
`text` fallback so a paste into a plain editor still lands something), a
text-only copy carries just `text`. On read the host fills whichever halves
it can recover (`tabular` is reconstructed from TSV `text` when the
platform offers no richer form). Plain strings ⇒ the door proxies across
the future isolate boundary unchanged.

### 14.2 The capability mapping (the honest reading of the existing enum)

- `"full"` — BOTH `text` and `tabular`. The rich grid interchange; what
  paged.sheet declares.
- `"vector"` — `text` ONLY. A vector plugin copies a textual/SVG
  representation, not a cell grid; a `tabular` half it WRITES is dropped
  (the surface strips it + logs once), a `tabular` half it READS is never
  surfaced (read returns the `text` half).
- `"none"` / absent — the door is DENIED: `read` throws (enforce) /
  warns+proceeds-text-only (warn), `write` likewise. This is the manifest
  default, so a bundle that never declares clipboard cannot touch the
  system clipboard by accident.

The warn-mode proceed treats an undeclared/`"none"` grant as the narrower
`"vector"` tier — a warn-migration host never silently leaks a cell grid.

### 14.3 The gate vs. the no-backend door (two different failures)

Two distinct failure modes, kept apart on purpose (matching `host.assets`):
the CAPABILITY gate (an undeclared manifest) THROWS in 'enforce' (a
manifest bug, surfaced loudly), while a missing BACKEND is the graceful
honest answer — `read` → `null`, `write` → no-op, `supports("clipboard@1")`
false. A platform refusal (no user gesture, permission denied) is also
graceful: a denied read answers `null`, a refused write is swallowed
(logged, not thrown) — the honest browser posture.

### 14.4 The editor backend (lossless paste OUT of the editor)

The editor injects a `ClipboardBackend` over `navigator.clipboard`. On
`write` it lays down BOTH `text/plain` (TSV) AND `text/html` (a real
`<table>`) via `navigator.clipboard.write([new ClipboardItem({...})])`, so a
paste into Excel/Sheets/Word lands a real grid, not a tab-soup line. On
`read` it pulls `text/plain` and parses the TSV back into `{ rows }`. It is
behind a feature check (`ClipboardItem` availability) with an honest
fallback to `writeText`/`readText`.

### 14.5 Additivity

Wholly additive: a new `host.clipboard` member + `ClipboardSurface` /
`ClipboardPayload` / `TabularClipboard` types, a new `clipboard`
`CreateBundleHostOptions` field (+ `ClipboardBackend` shape), the
`clipboard@1` feature flag, and a doc comment on the EXISTING
`capabilities.clipboard` manifest field (the enum itself is unchanged). No
existing member changed; the gate / namespace rule / every other door are
untouched.

## 15. The capability-gated worker door (K-3 / S-07 / I-02 — `host.workers`)

The K-3 design note
(`thoughts/docs/paged/plugin-platform/k3-worker-capability-design.md`) is
the deliberation record; this section is the contract summary. The
deferral (Wave 3b, no-speculative-surface) lifts because two real
consumers exist: paged.image's decode pool and paged.data's DuckDB
worker. A bundle never touches `new Worker()` directly — the SDK owns the
primitive, the manifest gates it, the host budgets + tears it down (the
same posture as every other door).

### 15.1 The shape — host-spawned, bundle-owned workers

`host.workers.spawn({ module, name? })` resolves a DECLARED, bundle-
relative `module` path (like the wasm artifacts — never an arbitrary URL)
and hands back a `BundleWorker`: `post(msg, transfer?)` /
`onMessage(handler): Disposable` for structured-clone messaging,
`allocateShared(bytes): SharedArrayBuffer | null` for zero-copy hand-off,
and `terminate()`. `concurrency()` reports the granted count cap so a
bundle sizes its pool rather than guessing.

### 15.2 Capability gate + budgets

`capabilities.workers: { max, sharedMemory?, maxSharedBytes? }` (closed
vocabulary, CLI + schema validated). The grant is `min(declared.max,
hardwareConcurrency, 8)`; `sharedMemory` gates `allocateShared`, which
also requires `crossOriginIsolated` (the editor's COOP/COEP) and stays
under the per-bundle shared-memory ceiling (256 MiB default, a manifest
`maxSharedBytes` may only tighten). The SAB accountant is live across
every worker a bundle spawns and reclaims a worker's budget on terminate.

### 15.3 The gate vs. the no-backend door

The CAPABILITY gate (an undeclared `capabilities.workers`) makes `spawn`
REJECT in 'enforce' (a manifest bug, surfaced loudly); a missing BACKEND
is the graceful honest answer — `spawn` rejects with "no worker backend
wired", `concurrency()` is 0, `supports("workers@1")` false. The editor
injects a `WorkerBackend` that resolves the module through the bundle's
own asset base and constructs an ES-module `Worker`.

### 15.4 Trust line (v1, in-process)

Same posture as the wasm lane: the worker gets NO ambient authority — no
engine/DOM/network handle, only the bundle's already-gated JS talks to
it; the SAB is a separate bundle-owned allocation. Honesty +
accident-prevention, not a security boundary (the isolate migration is
the real boundary — K-3's worker becomes the isolate's worker then).

### 15.5 Additivity

Wholly additive: a new `host.workers` member + `WorkersSurface` /
`BundleWorker` / `SpawnWorkerOptions` types, a new `workers`
`CreateBundleHostOptions` field (+ `WorkerBackend` / `SpawnedWorker`
shapes + `WORKER_BUDGETS`), the `workers@1` feature flag, and a new
`capabilities.workers` manifest field (schema + CLI). No existing member
changed; the gate / namespace rule / every other door are untouched.

## 16. The host credential store (D-11 — `host.secrets`)

The frozen RFC
(`thoughts/docs/paged/plugin-data/rfc-credential-store.md`) is the
deliberation record; this section is the contract summary. The deferral
lifts because a real consumer exists: paged.data's authenticated
DB-attach / remote sources need a credential the document MUST NOT carry.
A bundle never touches a secret store directly — the host owns it; the
plugin holds only references.

### 16.1 The shape — reference-only, no `get`

`host.secrets` has exactly three doors:
`set(ref, secret): Promise<void>` (the RFC's "via host UI only" — the
editor backing PROMPTS), `exists(ref): Promise<boolean>`, and
`forget(ref): Promise<void>`. There is **deliberately NO `get`**. A plugin
maps a source to a `credentialRef` STRING (e.g. `keychain:source-4`) and
holds only that string; secret bytes never enter the plugin realm. When a
source resolves, the plugin passes the ref to the host attach/fetch door
and the **HOST** injects the connection string / Authorization header on
its side of the wire — the injection point pairs with the D-03 consent
door (a consented origin + a `credentialRef` resolve host-side). The
no-`get` absence IS the contract; a trust-line test asserts the surface
has no `get` member (`secrets.spec.ts`).

### 16.2 Capability gate + the no-backend door

`capabilities.secrets: { sources: true }` (closed vocabulary, CLI + schema
validated) is the prerequisite. The CAPABILITY gate (an undeclared
`secrets`) makes every door REJECT in 'enforce' (a manifest bug, surfaced
loudly); a missing BACKEND is the graceful honest answer — `set`/`forget`
reject (`exists` answers `false`), and `supports("secrets@1")` is false.
The editor injects a `SecretStoreBackend` that owns the storage tier and
the user prompt; a headless host injects an in-memory ref store
(`inMemorySecretStore`) that holds refs but never retains the value
(upholding no-`get` end to end).

### 16.3 Editor backing tiers (honestly tiered)

The editor's reference `SecretStoreBackend` is WebCrypto-wrapped IndexedDB
when a user passphrase is set (a passphrase-wrapped AES-GCM key, namespaced
`paged:<plugin-id>:<ref>`), with a SESSION-ONLY in-memory fallback when no
passphrase/backing is configured (refs die with the tab — the RFC's honest
degradation; documents stay inert until re-entered). The WebCrypto tier is
the WEAKER tier (no OS keychain on the pure-web path — the RFC names the OS
keychain as the strong tier behind a future shell); the consent affordance
says so.

### 16.4 Additivity

Wholly additive: a new `host.secrets` member + `SecretsSurface` /
`SecretMaterial` types, a new `secrets` `CreateBundleHostOptions` field (+
the `SecretStoreBackend` shape), the `secrets@1` feature flag, and a new
`capabilities.secrets` manifest field (schema + CLI). No existing member
changed; the gate / namespace rule / every other door are untouched.

## 17. The realm-local GPU declaration (I-07 / C-1 Stage B — `capabilities.gpu`)

ADR-018 (`thoughts/docs/paged/adr/018-stage-b-gpu-texture-defer-record-only.md`)
is the deliberation record; this section is the contract summary. This is the
BUILDABLE, HONEST half of C-1 Stage B — and ONLY that half. It blesses, within
the capability contract, the WebGPU usage paged.image's Engine-B already does
in the bundle's OWN JS realm (I-07). It does NOT build the zero-copy
host-composited texture, which stays deferred record-only.

### 17.1 The shape — declare-only, no device handed

`capabilities.gpu: { realm: "bundle" }` (closed vocabulary, CLI + schema
validated). It is DECLARE-ONLY, exactly like the wasm artifacts: it hands the
bundle NOTHING. There is **no `host.gpu` surface, no `requestGpuDevice`, no
device/adapter/texture member** anywhere on `BundleHost`. The bundle already
has `navigator.gpu` in its own realm and drives WebGPU there itself; the
capability simply LEGITIMIZES that usage so the host can surface "this plugin
uses the GPU" to the user, and `supports("gpu@1")` reflects the declaration.

### 17.2 Why declaration-driven, not backend-driven

UNLIKE every other feature flag (`workers@1`, `secrets@1`, … which mean "a real
host backend is wired"), `supports("gpu@1")` reflects the MANIFEST DECLARATION
— because there is no device door to wire. The flag is true iff the bundle
declared `gpu: { realm: "bundle" }`. This mirrors how the wasm lane is
declare-only: presence of the artifact in the manifest is the whole contract.

### 17.3 The reserved `realm: "shared"` (and why it is rejected today)

The TS type's `realm` union is `"bundle" | "shared"` to RESERVE the shape, but
validation accepts ONLY `"bundle"`; `"shared"` is REJECTED (mirroring how
`assets ∋ "images"` was rejected until C-5's real read existed). `realm:
"shared"` would declare the future host-device-sharing path — a host-blessed
`GPUDevice` + a `SceneItem::Texture` zero-copy composite. That path is blocked
on TWO confirmed walls (ADR-018): (1) Vello has no external-texture import
(`peniko::ImageData` is bytes-only and Vello uploads into its own CPU-fed
atlas); (2) WebGPU can't transfer a `GPUDevice` across the
render-worker/main-thread realm boundary. Until BOTH lift, a `requestGpuDevice`
surface would be a fake — so the reserved value validates to an error with that
pointer, and the honest absence of any device member is the trust line (a test
asserts no `gpu`/`requestGpuDevice`/device-shaped member exists, mirroring
D-11's no-`get` keystone).

### 17.4 Additivity

Wholly additive: a new `capabilities.gpu` manifest field (`GpuCapability` type
+ schema + CLI) and the declaration-driven `gpu@1` feature flag. No new
`BundleHost` member, no `CreateBundleHostOptions` field, no SDK surface — the
deliberate absence IS the design. The gate / namespace rule / every other door
are untouched. The zero-copy composite + shared device remain deferred
record-only (ADR-018); this section adds NONE of `SceneItem::Texture`,
`requestGpuDevice`, or a host GPU backend.
