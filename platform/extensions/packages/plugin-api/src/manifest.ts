// The plugin manifest — the serializable identity + contribution
// declaration every bundle ships as `manifest.json`. Mirrors
// `manifest.schema.json` (the CLI validates against the schema; these
// types keep TS authors honest).
//
// API v0 status: the manifest is DECLARATIVE/ADVISORY. Capabilities
// are recorded but not yet enforced — enforcement attaches at the
// registries' `register()` / the client's `mutate()` chokepoints when
// the capability gate lands (third-party-beta scope, see
// thoughts/docs/paged/plugin-draw/reality-check.md §4).

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
  /** read-broad / write-scoped is the intended default. */
  document?: {
    read?: "broad" | "scoped";
    write?: "broad" | "scoped";
  };
  /** Render-pipeline surfaces the bundle uses. v0: `overlay` means
   *  the shared TS overlay signals (tool previews); `sceneLayer` and
   *  a host-side `hitTest` service are reserved for the P2 channel. */
  rendering?: Array<"sceneLayer" | "overlay" | "hitTest">;
  /** Edit-context content types the bundle claims (P0 shell work —
   *  reserved, not yet wired). */
  editContext?: string[];
  network?: boolean;
  clipboard?: "none" | "vector" | "full";
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
  /** Reserved for the P0 edit-context registry. */
  editContexts?: Array<{
    type: string;
    entry: "doubleClick" | "command";
  }>;
}
