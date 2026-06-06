// The paged.draw tool catalog — namespaced under the manifest id,
// joining the rail's existing "pen" flyout slot (group = slot).
// Division of labor (editor W2.5): the PEN itself is a built-in
// core-document tool (group default, authors NEW paths); this bundle
// contributes the three anchor-EDITING companions in the same slot.
// Registered through `contributeTool` so each entry carries its
// activation command + text-suppressed shortcut (the host only
// auto-wires shortcuts for startup tools — BREAKAGE_LOG B-15).

import type { CursorSpec, ToolContribution } from "@paged-media/plugin-api";

import { createAnchorEditHandler } from "./handlers/anchors";

const CROSS: CursorSpec = { kind: "css", token: "crosshair" };

export const DRAW_TOOLS: ToolContribution[] = [
  {
    id: "media.paged.draw.tool.addAnchor",
    title: "Add Anchor Point",
    icon: "tool-addAnchor",
    shortcut: "=",
    group: "pen",
    section: "drawType",
    order: 1,
    cursor: CROSS,
    gesture: () => createAnchorEditHandler("add"),
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
    gesture: () => createAnchorEditHandler("delete"),
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
    gesture: () => createAnchorEditHandler("convert"),
  },
];
