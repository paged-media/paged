// The paged.draw bundle entry — D-milestone status: D2.
//
// D2 (now): the editor still registers the draw tools through its
// own BUILT_IN_TOOLS catalog (under the built-in `paged.tool.*` ids),
// with thin handler shims over this repo's machines. `activate` is
// therefore an honest skeleton: it registers NOTHING yet and its
// handle disposes nothing — calling it is harmless and the contract
// is exercised end to end.
//
// D3 (next): registration moves here under the manifest-namespaced
// ids (`media.paged.draw.tool.pen`, …), the editor drops its inline
// entries, and removing this `activate` call removes draw cleanly —
// the platform-honesty smoke test. Blocked on: the editor exposing
// its page-drag/`pxToPt` shim helpers through the plugin surface
// (BREAKAGE_LOG.md entry B-11).

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";

import manifest from "../manifest.json";

export function activate(_host: BundleHost): BundleHandle {
  // D3: host.registries.tools.register({ id: `${manifest.id}.tool.pen`, … })
  // with gesture shims over @paged-media/draw-tools machines.
  return {
    dispose() {
      /* nothing registered yet — see module comment */
    },
  };
}

export { manifest };
