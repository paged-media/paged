// The paged.draw tool catalog — namespaced under the manifest id,
// joining the rail's existing "pen" flyout slot (group = slot).
// Division of labor (editor W2.5): the PEN itself is a built-in
// core-document tool (group default, authors NEW paths); this bundle
// contributes the three anchor-EDITING companions in the same slot.
// Registered through `contributeTool` so each entry carries its
// activation command + text-suppressed shortcut (the host only
// auto-wires shortcuts for startup tools — BREAKAGE_LOG B-15).
//
// B-17: the tool list is a FACTORY over the `BundleHost` — each
// gesture handler closes over `host` and reaches the engine through
// the `host.*` facades only (no raw spine). `activate(host)` calls
// `drawTools(host)`; the static `DRAW_TOOL_IDS` (just the ids, no
// host) stays available for the edit context's tool-set.

import type {
  BundleHost,
  CursorSpec,
  ToolContribution,
} from "@paged-media/plugin-api";

import { createAnchorEditHandler } from "./handlers/anchors";

const CROSS: CursorSpec = { kind: "css", token: "crosshair" };

/** The anchor-editing tool ids, in rail order — exported host-free so
 *  the edit context can name its tool-set without a host (B-17). */
export const DRAW_TOOL_IDS = [
  "media.paged.draw.tool.addAnchor",
  "media.paged.draw.tool.deleteAnchor",
  "media.paged.draw.tool.convertAnchor",
] as const;

/** Build the three anchor-editing tools bound to `host` — each
 *  gesture handler reaches the engine through the facades only (B-17).
 *  `activate(host)` iterates this and contributes each. */
export function drawTools(host: BundleHost): ToolContribution[] {
  return [
    {
      id: "media.paged.draw.tool.addAnchor",
      title: "Add Anchor Point",
      icon: "tool-addAnchor",
      shortcut: "=",
      group: "pen",
      section: "drawType",
      order: 1,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("add", host),
    },
    {
      id: "media.paged.draw.tool.deleteAnchor",
      title: "Delete Anchor Point",
      icon: "tool-deleteAnchor",
      shortcut: "-",
      group: "pen",
      section: "drawType",
      order: 2,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("delete", host),
    },
    {
      id: "media.paged.draw.tool.convertAnchor",
      title: "Convert Direction Point",
      icon: "tool-convertAnchor",
      shortcut: "shift+c",
      group: "pen",
      section: "drawType",
      order: 3,
      cursor: CROSS,
      gesture: () => createAnchorEditHandler("convert", host),
    },
  ];
}
