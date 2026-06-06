// @paged-media/plugin-api — the plugin contract (API v0.2).
//
// HARD RULE: this package is TYPE-ONLY. Every export is `export
// type`; nothing here exists at runtime, so consuming a bundle never
// drags host code (React, the wasm loader) into its module graph.
// Bundles take values (facades, helpers) from `BundleHost` at
// activation — types from here, values from the host.
//
// During incubation the editor is the source of truth and this
// package is a curated façade over `@paged-media/shell` +
// `@paged-media/client` (pnpm `link:` sibling deps). At API-v1
// freeze the direction flips: the façade becomes the contract, the
// host implements it, and publishing starts (Decision B). What's IN
// the façade is decided by what paged.draw / paged.web needed — gaps
// live in the consumers' BREAKAGE_LOG.md files. Design rationale:
// DESIGN.md at the repo root.

export type {
  PluginId,
  PluginManifest,
  PluginCapabilities,
  PluginContributions,
} from "./manifest";

export type { BundleHandle, PagedBundle } from "./bundle";

export type {
  BundleHost,
  ContributionSurface,
  DocumentSurface,
  SelectionSurface,
  ViewportSurface,
  OverlaySurface,
  ShellSurface,
  StorageSurface,
  DiagnosticsSurface,
  Diagnostic,
  DocumentChangeEvent,
  MutationOutcome,
  Disposable,
  PluginLogger,
  EditContextDescriptor,
  ObjectTypeDescriptor,
} from "./host";

export type * from "./contributions";
export type * from "./mutations";
