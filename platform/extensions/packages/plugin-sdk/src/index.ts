// @paged-media/plugin-sdk — the runtime layer over
// `@paged-media/plugin-api` (DESIGN.md §5). Owns the in-process
// BundleHost implementation, the loader, version negotiation, and
// the gesture kit; faster-moving than the API tier, but the same
// rule applies: helpers earn their place when a real bundle needs
// them.

export { defineBundle } from "./define-bundle";
export { createHeadlessHost, type HarnessOptions } from "./harness";
export { DisposableStore, toDisposable } from "./disposables";
export { API_VERSION, satisfiesApiVersion } from "./version";
export {
  createBundleHost,
  HOST_FEATURES,
  PluginApiNotImplemented,
  type BundleHostHandle,
  type CreateBundleHostOptions,
  type StorageBacking,
} from "./host-impl";
export { loadBundle, type LoadedBundle } from "./load";
export {
  beginPageDrag,
  endLocalFor,
  pxToPt,
  commitAndSelect,
  CLICK_DRAG_THRESHOLD_PX,
  type PageDrag,
} from "./gestures";
export { contributeTool } from "./tools";
