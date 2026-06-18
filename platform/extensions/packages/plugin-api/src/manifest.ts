// The plugin manifest — the serializable identity + contribution
// declaration every bundle ships as `manifest.json`. Mirrors
// `manifest.schema.json` (the CLI validates against the schema; these
// types keep TS authors honest).
//
// API v0 status: the manifest is ENFORCED, not advisory (W3.10 /
// trust-line W0.11). A door a bundle USES must be DECLARED here — the
// host's capability gate (plugin-sdk `createBundleHost`) refuses an
// undeclared use (a thrown `PluginCapabilityError` for the contribution
// + read doors, a non-applied `MutationOutcome` for the write doors).
// v1 stance: in-process, no isolation — this is HONESTY +
// accident-prevention, NOT a security boundary against malicious code
// (a bundle holding the raw `host.editor` handle still bypasses the
// facade). The gate is at the same chokepoint as the namespace rule
// (DESIGN.md §2.7/§11); the host option `capabilityMode: 'warn'` is the
// migration escape hatch. See thoughts/docs/paged/plugin-trust-line.md.

import type { AssetKind } from "./assets";

/** Reverse-DNS plugin identity, e.g. `media.paged.draw`. Doubles as
 *  the namespace prefix for every contribution id the bundle
 *  registers (`media.paged.draw.tool.pen`). */
export type PluginId = string;

export interface PluginManifest {
  id: PluginId;
  /** Human-readable name, e.g. "paged.draw". */
  name: string;
  /** Bundle semver. */
  version: string;
  /** Semver range against `@paged-media/plugin-api`. */
  apiVersion: string;
  publisher?: string;
  capabilities?: PluginCapabilities;
  contributes?: PluginContributions;
}

