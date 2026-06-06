// @paged-media/plugin-api — the plugin contract (API v0.2).
//
// HARD RULE: this package is TYPE-ONLY. Every export is `export
// type`; nothing here exists at runtime, so consuming a bundle never
// drags host code (React, the wasm loader) into its module graph.
// Bundles take values (facades, helpers) from `BundleHost` at
// activation — types from here, values from the host.
//
// Since the M1.1(a) vendoring pass (2026-06-06) this package OWNS
// its types: hand-written editor-contract shapes in ./editor, the
// engine wire types VENDORED in ./wire.d.ts (synced from the
// editor's generated tsify output via scripts/sync-wire.mjs). The
// EDITOR asserts compatibility against this contract through its
// dev link (apps/canvas/src/plugin-api-compat.ts) — drift fails the
// editor's typecheck, never a consumer's build. What's IN the
// façade is decided by what paged.draw / paged.web needed — gaps
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
