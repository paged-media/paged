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

// @paged-media/plugin-sdk — the runtime layer over
// `@paged-media/plugin-api` (DESIGN.md §5). Owns the in-process
// BundleHost implementation, the loader, version negotiation, and
// the gesture kit; faster-moving than the API tier, but the same
// rule applies: helpers earn their place when a real bundle needs
// them.

export { defineBundle } from "./define-bundle";
export {
  createHeadlessHost,
  inMemoryWillSave,
  inMemoryToolSettings,
  type HarnessOptions,
  type HeadlessHost,
  type HeadlessHostHandle,
  type RecordedContribution,
} from "./harness";
export {
  loadHeadlessEngine,
  resolveCanvasWasm,
  readVendoredWireVersion,
  protocolFromVersion,
  CANVAS_WASM_PKG,
  type HeadlessCanvasWorker,
  type LoadedEngine,
  type LoadHeadlessEngineOptions,
} from "./wasm-loader";
export { DisposableStore, toDisposable } from "./disposables";
export { API_VERSION, satisfiesApiVersion } from "./version";
export {
  createBundleHost,
  createDataProviderRegistry,
  // ADR-023 phase A — the shared binding-provider registry the editor
  // builds ONCE and injects into every bundle host; its own panels
  // resolve through it (and fall through to core on a typed refusal).
  createBindingProviderRegistry,
  type BindingProviderBackend,
  type RegisteredBindingProvider,
  HOST_FEATURES,
  ASSET_BUDGETS,
  BLOB_BUDGETS,
  WORKER_BUDGETS,
  PluginApiNotImplemented,
  PluginCapabilityError,
  type BundleTrust,
  type BundleHostHandle,
  type ConsentBackend,
  type DataProviderBackend,
  type CreateBundleHostOptions,
  type DiagnosticsSink,
  type JournalSink,
  type BundleAssetProvider,
  type NativeDocumentBackend,
  type DocumentsBackend,
  type BlobStore,
  type ClipboardBackend,
  type TextCaretBackend,
  type WorkerBackend,
  type SpawnedWorker,
  type SecretStoreBackend,
  // K-10 — what a host app injects as `shell` (saveFile optional).
  type ShellBackend,
  type StorageBacking,
  // Protocol 66 batch — the save hook and tool-options store a host injects.
  type WillSaveBackend,
  type ToolSettingsBackend,
} from "./host-impl";
// ADR 323 — the object model: the address/selector grammar mirror (ADR
// 131), the value-type checks (ADR 132), the shared registry and its core
// seam over today's wire.
export {
  parseAddress,
  formatAddress,
  normalizeAddress,
  addressKindOf,
  parseSelector,
  toElementId,
  fromElementId,
  type ParsedSelector,
  type SelectorStep,
  type SelectorHead,
  type SelectorPredicate,
} from "./object-address";
export {
  checkValueType,
  checkSchemaRows,
  validateValue,
  coerceValue,
  parseLength,
  VALUE_TYPE_KINDS,
  applyDefaults,
  findRow,
  rowPathOf,
  ROW_PATH,
} from "./object-schema";
export {
  createObjectRegistry,
  escapeLabelValue,
  type ObjectRegistry,
  type ObjectModelRegistration,
  type CreateObjectRegistryOptions,
} from "./object-registry";
export {
  answerHostObjects,
  runScriptWithObjects,
  type HostObjectAnswer,
  type HostObjectCall,
  type ScriptRunResult,
  type ScriptSend,
} from "./script-bridge";
export {
  createCoreObjects,
  FRAME_KIND_WORDS,
  OBJECT_MODEL_PROTOCOL,
  type CoreCreatePlan,
  type CoreObjects,
  type CorePlan,
  type CreateCoreObjectsOptions,
} from "./core-objects";
export { codeOfEngineError } from "./core-objects-v71";
export {
  CORE_CATALOG_ROWS,
  CORE_PATHS,
  CORE_PATH_ALIASES,
  coreSchema71,
  normalizeCoreType,
  type CoreCatalogRow,
  type CorePathRow,
  type CorePathScope,
  type CoreRow71,
} from "./core-schema";
export { FALLBACK_WIDGETS } from "./widgets-fallback";
export {
  createRecordableAssetSource,
  type RecordableAssetSource,
  type RecordedFontFaceRequest,
  type SeededFace,
} from "./asset-source-fake";
export { makeSchemaPanelComponent, resolveGate } from "./schema-panel";
export { loadBundle, type LoadedBundle } from "./load";
export {
  loadBundleWasm,
  WASM_BUDGETS,
  type LoadedBundleWasm,
  type LoadBundleWasmOptions,
  type BundleAssetSource,
} from "./wasm-bundle-loader";
export {
  beginPageDrag,
  endLocalFor,
  pxToPt,
  commitAndSelect,
  CLICK_DRAG_THRESHOLD_PX,
  type PageDrag,
} from "./gestures";
export { contributeTool } from "./tools";
export { contributePanel, contributeSchemaPanel } from "./panels";
export {
  isPropertyRow,
  propertyRow,
  propertyRows,
  propertyRowsOf,
  selectorKind,
  validatePanelSchema,
  type PanelSchemaIssue,
  type PropertyRowOptions,
  type ValidatePanelSchemaOptions,
} from "./panel-schema-check";
// §12.8 — list / struct values on property rows: edits lowered to `set`s.
export { applyValueEdit, defaultValueOf, editValue, planValueEdit } from "./value-edit";
export {
  publishObjectList,
  type ObjectListRow,
  type PublishObjectListOptions,
} from "./object-list";
export {
  contributeEditContext,
  contributeObjectType,
  contributeBindingProvider,
} from "./edit-context";