export interface PluginCapabilities {
  /** read-broad / write-scoped is the intended default. Declaring
   *  `document` is the PREREQUISITE for the document surface: a bundle
   *  with no `document` capability cannot read OR write the document
   *  (the host gate throws). `read` gates the read doors
   *  (collection/meta/tree/pathAnchors/elementGeometry/getMetadata/
   *  onDidChange); `write` gates the write doors (mutate/undo/redo/
   *  setMetadata) AND `selection.set` (a document-level action). When
   *  enforcement is on, an absent sub-field denies that direction. */
  document?: {
    read?: "broad" | "scoped";
    write?: "broad" | "scoped";
  };
  /** Render-pipeline surfaces the bundle uses. `overlay` means the
   *  shared TS overlay signals (tool previews) AND `contribute.overlay`;
   *  `hitTest` gates `document.hitTest`; `sceneLayer` gates the in-frame
   *  `contribute.sceneLayer()` channel (C-1); `resourceProvider` gates
   *  the renderer pyramid-tile door `host.images.claimImageResource`
   *  (C-6 / I-06). Declaring a surface is the prerequisite for the
   *  matching door (the host gate throws on an undeclared use). */
  rendering?: Array<
    "sceneLayer" | "overlay" | "hitTest" | "resourceProvider"
  >;
  /** The bundle registers keybindings directly via
   *  `contribute.keybinding`. Keybindings have no id to list under
   *  `contributes`, so this boolean is their declaration. v0 first-
   *  party bundles let the HOST derive activation shortcuts from the
   *  tool registry (B-15), so this stays `false`/absent for them; a
   *  bundle that wires its OWN keybindings must declare it. */
  keybindings?: boolean;
  /** Edit-context content types the bundle claims (P0 shell work —
   *  reserved, not yet wired). */
  editContext?: string[];
  /**
   * Asset-store reads the bundle uses (paged.web W-06). A closed array
   * vocabulary: v1 has exactly `"fonts"` (gates `host.assets.getFontFace`
   * — serving DOCUMENT font face bytes for `@font-face`). `"images"` is
   * RESERVED for v2 and REJECTED by validation today (the door has no
   * image read yet; accepting the declaration would claim a capability
   * the host cannot honor). Declaring `"fonts"` is the prerequisite for
   * the door (the host gate throws on an undeclared use). See
   * DESIGN.md §13. */
  assets?: AssetKind[];
  /**
   * Persistent BINARY storage the bundle uses (K-4 / S-08). The KV
   * `host.storage` (localStorage JSON) is always available ungated; this
   * capability gates the OPFS-backed `host.blob` byte store for payloads
   * too large for KV (multi-MB workbook bytes, decode spill). Declaring
   * `blob: true` is the prerequisite for every `host.blob` door (the host
   * gate throws on an undeclared use). `quotaBytes`, when present,
   * REQUESTS a ceiling — the host enforces the stricter of it and its
   * hard per-plugin cap; `host.blob.usage()` reports the granted value.
   */
  storage?: StorageCapability;
  /**
   * Network reach the bundle declares (paged.data D-03; base-idea §11). The
   * boolean form is the legacy shorthand (`true` = the bundle reaches the
   * network, every origin still gated behind runtime consent; `false`/absent =
   * no network). The object form declares a per-origin allow-list + a
   * human-readable purpose the consent UI shows. Reach is NEVER silent: every
   * origin is gated behind `host.network.requestConsent` (the visible
   * data-source manifest), and a document does NOT fetch on open — external
   * sources are inert until the user reviews + consents (base-idea §11). This
   * is the OUTER bound; consent is the inner gate.
   */
  network?: boolean | NetworkCapability;
  /**
   * Data-provider roles (paged.data §7.1 / D-09): the neutral cross-plugin
   * composition where one plugin PUBLISHES a resolved dataset and another
   * CONSUMES it (e.g. a sheet sourced from a governed query) — they rendezvous
   * ONLY at the core `host.dataProviders` registry, never by direct contact.
   * `publish` = the categories this bundle may register providers in; `consume`
   * = the categories it may discover + read. A bundle declaring neither role
   * gets no surface.
   */
  dataProviders?: DataProvidersCapability;
  /**
   * The clipboard door's grant (K-6 / S-14). Gates `host.clipboard`:
   * `"full"` grants BOTH the text and the rich `tabular` (cell-grid)
   * payload — the sheets range copy/paste interchange; `"vector"` grants
   * the `text` half only (a vector plugin copies a textual representation,
   * not a cell grid — a `tabular` write is dropped); `"none"` (the
   * default) / absent DENIES the door (read → `null`, write refused). See
   * `clipboard.ts` for the surface + DESIGN.md for the trust line.
   */
  clipboard?: "none" | "vector" | "full";
  /**
   * Declared WebAssembly artifacts the bundle ships and loads at
   * runtime (paged.web W-07 — e.g. a future HTML/CSS layout engine
   * compiled to wasm). Capability-gated: a bundle CANNOT instantiate a
   * module the host has not granted via the loader, and only the paths
   * listed here are loadable (declared-only). See DESIGN.md §10 and
   * `docs/wasm-packaging.md` for the budget rules and trust line.
   *
   * The wasm gets NO ambient authority: it has no direct engine/DOM/
   * network handle and talks only through the bundle's already-gated
   * JS. Threads/SharedArrayBuffer are OFF in v1.
   */
  wasm?: WasmArtifact[];
  /**
   * Worker spawn + SharedArrayBuffer reach the bundle declares (K-3 /
   * S-07 / I-02). Gates `host.workers`: a bundle CANNOT spawn a worker
   * without declaring it, and only modules listed under a declared path
   * (bundle-relative, like the wasm artifacts) may be spawned — never an
   * arbitrary URL. `max` is the worker-count ceiling the host grants
   * (clamped to `min(declared, hardwareConcurrency, 8)`); `sharedMemory`
   * declares `SharedArrayBuffer` use (gates `allocateShared`; absent ⇒
   * message-copy only). Declaring `workers` is the prerequisite for the
   * door (the host gate throws on an undeclared spawn).
   *
   * The worker gets NO ambient authority — no engine/DOM/network handle,
   * only the bundle's already-gated JS talks to it; the SAB is a separate
   * bundle-owned allocation, host-budgeted (a per-bundle shared-memory
   * ceiling the host enforces, default 256 MiB, which a manifest
   * `maxSharedBytes` may only TIGHTEN). v1 stance: honesty +
   * accident-prevention, not a security boundary (the isolate migration
   * is the real boundary). See the K-3 design note.
   */
  workers?: WorkersCapability;
  /**
   * The host CREDENTIAL-STORE door's grant (D-11; rfc-credential-store).
   * Gates `host.secrets`: a bundle that does not declare `secrets` cannot
   * reach the store (the host gate throws). `sources: true` is the v1
   * grant — credentials for authenticated DB-attach / remote sources.
   *
   * The store is REFERENCE-ONLY and host-owned: a bundle holds
   * `credentialRef` strings (e.g. `keychain:source-4`), NEVER secret
   * material. The surface has `set` (host-UI-prompted) / `exists` /
   * `forget` and DELIBERATELY NO `get` — secret bytes never enter the
   * plugin realm. The plugin passes the ref to the host attach/fetch door
   * and the HOST injects the connection string / Authorization header on
   * its side of the wire (pairs with the D-03 consent door). See the RFC
   * and DESIGN.md §16.
   */
  secrets?: SecretsCapability;
  /**
   * GPU (WebGPU) usage the bundle declares (I-07 / C-1 Stage B — the
   * buildable, realm-local half; ADR-018). DECLARE-ONLY: this does NOT hand
   * the bundle a `GPUDevice` (the bundle already has `navigator.gpu` in its
   * own JS realm — paged.image's Engine-B drives WebGPU there today). It
   * LEGITIMIZES that usage within the capability contract so the host can
   * surface "this plugin uses the GPU" to the user, exactly as the wasm
   * artifacts are declare-only.
   *
   * `realm: "bundle"` is the ONLY value that validates today: the plugin uses
   * WebGPU in its OWN realm (no host involvement, no zero-copy composite into
   * the page scene). `realm: "shared"` is RESERVED in the vocabulary for the
   * future host-device-sharing path (a host-blessed `GPUDevice` + a
   * `SceneItem::Texture` zero-copy composite) and is REJECTED by validation —
   * that path is blocked on TWO walls (Vello has no external-texture import;
   * WebGPU can't transfer a device across the render-worker/main-thread realm
   * boundary) and stays deferred record-only (ADR-018). There is NO
   * `requestGpuDevice` / device surface; adding one would be a fake.
   */
  gpu?: GpuCapability;
}

