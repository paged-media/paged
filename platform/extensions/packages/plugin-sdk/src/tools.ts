// contributeTool — register a tool through the contract surface.
//
// Since the B-15 host-side fix (2026-06-06) the HOST derives the
// activation command (`paged.tool.activate.<id>`) and the
// text-suppressed single-key shortcut from the registry for EVERY
// registration path — this helper no longer wires them itself (doing
// so again would double-bind the key). It remains the recommended
// door: it is where future per-tool capability stamping attaches,
// and bundle code stays unchanged when that lands.

import type {
  BundleHost,
  Disposable,
  ToolContribution,
} from "@paged-media/plugin-api";

export function contributeTool(
  host: BundleHost,
  tool: ToolContribution,
): Disposable {
  return host.contribute.tool(tool);
}
