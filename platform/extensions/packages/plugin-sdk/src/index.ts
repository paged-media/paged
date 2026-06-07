// @paged-media/plugin-sdk — the runtime layer over
// `@paged-media/plugin-api` (DESIGN.md §5). Owns the in-process
// BundleHost implementation, the loader, version negotiation, and
// the gesture kit; faster-moving than the API tier, but the same
// rule applies: helpers earn their place when a real bundle needs
// them.

export { defineBundle } from "./define-bundle";
export {
  createHeadlessHost,
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
  HOST_FEATURES,
  PluginApiNotImplemented,
  PluginCapabilityError,
  type BundleHostHandle,
  type CreateBundleHostOptions,
  type DiagnosticsSink,
  type StorageBacking,
} from "./host-impl";
export { FALLBACK_WIDGETS } from "./widgets-fallback";
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