/** WebGPU usage declaration (I-07 / C-1 Stage B realm-local; ADR-018).
 *  DECLARE-ONLY — no device is handed to the bundle. `realm: "bundle"` is the
 *  only value validation accepts today (the plugin uses WebGPU in its own JS
 *  realm); `realm: "shared"` is reserved for the future host-device-sharing
 *  path and rejected until the zero-copy walls lift. A closed vocabulary so
 *  the host can reason about the grant. */
export interface GpuCapability {
  /** `"bundle"` — the plugin uses WebGPU in its own JS realm (the only value
   *  accepted today). `"shared"` is reserved for future host-device-sharing
   *  (currently rejected by validation). */
  realm: "bundle" | "shared";
}

/** Credential-store declaration (D-11; rfc-credential-store). `sources`
 *  gates the `host.secrets` door for authenticated DB-attach / remote
 *  sources — the v1 (and only) grant. A closed vocabulary so the host can
 *  reason about it; an absent/false `sources` denies the door. */
export interface SecretsCapability {
  /** Grant the credential store for data sources (DB-attach / remote). */
  sources: boolean;
}

/** Worker spawn + SAB declaration (K-3 / S-07). `max` is the requested
 *  worker-count ceiling (the host clamps to a hard cap); `sharedMemory`
 *  declares `SharedArrayBuffer` use; `maxSharedBytes`, when present,
 *  REQUESTS a per-bundle shared-memory ceiling — the host enforces the
 *  stricter of it and its hard cap. */
export interface WorkersCapability {
  /** Worker-count ceiling the bundle requests; the host grants
   *  `min(max, hardwareConcurrency, 8)`. */
  max: number;
  /** Declares `SharedArrayBuffer` use — gates `BundleWorker.allocateShared`.
   *  Absent/false ⇒ message-copy only (`allocateShared` returns `null`). */
  sharedMemory?: boolean;
  /** Optional per-bundle shared-memory ceiling, in bytes. Tightens —
   *  never widens — the host's hard cap (default 256 MiB). */
  maxSharedBytes?: number;
}

/** Persistent binary-storage declaration (K-4 / S-08). `blob` gates the
 *  OPFS-backed `host.blob` byte store; `quotaBytes` requests a ceiling
 *  (the host enforces the stricter of it and its hard per-plugin cap). */
export interface StorageCapability {
  blob?: boolean;
  quotaBytes?: number;
}

/** A structured network declaration (paged.data D-03; base-idea §11). The
 *  `origins` allow-list is the OUTER bound — the set of `scheme://host[:port]`
 *  the bundle may EVER request; runtime per-origin consent is the inner gate.
 *  The string `"consent"` means the bundle has no fixed list (author-supplied
 *  sources) — every reach requires runtime consent and none is pre-allowed. */
export interface NetworkCapability {
  origins: string[] | "consent";
  /** Human-readable reason shown in the consent UI / data-source manifest. */
  purpose?: string;
}

/** Data-provider roles (paged.data §7.1 / D-09). Categories are a neutral, open
 *  string vocabulary (`"dataset"`, …) — discovery is BY CATEGORY, never by
 *  plugin identity. The PROVIDER and CONSUMER plugins each declare only their
 *  own role; they never name or import each other (§2.1). */
export interface DataProvidersCapability {
  /** Categories this bundle MAY register providers in (the publish role). */
  publish?: string[];
  /** Categories this bundle MAY discover + read (the consume role). */
  consume?: string[];
}

