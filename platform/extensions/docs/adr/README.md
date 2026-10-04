# Architecture decision records

An ADR records one load-bearing decision that has already been made: what was decided, what
in the code shows it, and what it obliges other code to do. It is a record, not a proposal.
When the code stops matching a record, the body is left as it is and a dated amendment is
added at the end.

ADR numbers are unique across the paged-media repositories, so a number names the same
record wherever it is cited. New records in this repository use 300–349. Records 010, 012
and 017 predate that scheme and keep their numbers. Records 300–319 were written on
2026-10-02 from the code as it stood, for decisions made earlier; their status says so.
Records 314–319 describe decisions that several plugin repositories share. They are kept
here because this is the repository every plugin depends on, and each one names the plugins
that follow it and those that do not.

| ADR | Title | Status |
|---|---|---|
| [010](010-raw-mutate-gate-capability-enforcement.md) | The raw-mutate gate + in-process capability enforcement line | Accepted (amended 2026-10-02) |
| [012](012-k1-modal-session-undo-coalescing.md) | K-1 modal sessions: the §8.0 seamless-undo coalescing boundary | Accepted (amended 2026-10-02) |
| [017](017-importer-exporter-door-shape.md) | Importer / exporter door shape: resolve-by-extension, load-into-engine (K-2) | Accepted (amended 2026-10-02) |
| [300](300-type-only-contract.md) | The contract package is type-only; values reach a bundle through the host object | Accepted, recorded retroactively 2026-10-02 |
| [301](301-host-adapter-lives-in-plugin-sdk.md) | The host adapter lives in plugin-sdk, not in the editor | Accepted, recorded retroactively 2026-10-02 |
| [302](302-vendored-wire-types.md) | Engine wire types are vendored and re-synced on each protocol bump | Accepted, recorded retroactively 2026-10-02 |
| [303](303-manifest-schema.md) | The manifest is a closed-vocabulary schema; the CLI mirrors it without dependencies | Accepted, recorded retroactively 2026-10-02 |
| [304](304-bundle-lifecycle.md) | Bundle lifecycle: one synchronous activate, structural teardown, guarded activation | Accepted, recorded retroactively 2026-10-02 |
| [305](305-doors-always-present.md) | Every door is always present; a missing backend answers honestly and `supports()` reports it | Accepted, recorded retroactively 2026-10-02 |
| [306](306-canary-releases.md) | Releases: a canary on every push, version-gated, published without tokens | Accepted, recorded retroactively 2026-10-02 |
| [307](307-contract-as-peer-dependency.md) | Bundles take the contract packages as peer dependencies | Accepted, recorded retroactively 2026-10-02 |
| [308](308-plugin-wasm.md) | Plugin wasm is a declared capability, loaded by the bundle, under one app-wide size budget | Accepted, recorded retroactively 2026-10-02 |
| [309](309-conformance-against-real-engine.md) | Conformance runs against the real published engine | Accepted, recorded retroactively 2026-10-02 |
| [310](310-one-write-door.md) | One write door: `document.mutate`, engine-owned history, failures as outcomes | Accepted, recorded retroactively 2026-10-02 |
| [311](311-plugin-state-under-own-id.md) | Plugin state lives only under the plugin's own id | Accepted, recorded retroactively 2026-10-02 |
| [312](312-panels-as-data.md) | Panels cross the boundary as data: a schema plus bindings, no expression language | Accepted, recorded retroactively 2026-10-02 |
| [313](313-no-react-at-load.md) | plugin-sdk loads without React; the build target is the gate | Accepted, recorded retroactively 2026-10-02 |
| [314](314-plugin-shape.md) | The plugin shape: semantics in Rust behind one wasm module, a logic-free shim, one published package | Accepted, recorded retroactively 2026-10-02 |
| [315](315-isolation-contract.md) | The isolation contract: a plugin depends only on the published contract; a gap becomes a host door | Accepted, recorded retroactively 2026-10-02 |
| [316](316-native-content-and-baking.md) | Plugin content is stored as valid native document content; baking is the fallback | Accepted, recorded retroactively 2026-10-02 |
| [317](317-registry-driven-dispatch.md) | Function and kernel dispatch is generated from a registry, with a coverage gate | Accepted, recorded retroactively 2026-10-02 |
| [318](318-host-spawned-workers.md) | Workers are spawned by the host on a declared capability | Accepted, recorded retroactively 2026-10-02 |
| [319](319-trust-line.md) | The trust line: first-party bundles run in-process today; the isolate boundary is the real line | Accepted, recorded retroactively 2026-10-02 |
| [320](320-binary-lanes-for-scene-images-and-parts.md) | Scene images and container parts cross as bytes; the SDK keeps the JSON fallback | Accepted 2026-10-04 |
| [321](321-host-colour-picker-widget.md) | The host lends its colour picker as a widget; it never writes the document | Accepted 2026-10-04 |
| [322](322-plugin-hooks-save-entry-tool-settings-undo-labels.md) | Four host hooks for stateful content plugins: will-save, context entry, tool settings, undo labels | Accepted 2026-10-04 |

Decisions made in other repositories that this repository's code rests on are listed in
[`../README.md`](../README.md).
