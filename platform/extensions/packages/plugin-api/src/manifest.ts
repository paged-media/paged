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
  /** Render-pipeline surfaces the bundle uses. v0: `overlay` means
   *  the shared TS overlay signals (tool previews) AND
   *  `contribute.overlay`; `hitTest` gates `document.hitTest`;
   *  `sceneLayer` is reserved for the P2 channel. Declaring a surface
   *  is the prerequisite for the matching door (the host gate throws
   *  on an undeclared use). */
  rendering?: Array<"sceneLayer" | "overlay" | "hitTest">;
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

/** Purposes a bundle may declare for a shipped wasm module. A closed
 *  vocabulary (like `rendering`) so the host can reason about grants;
 *  unknown purposes are rejected at validation. v1:
 *  - `layout`  — a foreign-document layout/measure engine (paged.web).
 *  - `codec`   — encode/decode (image/font transforms).
 *  - `compute` — generic pure computation with no special host role. */
export type WasmPurpose = "layout" | "codec" | "compute";

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
}
