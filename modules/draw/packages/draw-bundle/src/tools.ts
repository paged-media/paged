/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

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
import { createCurvatureHandler } from "./handlers/curvature";
import { createGradientAnnotatorHandler } from "./handlers/gradient-annotator";
import { createMeasureHandler } from "./handlers/measure";
import { createPencilHandler } from "./handlers/pencil";
import { createShapeBuilderHandler } from "./handlers/shape-builder";

const CROSS: CursorSpec = { kind: "css", token: "crosshair" };

/** The anchor-editing tool ids, in rail order — exported host-free so
 *  the edit context can name its tool-set without a host (B-17). */
export const DRAW_TOOL_IDS = [
  "media.paged.draw.tool.addAnchor",
  "media.paged.draw.tool.deleteAnchor",
  "media.paged.draw.tool.convertAnchor",
] as const;

/** Phase 4c — the pro toolset ids, in rail order (host-free, like
 *  DRAW_TOOL_IDS; the edit context keeps its anchor-editing set —
 *  these are document-level authoring/inspection tools). Phase 9 (Tier
 *  B) appends the Shape Builder gesture tool. */
export const PRO_TOOL_IDS = [
  "media.paged.draw.tool.curvature",
  "media.paged.draw.tool.pencil",
  "media.paged.draw.tool.gradientAnnotator",
  "media.paged.draw.tool.measure",
  "media.paged.draw.tool.shapeBuilder",
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
    // Phase 4c — the pro toolset. Curvature + Pencil AUTHOR new paths
    // (machine → one insertPath), so they join the pen flyout slot;
    // the gradient annotator + measure are inspection/steering tools
    // in their own slots.
    {
      id: "media.paged.draw.tool.curvature",
      title: "Curvature",
      icon: "tool-curvature",
      // shift+u — yields shift+p to the built-in Page tool (InDesign-canonical);
      // INV-REG-1 keeps every single-key tool shortcut unique across bundles.
      shortcut: "shift+u",
      group: "pen",
      section: "drawType",
      order: 4,
      cursor: CROSS,
      gesture: () => createCurvatureHandler(host),
    },
    {
      id: "media.paged.draw.tool.pencil",
      title: "Pencil",
      icon: "tool-pencil",
      shortcut: "shift+n",
      group: "pen",
      section: "drawType",
      order: 5,
      cursor: CROSS,
      gesture: () => createPencilHandler(host),
    },
    {
      id: "media.paged.draw.tool.gradientAnnotator",
      title: "Gradient Annotator",
      icon: "tool-gradient",
      // shift+a — yields shift+g to the built-in Gradient Feather tool
      // (InDesign-canonical); INV-REG-1 keeps tool shortcuts unique.
      shortcut: "shift+a",
      group: "gradientAnnotator",
      section: "transform",
      order: 1,
      cursor: CROSS,
      gesture: () => createGradientAnnotatorHandler(host),
    },
    {
      id: "media.paged.draw.tool.measure",
      title: "Measure",
      icon: "tool-measure",
      shortcut: "shift+m",
      group: "measure",
      section: "modNav",
      order: 1,
      cursor: CROSS,
      gesture: () => createMeasureHandler(host),
    },
    // Phase 9 (Tier B) — Shape Builder: a drag across overlapping shapes
    // unites them; Alt-drag subtracts. Composes over pathfinderBoolean;
    // the gesture decides the operand set + mode (handlers/shape-builder.ts).
    {
      id: "media.paged.draw.tool.shapeBuilder",
      title: "Shape Builder",
      icon: "tool-shapeBuilder",
      shortcut: "shift+b",
      group: "shapeBuilder",
      section: "drawType",
      order: 6,
      cursor: CROSS,
      gesture: () => createShapeBuilderHandler(host),
    },
  ];
}
