// The bundle lifecycle — the single seam that makes a plugin an
// out-of-repo artifact. In v0 the host calls `activate` in-process
// (the editor app, instead of inlining contributions); the end state
// fulfills the SAME interface across a worker/isolate RPC boundary,
// so bundle source never changes when isolation lands.

import type { PagedEditor, ShellRegistries } from "@paged-media/shell";

import type { PluginManifest } from "./manifest";

/**
 * What the host hands a bundle at activation. This IS the v0
 * capability surface: the shell registries (tool / panel / command /
 * keybinding / overlay / mode) and the editor handle (client,
 * selection, camera, overlay signals).
 *
 * Invariant (inherited from the GestureHandler contract): bundles
 * MUTATE only through `getEditor().client.mutate(Mutation)` or the
 * worker gesture channel — never by reaching into model state.
 */
export interface BundleHost {
  registries: ShellRegistries;
  /** Resolve the live editor handle at call time (mirrors the
   *  command registry's thunk — avoids stale-closure drift). */
  getEditor(): PagedEditor;
}

/** Returned by `activate`; `dispose()` must unregister every
 *  contribution the bundle made. The host's honesty smoke test:
 *  activate → dispose leaves the shell exactly as it found it. */
export interface BundleHandle {
  dispose(): void;
}

/** A loadable plugin bundle: serializable identity + the activation
 *  entry point. `defineBundle()` in `@paged-media/plugin-sdk` is the
 *  ergonomic constructor. */
export interface PagedBundle {
  manifest: PluginManifest;
  activate(host: BundleHost): BundleHandle;
}
