# Plugin trust line — same-realm is first-party-only

**2026-06-07 (entries added through 2026-06-08) · reference: the gate checklist and its
reasoning.** The decision itself is recorded in [ADR 319](../adr/319-trust-line.md), the
in-process capability gate in
[ADR 010](../adr/010-raw-mutate-gate-capability-enforcement.md). **Sources:** `DESIGN.md`
§2/§3/§6/§4.9 and the original plugin-platform concept paper (unpublished). Section
references below (§2.7, §3, §4.8, §4.9, §6, §11) are to `DESIGN.md` at the repository root.

## The decision

*Status note (2026-10-02): this section predates the implementation; the capability
enforcement that item 2 describes as advisory is now enforced in-process — see the checklist
below, [ADR 010](../adr/010-raw-mutate-gate-capability-enforcement.md) and `DESIGN.md` §11.*

**Same-realm bundle execution is FIRST-PARTY-ONLY policy.** Today every loaded
bundle runs in the host realm with a full `BundleHost` and — via the gesture
spine's `onActivate(paged)` and `host.editor` (§4.9) — the raw `PagedEditor`.
That is the declared incubation posture for paged.draw + paged.web and it is
fine *for code we author and ship*. It is **not** a third-party plugin loading
mechanism, and nothing may quietly turn it into one.

Any third-party / external plugin loading requires, as a hard prerequisite:

