// @paged-media/plugin-api — the draft plugin contract (API v0).
//
// HARD RULE: this package is TYPE-ONLY. Every export is `export
// type`; nothing here exists at runtime, so consuming a bundle never
// drags host code (React, the wasm loader) into its module graph.
// Bundles take values (registries, client) from `BundleHost` at
// activation — types from here, values from the host.
//
// During incubation the editor is the source of truth and this
// package is a curated façade over `@paged-media/shell` +
// `@paged-media/client` (pnpm `link:` sibling deps). At API-v1
// freeze the direction flips: the façade becomes the contract, the
// host implements it, and publishing starts (Decision B). What's IN
// the façade is decided by what paged.draw needed — gaps live in
// plugin-draw/BREAKAGE_LOG.md.

export type {
  PluginId,
  PluginManifest,
  PluginCapabilities,
  PluginContributions,
} from "./manifest";

export type { BundleHost, BundleHandle, PagedBundle } from "./bundle";

export type * from "./contributions";
export type * from "./mutations";
