// The paged.draw bundle entry — D-milestone status: D3.
//
// Registration happens HERE, through the public contribution surface:
// the three anchor-editing tools (Add/Delete/Convert — the Pen itself
// is a built-in core-document tool per the W2.5 division), each with
// its activation command and text-suppressed shortcut via
// `contributeTool`. The host tracks every registration; removing the
// editor's `loadBundle` call removes draw cleanly — the
// platform-honesty smoke test.
//
// Panels stay design prototypes (`panels/*.panel.json`, BREAKAGE_LOG
// B-01); the edit-context claim in the manifest stays declarative
// until the shell grows the registry (B-02).

import type { BundleHandle, BundleHost } from "@paged-media/plugin-api";
import { contributeTool } from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";

import { DRAW_TOOLS } from "./tools";

export function activate(host: BundleHost): BundleHandle {
  for (const tool of DRAW_TOOLS) {
    contributeTool(host, tool);
  }
  host.log.info(
    `activated — ${DRAW_TOOLS.length} tools (apiVersion ${manifest.apiVersion})`,
  );
  // Host-tracked registrations tear down structurally; nothing
  // allocated outside the facades.
  return { dispose() {} };
}

export { manifest };