/** Purposes a bundle may declare for a shipped wasm module. A closed
 *  vocabulary (like `rendering`) so the host can reason about grants;
 *  unknown purposes are rejected at validation. v1:
 *  - `layout`  — a foreign-document layout/measure engine (paged.web).
 *  - `codec`   — encode/decode (image/font transforms).
 *  - `compute` — generic pure computation with no special host role.
 *  - `engine`  — a vendored data/query/DB engine whose release artifact
 *               legitimately exceeds the default per-artifact ceiling
 *               (DuckDB-WASM ≈ 36 MiB; paged.data). Governed: it earns
 *               the HIGHER artifact ceiling (D-07b) but is otherwise an
 *               ordinary declared+budgeted module — the higher cap is
 *               the only difference, and a manifest `maxBytes` may still
 *               tighten it. */
export type WasmPurpose = "layout" | "codec" | "compute" | "engine";

/** One declared wasm artifact. `path` is bundle-relative (no leading
 *  slash, no `..`); `maxBytes`, when present, tightens — never widens —
 *  the host's per-artifact ceiling (see the budget table in
 *  `docs/wasm-packaging.md`). */
export interface WasmArtifact {
  /** Logical name the bundle passes to the host loader
   *  (`loadBundleWasm(bundle, name)`). Unique within the manifest. */
  name: string;
  /** Bundle-relative path to the `.wasm` file. No leading `/`, no `..`
   *  segment (path-traversal is rejected at validation). */
  path: string;
  /** Why the bundle ships this module — gates what the host grants. */
  purpose: WasmPurpose;
  /** Optional per-artifact byte ceiling the bundle self-imposes. Must
   *  be ≤ the host's hard per-artifact ceiling; the loader enforces the
   *  stricter of the two. */
  maxBytes?: number;
}

export interface PluginContributions {
  /** Tool ids the bundle registers. Must be namespaced by `id`. */
  tools?: string[];
  /** Panel ids the bundle registers (expert-leaf React in v0) or
   *  paths to `*.panel.json` prototypes (design specs, not yet
   *  interpreted by the host). */
  panels?: string[];
  /** Command ids the bundle registers. Must be namespaced by `id`. */
  commands?: string[];
  /** Reserved for the P0 edit-context registry. `priority` (decision
   *  Q12, 2026-06-06) reserves the multi-plugin contention shape NOW:
   *  when two plugins claim one content type, runtime policy (ships
   *  at P7) is user choice with a remembered per-content-type
   *  default, first-party initially; higher priority orders the
   *  choice list. First-installed-wins is rejected — install-order
   *  nondeterminism is undebuggable. */
  editContexts?: Array<{
    type: string;
    entry: "doubleClick" | "command";
    priority?: number;
  }>;
  /** Reserved (paged.web §9.1.2): plugin-defined object types under
   *  the metadata-plus-baked-fallback contract. */
  objectTypes?: Array<{
    type: string;
    bakedFallback: "group" | "rectangle" | "raster";
  }>;
  /** Importer ids the bundle registers (K-2 / S-06). Must be namespaced
   *  by `id`. The rich `ImporterContribution` (extensions, MIME, the
   *  `import()` callback) is handed in at `host.contribute.importer(...)`
   *  — the manifest only DECLARES which ids may register. */
  importers?: string[];
  /** Exporter ids the bundle registers (K-2 / S-06). Must be namespaced
   *  by `id`. */
  exporters?: string[];
  /** `.paged` CONTAINER part-types this plugin persists (file-format.md
   *  §4 / §8.1). Each extended object is stored in three ROLES: `spec` (the
   *  canonical JSON definition — small, diffable, must round-trip), `source`
   *  (the bytes the spec operates on — binary, embeddable or linked, §6), and
   *  `derived` (the regenerable, producer-stamped flatten kept for viewers
   *  without a compute engine). A bundle DECLARES the part-types it owns here;
   *  the container's `manifest.json` binds to this declaration directly (one
   *  registry, not two), so third-party plugins persist namespaced parts
   *  WITHOUT central blessing of each data type. The bytes are read/written
   *  through the `host.parts` door into the plugin's own `paged/<plugin-id>/`
   *  namespace. Purely DECLARATIVE — no runtime behaviour rides on this. */
  partTypes?: Array<{
    /** A plugin-local type name (e.g. "sheet", "imageStack", "barcode"). */
    type: string;
    /** Which of the three storage roles this part fills. */
    role: "spec" | "source" | "derived";
    /** The part's serialization — advisory metadata for tooling + the
     *  container manifest (e.g. "json", "parquet", "png", "svg", "pdf"). */
    format: string;
    /** `source` parts only: whether this part MAY be linked to an external
     *  URI (with a cached snapshot in the container) rather than embedded
     *  (file-format.md §6 embedded-vs-linked). */
    linkable?: boolean;
  }>;
}
