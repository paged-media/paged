// The bundle lifecycle — the single seam that makes a plugin an
// out-of-repo artifact. In v0 the host calls `activate` in-process
// (via `@paged-media/plugin-sdk`'s `loadBundle`); the end state
// fulfills the SAME `BundleHost` interface across a worker/isolate
// RPC boundary, so bundle source never changes when isolation lands.

import type { BundleHost, Disposable } from "./host";
import type { PluginManifest } from "./manifest";

/** Returned by `activate`. The host tracks every facade registration
 *  independently, so this handle only needs to release what the
 *  bundle allocated OUTSIDE the host (timers, caches) — returning a
 *  no-op disposer is legitimate. */
export type BundleHandle = Disposable;

/** A loadable plugin bundle: serializable identity + the activation
 *  entry point. `defineBundle()` in `@paged-media/plugin-sdk` is the
 *  ergonomic constructor. */
export interface PagedBundle {
  manifest: PluginManifest;
  activate(host: BundleHost): BundleHandle;
}
