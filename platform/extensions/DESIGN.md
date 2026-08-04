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
- `mutate(m: MutationInput): Promise<MutationOutcome>` — *the* write
  door. Undo/validation/collab semantics stay engine-owned.
  `MutationInput = Mutation | PendingMutation` (§4.3a) — a WIDENED
  accepted input, which is additive: every `Mutation` still passes.
- reads: `collection(name)`, `meta()`, `pathAnchors(id)`,
  `hitTest(pageId, pt, filter)` [draw: scissors/anchor tools],
  `elementGeometry(ids)`, `tree()`,
  `planarRegions(elementIds, point?)` (§4.3c).
- `undo()` / `redo()` — shared history, no plugin-local stacks.
- `onDidChange(l)` — typed `mutationApplied | undoApplied | redoApplied`
  events (every panel audit showed this exact subscribe pattern,
  hand-rolled 20+ times in `apps/canvas/src/panels`).

Capability note: this is the "read-broad / write-scoped" default. v0
enforces namespace only; write-*scoping* (subtree restriction) attaches
at this same `mutate` chokepoint when edit contexts land.

### 4.3a Protocol-ahead mutation ops (`PendingMutation`)

**Finding, stated plainly:** `mutate` payloads are NOT structurally open
— `Mutation` is a typed, CLOSED, `op`-discriminated union. It is also
GENERATED: `plugin-api/src/wire.d.ts` is vendored verbatim from the
PUBLISHED `@paged-media/canvas-wasm` (stamp: `0.51.0` = protocol 51) and
guarded by `scripts/sync-wire.mjs --check`, a hard CI gate on content
drift OR a stale stamp. So a new engine op cannot simply be typed in:
hand-editing the vendored copy would BREAK the gate, and a vendored file
that no longer matches its source is not a passing check.

Core is at **protocol 57**, unpublished. Eleven ops landed there that
bundles need now, mirrored HAND-WRITTEN in `plugin-api/src/mutations.ts`
— byte-equal to the tsify output the v57 build emits:

