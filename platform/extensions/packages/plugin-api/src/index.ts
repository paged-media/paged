/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

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
  NetworkCapability,
  DataProvidersCapability,
  StorageCapability,
  WasmArtifact,
  WasmPurpose,
  WorkersCapability,
  SecretsCapability,
  GpuCapability,
} from "./manifest";

export type { BundleHandle, PagedBundle } from "./bundle";

export type {
  BundleHost,
  ContributionSurface,
  SceneLayerSurface,
  SceneImage,
  SceneImageTile,
  SceneImageSubmitOptions,
  WillSaveEvent,
  ToolsSurface,
  ToolSettingValue,
  ImagesSurface,
  ImageResourceClaimOptions,
  TileBytes,
  WorkersSurface,
  BundleWorker,
  SpawnWorkerOptions,
  SecretsSurface,
  SecretMaterial,
  DocumentSurface,
  MutateWithBytesOptions,
  SelectionSurface,
  ViewportSurface,
  TextSurface,
  TextMetrics,
  TextCaret,
  FrameChainLink,
  // B-22 (protocol v57) — the planar-region read door's result shapes.
  PlanarFace,
  PlanarRegionsResult,
  StoryContent,
  ParagraphContent,
  RunContent,
  OverlaySurface,
  ShellSurface,
  FilePickerOptions,
  PickedFile,
  // K-10 — the save-file door's payload (the inverse of PickedFile).
  SaveFileOptions,
  StorageSurface,
  BlobSurface,
  BlobUsage,
  PartsSurface,
  NativeDocumentSurface,
  NetworkSurface,
  ConsentResult,
  DataProvidersSurface,
  DataProviderRegistration,
  DataProviderHandle,
  DataProviderInfo,
  DataProviderSnapshot,
  ProviderSchema,
  ProviderField,
  ProviderRecordSet,
  DiagnosticsSurface,
  JournalSurface,
  JournalRecord,
  BindingsSurface,
  Diagnostic,
  DocumentChangeEvent,
  MutationOutcome,
  Disposable,
  PluginLogger,
  EditContextContribution,
  ObjectTypeContribution,
  EditContextCandidate,
  EnteredEditContext,
  ContentPointerEvent,
  EditContextDescriptor,
  ObjectTypeDescriptor,
  PluginMetadataEnvelope,
  ObjectTypeBaker,
  BakeContext,
  MenuContribution,
} from "./host";

export type {
  PanelSchema,
  PanelSchemaSection,
  PanelSchemaRow,
  SchemaPanelContribution,
  SchemaPanelRenderer,
  SchemaPanelRendererProps,
  WidgetValueBinding,
  BindingRef,
  SchemaGate,
  // Schema v1.1 — the list/collection tier (B-01 list widget + G3
  // applyEntity write). Additive; see DESIGN.md §12.6.
  WidgetCollectionBinding,
  SchemaRowAction,
  SchemaListAction,
  SchemaListSpec,
} from "./panel-schema";

export type {
  WidgetSurface,
  ColorPickerProps,
  CodeEditorProps,
  CodeEditorDiagnostic,
  CodeEditorLanguage,
} from "./widgets";

// ADR-023 phase A — BINDING PROVIDERS: one host-owned panel, and while
// an edit context is active the owning plugin resolves what that panel
// binds to (paths / collections / structural ops; reads + writes).
export type {
  BindingTarget,
  BindingPropertyRequest,
  BindingPropertyWrite,
  BindingCollectionRequest,
  BindingRead,
  BindingResolved,
  BindingDecline,
  BindingWrite,
  BindingCollection,
  BindingOp,
  BindingProvider,
  BindingProviderScope,
  BindingProviderHandle,
  // What the HOST reads back (the editor's shared panel, phase C).
  BindingReadResult,
  BindingWriteResult,
  BindingCollectionResult,
  ActiveBindingProvider,
} from "./binding-provider";

export type {
  AssetSurface,
  AssetKind,
  FontFaceAsset,
  FontFaceFormat,
} from "./assets";

// C-6 (I-06) — the renderer resource-provider wire shape, re-exported
// so the editor channel + the SDK adapter share one tile type.
export type { ProviderTileWire } from "./wire";

// One element a mutation minted (`MutationOutcome.minted`): the element,
// the `bindCreated` handle that named it, and the story minted with it.
export type { MintedElement } from "./wire";

export type {
  ClipboardSurface,
  ClipboardPayload,
  TabularClipboard,
} from "./clipboard";

export type * from "./contributions";
export type * from "./mutations";