1. **The isolate/RPC host** — the second implementation of `BundleHost` that
   DESIGN.md §3/§6 reserves: `createBundleHostProxy` over RPC into a
   per-plugin isolate (the original platform concept said QuickJS-per-plugin;
   the engine is now **Boa**, which has **no** per-plugin isolate primitive — so
   this becomes a Boa-context-per-plugin or, more likely, worker-per-plugin
   boundary; the isolate story has to be re-derived for Boa, see
   [ADR 001](https://github.com/paged-media/core/blob/main/docs/adr/001-boa-over-quickjs.md)).
   The bundle source is unchanged; the *host object* is what gets proxied. This
   is the one structural change that retires `host.editor` (§4.9: "dies at the
   boundary, by design").
2. **Capability enforcement** at the namespace chokepoint (§2.7, §4.8). Today
   the chokepoint scopes *contribution ids* and *metadata keys* (the
   `<manifest.id>.*` / `x-paged:<id>` rule); it does not gate *capability*.
   Manifest permissions are advisory. Both must become enforced — at the
   engine boundary, where the isolate puts the trust line — before any
   foreign code loads.

The drift to guard against is **drift-by-default**: shipping third-party
plugins on the same-realm path "because it works." It works because it is
unprotected. The host-adapter-in-plugin-sdk design keeps the RPC door open
precisely so this stays a flip, not a rewrite — but the flip is gated, below.

## Known same-realm debts (the distance to close)

*Status note (2026-10-02): this section predates the implementation; a declarative panel form
now exists beside the React panel and overlay doors, which still take live components — see
[ADR 312](../adr/312-panels-as-data.md) and `DESIGN.md` §6 and §12.*

Same-realm makes these benign-in-process and load-bearing-at-the-boundary:

- **Engine metadata gate caller identity — RESOLVED (2026-06-08,
  protocol v36).** Was: the `x-paged:<id>` per-plugin isolation lived only in
  the SDK door (`packages/plugin-sdk/src/host-impl.ts` `foreignMetadataKey`),
  so a bundle holding the raw handle could
  `mutate({op:"setPluginMetadata", key:"x-paged:<other>"})`
  and write another plugin's namespace. Now: an additive `caller:
  Option<String>` rides the wire op;
  `core: crates/paged-mutate/src/apply/layer.rs`
  `apply_plugin_metadata` enforces key == `x-paged:<caller>` server-side when
  `caller` is set (test
  `evid_plugin_metadata_caller_gate_blocks_foreign_namespace` in
  `core: crates/paged-mutate/tests/evidence_mutation_frame_props.rs`),
  and the SDK door names the caller (`setMetadata` →
  `caller: manifest.id`). `caller:None` keeps the prefix-only back-compat for
  the editor / `paged.script`. Published
  `@paged-media/canvas-wasm@0.36.0`.
- **Facade bypass — RESOLVED (2026-06-08).** Was:
  `plugin-draw: packages/draw-bundle/src/handlers/anchors.ts` reached the raw
  spine handle (`paged.client.send`/`pathAnchors`/`mutate`,
  `paged.selection.elementSelection`, `paged.camera.camera.scale`) where
  facades exist (§4.9 violation). Now: the anchor handlers run on `host.*`
  facades (`host.document.hitTest/pathAnchors/mutate`, `host.selection.get`,
  `host.viewport.pxToPt`); `onActivate` is a lifecycle no-op, no captured
  spine. The tool would survive the isolate (async facades) — the dogfooding
  proof the facade is sufficient for a real tool.
- **Panel/overlay live references.** `contribute.panel`/`overlay` cross
  as live React `ComponentType`s. DESIGN.md §6 tables this as a v0 exception
  with a deferred exit (declarative catalog schema + `codeEditor`/
  `customCanvas` host widgets); the exit is unbuilt. The
  "second impl of the same interface" claim is true for
  document/selection/viewport/storage/diagnostics/command/keybinding, largely
  true for `tool` (event-in/intent-out machine), **false** for panel/overlay
  until the schema lands. Tracked in the internal gap register, not re-logged
  here.
- **Script budgets — wall-clock landed (2026-06-07).** Boa RuntimeLimits
  (loop/recursion/stack) + a host-injected wall-clock deadline at every
  host-call boundary, typed `ScriptBudgetKind` over the wire
  (`core: crates/paged-script/src/lib.rs`). Still boundary work: per-context
  memory caps and true preemption of host-call-free
  busy loops (needs worker termination = the isolate). Cited, not
  re-tracked.

## Gate checklist — flipping the policy

*Status note (2026-10-02): the boxes are as last ticked on 2026-06-08. Since then two bundles
have used `host.editor` again, each as a named escape hatch
(`plugin-draw: packages/draw-bundle/src/handlers/measure.ts`,
`plugin-publish: packages/publish-bundle/src/io/idml.ts`), and the capability gate covers more
doors than the ones listed here; the current state is recorded in
[ADR 319](../adr/319-trust-line.md) and in the amendment to
[ADR 010](../adr/010-raw-mutate-gate-capability-enforcement.md).*

Same-realm stays first-party-only until ALL of:

- [ ] `createBundleHostProxy` (RPC over a per-plugin isolate) implemented and
      passing the same conformance the in-process host passes.
- [ ] `host.editor` removed from the surface (the §4.9 member that cannot
      survive RPC). Every first-party bundle is now migrated off the raw
      handle (2026-06-08 — draw runs on `host.*`
      facades, not `paged.*`); removing the `host.editor` member itself stays
      gated on the isolate.
- [x] Caller identity enforced at the engine boundary (2026-06-08,
      protocol v36): `setPluginMetadata` rejects keys outside
      the *calling* plugin's namespace server-side (`caller` field +
      `apply_plugin_metadata` gate), not just in the SDK door.
- [x] Manifest capabilities ENFORCED, not advisory — the namespace chokepoint
      (§2.7/§4.8) gates capability, denials are loud. **(2026-06-07:
      the IN-PROCESS half.** `createBundleHost` enforces declaration↔use at
      every facade chokepoint: contributed ids must be listed in the matching
      `contributes.*` category; `document` read/write doors require
      `capabilities.document.read`/`write`; hitTest/overlay/keybinding doors
      require their capability (new additive `capabilities.keybindings`
      boolean). Violations throw `PluginCapabilityError` (contribution +
      read doors) or return a non-applied `MutationOutcome` (write doors —
      mutate-never-throws), same loud-honesty as the namespace gate;
      `capabilityMode: 'enforce' | 'warn'` (default enforce) is the
      migration hatch. Both first-party manifests were already complete —
      zero undeclared use caught. The ENGINE-boundary enforcement — where
      the isolate puts the trust line — remains the open half:
      this gate is honesty/accident-prevention in-process, not a boundary
      against a bundle holding the raw `host.editor` handle. Table:
      `DESIGN.md` §11.)
- [ ] Panel/overlay isolate exit built: the declarative catalog schema +
      host widgets, so no live component reference
      crosses the boundary.
- [ ] Script budgets complete: wall-clock + memory caps on top of the landed
      loop/recursion limits. **(Wall-clock half landed in core,
      2026-06-07: host-injected deadline checked at every host-call
      boundary, per-execution `ScriptBudget` config, typed
      `ScriptBudgetKind` over the wire, non-catchable.
      Memory caps remain open. True preemption
      of a host-call-free busy loop needs worker termination = the isolate
      exit.)**
- [ ] Package trust: signed bundles + integrity verification on load
      (the original platform concept promised signing; absent today).

Until every box is checked, the loader accepts first-party bundles only, and
that constraint is asserted in code at the load path — not left to convention.
The assertion lives in `packages/plugin-sdk/src/load.ts`: `loadBundle`
reads the HOST's trust vouch (`CreateBundleHostOptions.trust`, type
`BundleTrust = "first-party"`, defaulting to `"first-party"`) and **throws**
for any other value, pointing at this gate checklist. The vouch comes from the
host, not the bundle, by necessity — there is no trustworthy signal *on* the
bundle yet: the manifest `id` namespace (`media.paged.*`) is self-asserted (a
foreign bundle could claim it) and package signing is the last unchecked box
above. So the assertion does not *authenticate* a bundle as first-party; it
makes the host's first-party-only **decision** explicit and load-bearing in
code, so the drift-by-default this record warns about (a quiet dynamic-import
of foreign code onto the same-realm path) becomes a deliberate, greppable,
reviewable act that still does not execute until the isolate/RPC host, enforced
capabilities, and signing land. Real cryptographic authentication of a bundle's
provenance arrives with the signing box; until then this is host-vouched, not
bundle-proven, and the comment in `load.ts` says so.