| op | args | consumer |
| --- | --- | --- |
| `closePath` | `{ elementId, subpath? }` | paged.draw Wave B — close an open subpath (the inverse of `pathOpenAt`'s scissors cut) |
| `joinPaths` | `{ elementId, otherId }` | paged.draw Wave B — weld two open single-contour paths (InDesign's Join) |
| `pasteInto` | `{ containerId, childId }` | B-18 nested content — nest a top-level page item in a container frame |
| `releaseFrom` | `{ childId }` | B-18 — pop a nested child back to top level |
| `pathfinderDivide` | `{ elementIds }` | B-22 (v57) — paged.draw's `Pathfinder: Divide` command (`commands/pathfinder-region.ts`) |
| `pathfinderTrim` | `{ elementIds }` | B-22 — paged.draw's `Pathfinder: Trim` |
| `pathfinderMerge` | `{ elementIds }` | B-22 — paged.draw's `Pathfinder: Merge` |
| `pathfinderCrop` | `{ elementIds }` | B-22 — paged.draw's `Pathfinder: Crop` |
| `pathfinderOutline` | `{ elementIds }` | B-22 — paged.draw's `Pathfinder: Outline` |
| `pathfinderMinusBack` | `{ elementIds }` | B-22 — paged.draw's `Pathfinder: Minus back` |
| `pathfinderFaces` | `{ elementIds, faces, mode }` | B-22 — paged.draw's Shape Builder commit (`handlers/shape-builder.ts`), fed by §4.3c's face ids |

The seven v57 ops are the REGION row: where the vendored
`pathfinderBoolean` (Shape Modes) combines paths into one, these resolve
the planar ARRANGEMENT of the inputs — the same arrangement §4.3c reads
— and operate per face. `elementIds` is **top-to-bottom** (index 0
frontmost), the convention `pathfinderBoolean`'s `kept`-is-top already
sets; the order is load-bearing, so a consumer derives it from paint
order rather than guessing. The editor's **Pathfinder panel** is the
downstream surface these light up.

This is the same shape as DOC-03's `StoryContent` (protocol v54), which
ships hand-written in `host.ts` ahead of its vendoring. The union stays
sound throughout: when canvas-wasm 0.57 publishes and `sync-wire.mjs`
runs, `Mutation` ABSORBS these and `PendingMutation` collapses into a
subset of it — it never contradicts the vendored union.

**Honest limits, recorded:**
- A protocol-ahead op is NOT gated by `host.supports()`. The gate is the
  worker's protocol version, which the client handshake already checks
  (`protocolMismatch`); an op a pre-v56 (resp. pre-v57) worker can't
  deserialise comes back as a non-applied `MutationOutcome`, never a
  silent no-op.
- They cannot ride the vendored `batch` op (`args.ops: Mutation[]`)
  until the re-sync — issue separate `mutate` calls.
- The narrow `PagedClient.mutate` handle (editor.ts) is DELIBERATELY not
  widened. Widening a handle demands more of every host than the
  published wire promises; instead the adapter carries one commented
  cast at the single call site (`host-impl.ts`), which disappears on
  re-sync.

### 4.3b `host.nativeDocument` — the whole-native-document door [ADR-022]
The privileged, isolate-safe surface an import/export plugin needs to
speak in terms of the WHOLE Paged-native document, replacing the
`host.editor.client` escape hatch (§4.9) for that job.
- `readModel()` / `readComposition()` — raw bytes of the core-owned
  native parts (`paged/core/model/document.pgm`,
  `…/composition/document.pgd`), or `null` when the document carries no
  such part. Cross-namespace reads — NOT a plugin's own `host.parts`
  subtree (§4.6), which is why they are separately gated.
- `listParts(prefix?)` — the `paged/core/` native part paths present.
- `open(bytes)` — replace the active document by loading a
  native/importable package (the IDML importer produces these bytes from
  a `.idml`, then hands them here). Forwards to `client.loadDocument`.

Capability note: two grants under `capabilities.document` —
`readNative` (the reads) and `openNative` (the whole-document replace),
kept SEPARATE because `open` is far more powerful than reading. Restrict
to first-party / trusted-publisher bundles. Always present: honest `null`
/ `[]` / reject with `supports("document.readNative@1"|"…openNative@1")`
false when the host injects no `nativeDocument` backend. This is the
core-side door ADR-022 pairs with the IDML adapter leaving the engine —
the plugin imports/exports, the host owns loading.

### 4.3c `host.document.planarRegions` — the region read door [B-22 · K-11]

`planarRegions(elementIds, point?): Promise<PlanarRegionsResult>` — the
level BELOW element hit-testing: the FACES of the planar arrangement the
inputs form (the areas their overlapping outlines divide the plane
into). Core shipped it in protocol v57 as
`RequestPlanarRegions → PlanarRegions`; K-11 is the facade for it.

**Consumer (the promotion rule):** paged.draw's region **Shape Builder**
(`draw-bundle/src/handlers/shape-builder.ts`) — hover query per
pointermove (`point` form), one full enumeration per gesture scope
(`point`-less form), then a single `pathfinderFaces` commit built from
the face ids — and the six **`Pathfinder: <verb>` commands**
(`commands/pathfinder-region.ts`), whose `elementIds` come from the same
arrangement. Both reach the engine today through the marked v0 escape
hatch `host.editor.client.send({ kind: "requestPlanarRegions" })` (§4.9)
— the same precedent `measure.ts` set for `requestNearestPathPoint`,
and the gap this member closes. The editor's **Pathfinder panel** is the
downstream surface. With `point` the engine answers the single face
under it (N point-in-path tests + one region materialisation) instead of
enumerating everything — the reason the argument is on the contract and
not simulated by the consumer.

**Why the door answers a RESULT, not a face array.** The result carries
a REFUSAL channel, and flattening it would be the one dishonesty this
door cannot afford:
- `found: false` + `reason` — the query could not be answered at all:
  no document, an id that doesn't resolve, or more than the kernel's
  `MAX_PLANAR_INPUTS` (12) inputs / more than 256 faces. The engine
  REFUSES rather than truncating, and a caller that rendered that as an
  empty face list would tell the user "these paths divide into nothing".
  paged.draw already surfaces `reason` verbatim on a status binding;
  the contract must keep that possible.
- `complete: false` — the listed faces are all REAL but do not tile the
  union (the enumeration missed a sliver). Always `true` for a point
  query: one face is not a tiling claim.
- `inputCount` — what the arrangement was actually built from.

**Coordinates, stated:** faces come back in the RAW path space
`pathAnchors` reports — per-element `itemTransform`s are NOT composed in
(the arrangement runs on the anchors as stored, exactly like
`pathfinderBoolean`). A consumer drawing faces on canvas maps them with
the frontmost input's `itemTransform`. Face **ids are stable for the
same input set**, which is what lets a hovered id ride straight into
`pathfinderFaces` — and only for that set, so a stale face list is
refused by the engine, not silently ignored.

**Capability + flag.** A pure read, gated on `capabilities.document.read`
like every other read door. `supports("document.planarRegions@1")` is
STATIC and means exactly one thing: this SDK's document surface
implements and forwards the door. It does NOT claim the host's engine
carries v57 — the vendored wire is still 0.51, so that answer is
per-call: a host whose engine predates the door (or any channel failure)
comes back as `{ found: false, reason: … }`, never a throw and never a
fake empty face list. Same honesty split as §4.3a's mutations: the
engine-level gate is the worker handshake, not `supports()`. Two casts
in the adapter (request kind out, reply kind in) carry the v57 wire
until `sync-wire.mjs` re-vendors canvas-wasm 0.57 — the same
single-seam discipline as the `mutate` cast.

**Not yet consumed.** paged.draw keeps its escape hatch until this SDK
change publishes as a canary and the bundle repins; the door is built
and tested here first (`test/planar-regions.spec.ts`), which is the
sequencing every promoted member follows.

### 4.3d `host.document.parentOf` — the parentage read door [C-16]

`parentOf(id): Promise<ElementId | null>` — the nearest ANCESTOR that is
itself an addressable element (a group today: the only element kind that
nests page items), `null` when there is none.

**Consumer (the promotion rule):** paged.draw's `selectParentGroup`
command (`draw-bundle/src/commands/select-parent-group.ts`), which climbs
to the containing group on every press. Its module header already records
the gap in its own words — *"there is no per-element
`document.parentOf(id)` read — this command re-reads the WHOLE tree per
invocation, which is O(document) on every press … a targeted parent read
door is the RFI candidate"*. This is that door. The bundle's pure
`parentGroupOf(roots, target)` walk stays exported for its conformance
spec; what changes is that the command stops paying for a full tree walk
per keystroke.

**No core door was needed, and that is the finding.** The
`requestSceneTree` → `sceneTree` reply the `tree()` door already reads
carries the FULL parentage: nodes nest, and every addressable node
carries its `ElementId`. The gap was never "the engine can't tell us" —
it was "the facade offers no per-element question, so every consumer
re-derives the whole answer". So `parentOf` is served ENTIRELY host-side,
by this SDK, over the existing wire query. **No engine change, no
protocol bump, no new wire op** — which also means the flag
`document.parentOf@1` is STATIC in `HOST_FEATURES` (like
`document.tree@1`) rather than per-call like `planarRegions` (§4.3c).

**How it avoids being the same O(document) with extra steps.** The
adapter derives a child→parent index ONCE from a scene-tree read and
holds it, dropping it when the document changes (`mutationApplied` /
`undoApplied` / `redoApplied` / `documentLoaded`, subscribed lazily on
first use so a bundle that never asks pays nothing). The walk therefore
happens once per EDIT rather than once per PRESS, and a burst of presses
costs one query — asserted directly (`test/parent-of.spec.ts`, "costs ONE
scene-tree read across repeated presses").

**Honest ceiling, stated:** a derived read is exactly as fresh as the
thing it derives from. `parentOf` is as fresh as `tree()` and no fresher;
a host that never announces a change would serve a stale index, the same
staleness a consumer's own cached `tree()` would have. A failed scene-tree
read caches an EMPTY index rather than leaving it unset — a broken channel
must not turn into a rebuild storm on every press, which is the cost this
door exists to remove.

**What `null` means (three cases, deliberately merged):** the element is
top-level (its container is a Page/Spread row, which carries no
`ElementId` and is not a selection target — so those rows are
*transparent*: a frame inside a group inside a page answers the GROUP);
the id does not resolve; or the address is structural (`storyRange`,
`table`, `tableCell` — those never nest in groups, and answer without a
read at all). A caller that needs to tell them apart still has `tree()`.
A pure read, gated on `capabilities.document.read` like every other.

### 4.4 `host.selection`, `host.viewport`
`selection.get()/set()/onDidChange` (the post-insert select pattern
every drawing tool needs) and `viewport.camera()/pxToPt(px)` (the
zoom-constant-tolerance idiom from `pencil/scissors/pen` — [draw B-11]
showed every tool re-derives it).

### 4.5 `host.overlay`
`setToolPreview(shape | null)` — the polyline/rect/path preview signal
(the one overlay channel that exists [draw B-07]). Scene layers and
retained plugin overlays are the P2 channel; reserved, not faked. The
same channel takes a LIST through `setToolPreviews` (§4.5a) — that member
is what retires the single-slot trade this one imposes.

**The TEXT primitive (`ToolPreviewText`)** — closes the RFI gap "the
overlay channel carries shapes only, no text primitive". Consumer:
**paged.draw's Measure tool readout** (an on-canvas length/angle HUD was
a binding — impossible with shapes alone); future consumers: the
Dimension tool, crop HUDs, Ruler markers. `{ kind: "text", pageId, x,
y, text, size?, anchor?, background? }` — `kind` is the vocabulary's
first explicit discriminant (older variants discriminate structurally;
new primitives get one). `x`/`y` are in the SAME page-local-pt space as
every other preview variant; the host renders the label at constant
SCREEN size (its page-caption idiom), sanitizes to plain text (control
chars stripped, no markup), and `background: true` adds a small backing
plate for legibility. A pure pass-through in the adapter on the
existing channel — probe `supports("overlay.text@1")` (static, like
`overlay.toolPreview@1`: the renderer ships in the same host release
that bumps this SDK).

### 4.5a `host.overlay.setToolPreviews` — the multi-shape preview [K-9]

`setToolPreviews(shapes | null)` — publish MANY preview shapes at once,
rendered in array order (first = bottom-most). The channel `setToolPreview`
opened is SINGLE-SLOT (one `ToolPreviewShape`, last write wins, one node
rendered), which meant a tool could show geometry **or** a label, never
both.

**Consumers (the promotion rule), both naming the gap in their own code:**
- paged.draw's **Measure** (`draw-bundle/src/handlers/measure.ts`) — its
  header says it outright: *"`overlay.setToolPreview` is a SINGLE-SLOT
  channel … the frozen line is traded for the frozen numbers; that trade
  is named here rather than hidden. A multi-primitive preview channel is
  the follow-up RFI item."* With this door the measured segment and the
  `"124.60 pt · 53.1°"` readout ride together; the pointer-up SWAP goes
  away.
- paged.draw's region **Shape Builder**
  (`draw-bundle/src/handlers/shape-builder.ts`) — *"Single-slot channel:
  the hovered FACE outline wins … the gesture polyline stands in when the
  pointer is over no face."* It can highlight ONE face; it cannot shade
  the whole COLLECTED set, which is the interaction's actual feedback.

**Why an array and not a second annotation slot.** A dedicated
annotation/label slot fixes Measure (one geometry + one label) and does
nothing for Shape Builder, which needs N outlines of the SAME kind shaded
simultaneously. The array is the only shape that serves both named
consumers, and it stays in the existing vocabulary — no new primitive,
no second render path, no z-ordering vocabulary to invent.

**Why a new member and not a widened `setToolPreview` parameter.**
Widening the parameter to `shape | shape[] | null` would be smaller on
paper and worse in practice for two reasons. (1) *Silent mis-render*: the
existing renderer discriminates the variants structurally (`"cells" in
p`, `"anchors" in p`, …); an array satisfies none of them and falls
through to the rect branch, so a bundle built against a new SDK on a host
with an older renderer would draw garbage rather than degrade. (2) *A
static flag is then forced*: one member cannot report which arity the
host actually renders. A separate member lets
`supports("overlay.multiPreview@1")` be **DYNAMIC** — present-when-wired,
exactly like `rendering.sceneLayer@1` / `text.measure@1` / `images` —
because the sink is an OPTIONAL member on the editor handle
(`PagedEditor.overlaySignals.setToolPreviews?`). That is the honest
difference from `overlay.text@1`, whose flag is static.

**Additive, in all three directions.** `setToolPreview` is untouched and
every existing caller keeps working, including every one of the editor's
own built-in tool handlers. The handle member is optional, so an older editor
still satisfies `PagedEditor`. And when the sink is absent the door does
NOT throw or no-op: it forwards the FIRST shape through the single slot —
the pre-K-9 behaviour each consumer used to hand-code, now done once in
the adapter.

**One slot, two writers.** `setToolPreviews` REPLACES the slot's content;
`null` *and* `[]` clear it, so a bundle's teardown path is the same on
either host. It is deliberately not a second overlay layer: that would
resurrect z-ordering between the layers and double the teardown paths for
no consumer's benefit. Shapes may address different pages — each carries
its own `pageId` and the host resolves the page rect per shape. Same
`capabilities.rendering ∋ "overlay"` gate as the single-shape write: one
channel, one gate. The headless harness wires the sink (so the flag is
true and `lastToolPreviews()` records the list), which is what makes
"geometry AND label at once" conformance-assertable without a browser.

### 4.5b `host.text` — measurement + the caret read door [S-13 · C-9]
`measureString(family, style, text, sizePt)` (S-13 — real engine-shaper
metrics when the editor wires `PagedEditor.text`, an honest estimate
otherwise; `supports("text.measure@1")` tells a bundle which it got) and
`caret(): TextCaret | null` (C-9). The caret door exists because a
text-inserting plugin had no way to read the user's insertion point —
**paged.data's first-insert placement** landed every freshly-placed
variable field at story start, offset 0 (RFI §6 D-01 residual). The
caret lives in EDITOR state (the text-editing layer), not the engine,
so the editor injects a reader via
`CreateBundleHostOptions.textCaret` (the clipboard/consent injection
shape); no backend → `caret()` is always `null` and
`supports("text.caret@1")` is false. The answered `offset` is in the
engine text-op convention (`ContentSelection` story-local offsets — the
same value `insertText.offset` consumes). Honest v1 gaps, by contract:
a RANGE selection answers its START (where a replace inserts); a
cell-qualified caret (table cell) answers `null` — cell-local offsets
must not leak as story-local. Both are a read door — no capability
gate (like `viewport`).

### 4.5c `host.shell` — panel actions + the two FILE doors [K-5 · K-10]

`openPanel`/`closePanel` (the cockpit owns placement; the SDK adapter
stays a pure function over the editor handle) plus the file pair:
`pickFile(options?) → PickedFile[]` reads bytes IN (K-5 / S-11), and
`saveFile({ suggestedName, bytes, mimeType? }) → boolean` hands bytes
OUT (K-10). Both are BYTE-level by design — no DOM `File` or `Blob` ever
crosses the contract, so a bundle stays isolate-ready — and both answer
an honest "nothing happened" value instead of throwing.

**Consumer (the promotion rule):** **paged.image**. It can compute an
adjusted PSD/PNG/JPEG, but with `pickFile` READ-only the only way out was
the Export Center's exporter registry — a document-level surface — so a
bundle could not offer "Save adjusted copy…" from its own panel. `pickFile`
without `saveFile` is a half-door: a plugin that ingests a file has no way
to give the edited bytes back.

**Shape: the mirror of `PickedFile`, field for field.** `PickedFile` is
`{ name, bytes, mimeType }`; `SaveFileOptions` is `{ suggestedName, bytes,
mimeType? }`. The one rename is deliberate — `suggestedName` says what
the contract can honestly promise: the host may sanitize or de-duplicate
it, and a bundle can never name a *path* or a location. `mimeType` keeps
the picker's spelling so bytes picked from disk can be handed straight
back after an edit without re-keying the field.

**Why `boolean` and not `void` or a path.** A path would be a lie in a
browser host (there isn't one) and a liability in any host (a plugin that
learns filesystem locations is a new trust surface). `void` would hide the
frequent honest failure. `true` means the host ACCEPTED the bytes and
handed them to its save path; `false` means it did not — no saver wired,
the user declined, or the host refused. **Honest ceiling, stated in the
contract:** a host backed by the browser's anchor-download cannot observe
a user cancel, so `true` there means "delivered to the browser's download
path", not "a file exists on disk"; a File System Access backing can
answer a real `false`. Never a rejection: a refused save is a result, like
a refused mutation — a rejection would land as an unhandled promise in a
click handler.

**The flag is PER-MEMBER, unlike `shell.pickFile@1`.** A wired shell was
previously taken to imply the whole surface, so `shell.openPanel@1` and
`shell.pickFile@1` both flip on the option's presence. `saveFile` joined
the backend after host apps had already adopted the option, so
`supports("shell.saveFile@1")` is keyed on the MEMBER's presence
(`typeof shell.saveFile === "function"`). That forced a small structural
change: the option is now typed `ShellBackend` (the bundle-facing
`ShellSurface` with `saveFile` optional) and the bundle-facing surface
WRAPS it rather than BEING it — so a host app that predates the door
still injects a valid shell, and a missing member surfaces to a bundle as
`false`, never as *"host.shell.saveFile is not a function"*.

**No capability gate, for the same reason `pickFile` has none.** Neither
door reaches document state or another plugin's data; the host's own
dialog — the user choosing a file, or the browser's download — is the
consent step, and the host owns it entirely (name sanitization included).
A `capabilities.shell` tier is the follow-up if the isolate boundary ever
needs to budget these, not something to invent ahead of a consumer.

**Editor backing:** the app's existing anchor-download idiom, extracted
(not re-invented) — `apps/canvas/src/shell-file-saver.ts` now owns
blob→download and the Export Center's plugin-exporter delivery calls
straight into it, so plugin bytes leave the app through ONE mechanism.

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
| `document.collection`/`meta`/`pathAnchors`/`elementGeometry`/`tree`/`parentOf`/`getMetadata`/`onDidChange` | `capabilities.document.read` | throw |
| `document.hitTest` | `document.read` **and** `rendering` ∋ `"hitTest"` | throw |
| `selection.set` | `capabilities.document.write` | throw |
| `selection.get` / `onDidChange` | none (ambient UI state) | — |
| `overlay.setToolPreview` / `setToolPreviews` | `capabilities.rendering` ∋ `"overlay"` | throw |
| `shell.pickFile` / `saveFile` | none (host-owned dialog; §4.5c) | — |
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
  **→ SUPERSEDED IN PART by §12.6 (schema v1.1):** the catalog grew a
  `paged.list` leaf, so lists are now IN the schema. The custom-canvas
  half of this limit stands unchanged.
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

### 12.6 Schema v1.1 — the list / collection tier (B-01 lists + G3 applyEntity)

§12.4 recorded "no lists" as a v1 honest limit, with a REASON, not a
refusal: the curated primitive leaves had no list, and §2.8's rule is
"adopt the schema when the catalog grows it, not invent a rival." The
catalog has now grown one — the editor implemented the `paged.list` leaf
plus the collection/apply-entity plumbing in
`packages/shell/src/catalog/schema-panel-types.ts` (+ `leaves.tsx`,
`use-collection.ts`). This section is the contract's adoption of it.

**Consumers.** (1) The editor's own **schema-list demo panel**, which is
what proved the leaf renders a live collection and commits an
apply-entity write. (2) The **B-01 RFI row**
(`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`), whose
closure note explicitly parked layer/style lists as expert-leaf React —
this is the half that un-parks. (3) FIRST BUNDLE CONSUMER, upcoming:
**paged.draw's appearance + layers panels** — `layers.panel.json` is the
prototype §12.4 named as unable to adopt the schema; with `list` it can,
which retires an expert-leaf React panel from the draw bundle and moves
it onto the clonable, isolate-ready path.

**The shape** (mirrored EXACTLY from the editor — the members are
structurally identical, which is what keeps the injection-seam assert
honest):

- `PanelSchemaRow.list?: SchemaListSpec` — additive, optional, present
  iff the row's `widget` is the list leaf. A v1 schema never sets it and
  renders unchanged.
- `SchemaListSpec { items, labelField, secondaryField?, idField?,
  selectionBinding?, actions? }` — `labelField`/`secondaryField`/
  `idField` are dot-paths into a row object (`idField` defaults to
  `selfId`, the summary-shape convention every document collection
  uses); `selectionBinding` names a published binding that receives the
  clicked row's id.
- `WidgetCollectionBinding = { kind: "documentCollection"; collection }
  | { kind: "binding"; bind }` — the two live-collection lanes: a named
  ENGINE collection (the `host.document.collection(name)` lane), or an
  ARRAY the plugin publishes through `host.bindings.publish(name, rows)`
  (§12.2's door, now carrying rows instead of a boolean).
- `SchemaListAction { label, action, enabled? }` and
  `SchemaRowAction = { kind: "command"; command } | { kind:
  "applyEntity"; scope?, path, valueType? }` — a row action either
  dispatches a registered command with the row id as payload, or applies
  the row's entity id (style / swatch self-id) to the selection through
  the SAME `setElementProperty` channel the scalar widgets commit on.
  `valueType` picks the wire payload (`text` for applied-style paths,
  `colorRef` for swatch/gradient paths).

**The binding ceiling is untouched — that is still the point.** A list
does not EVALUATE anything: rows come from a named collection or a
published array (a lookup, not a query), and an action writes exactly
ONE typed `PropertyPath` (a write, not an expression). `selectionBinding`
feeds §12.2 rather than forking it — the clicked id becomes a published
value other rows/sections gate on, which is the same
derived-bound-value discipline B-01's closure prescribed. No
`visibleWhen`/`enabledWhen` DSL enters here either.

**Additivity + the seam.** Every member above is new and optional; no
existing member changed, no manifest field, no new host door, no
capability. The editor holds the assert: `apps/canvas/src/main.tsx`
(`_AssertSchemaRenderer`) requires the injected `HostSchemaPanelRenderer`
to satisfy plugin-api's `SchemaPanelRenderer`, which (props being
contravariant) requires the CONTRACT's `SchemaPanelRendererProps` to be
assignable to the shell's — i.e. **contract `PanelSchema` ⊆ editor
`PanelSchema`**. Mirroring the shapes verbatim keeps that true; a drift
on either side fails the EDITOR's typecheck at the injection seam, never
a plugin author's build.

One asymmetry is EXPECTED and worth naming, because it looks like drift
and isn't: the shell's shapes are NOT assignable back to the contract's,
by exactly one member. `SchemaRowAction.applyEntity.path` is a
`PropertyPath`, and the shell reads that union from the editor's
protocol-56 client while the contract reads it from the vendored
protocol-51 wire — so the shell's union has one extra literal
(`"closePath"`, §4.3a's path-topology op). The editor mirror's own header
states the rule this satisfies: it must be a structural SUPERSET. The
required direction holds; the reverse closes on the next
`sync-wire.mjs`.

**Still honest about what is NOT here.** Custom on-canvas widgets remain
expert-leaf React (§12.4's other half). A list is a flat row list — no
tree, no drag-reorder, no inline rename; a layers panel that needs
reordering still reaches for `mutate` (`layerMove`) behind a row action,
not for a schema affordance that does not exist.

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
