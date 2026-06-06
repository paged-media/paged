// The paged.draw tool catalog — namespaced under the manifest id,
// joining the rail's existing "pen" flyout slot semantics (group =
// slot). Registered through `contributeTool` so each entry carries
// its activation command + text-suppressed shortcut (the host only
// auto-wires shortcuts for startup tools — BREAKAGE_LOG B-15).

import type { CursorSpec, ToolContribution } from "@paged-media/plugin-api";

import { createAnchorEditHandler } from "./handlers/anchors";
import { createPenHandler } from "./handlers/pen";

const CROSS: CursorSpec = { kind: "css", token: "crosshair" };

export const DRAW_TOOLS: ToolContribution[] = [
  {
    id: "media.paged.draw.tool.pen",
    title: "Pen",
    icon: "tool-pen",
    shortcut: "p",
    group: "pen",
    section: "drawType",
    order: 0,
    isGroupDefault: true,
    cursor: CROSS,
    gesture: createPenHandler,
  },
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
