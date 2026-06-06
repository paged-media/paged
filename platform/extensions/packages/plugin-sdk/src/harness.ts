// Headless test harness — RESERVED, not yet implemented.
//
// The paper (§12.4) puts the conformance harness in the SDK tier: a
// headless host that can activate a bundle, replay Operations
// against a real engine, and assert on the resulting IDML — without
// a browser session. Building it needs the engine wasm consumable
// outside the editor app (Decision B or a dedicated node loader),
// so it is tracked in plugin-draw/BREAKAGE_LOG.md rather than
// stubbed with a fake host here: a mock host would let bundles pass
// against fiction, which is the exact failure mode the harness
// exists to prevent.

import type { BundleHost } from "@paged-media/plugin-api";

export interface HarnessOptions {
  /** IDML bytes to load into the headless document. */
  idml?: Uint8Array;
}

/** Not implemented in API v0 — see module comment. */
export function createHeadlessHost(_options?: HarnessOptions): BundleHost {
  throw new Error(
    "@paged-media/plugin-sdk: the headless harness is not implemented yet " +
      "(tracked in plugin-draw/BREAKAGE_LOG.md). Run bundles inside the " +
      "editor app, or unit-test their machines (pure, host-free) instead.",
  );
}
