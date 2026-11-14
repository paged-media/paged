/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Hover preselection (the interaction specification's §14.2,
// `UXI-OVR-006`, `UXI-OVR-009`; editor ADR 235, amended by IC6): with a
// Selection tool in hand and no press under way, the item a click would
// select is outlined — thinner and lighter than the selection, with its
// type named beside it — so the user sees what the click will take before
// taking it (the outermost group at the top level, the member inside an
// entered group, the leaf with Direct Selection). Hovering never changes
// the selection. A locked item says so in its label.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useStrings } from "@paged-media/strings";

import type { ElementGeometryItem, ElementId } from "@paged-media/client";

import { useInteractionCoordinator } from "../interaction/coordinator";
import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { CANVAS_POINTER } from "../state/canvas-pointer";
import { useScoped } from "../state/editor-scope";
import { useSelection } from "../state/selection-context";
import {
  DIRECT_SELECT_TOOL_ID,
  SELECT_TOOL_ID,
  useOptionalTool,
} from "../state/tool-context";
import { applyAffine } from "./affine";
import { isLockedEntries } from "../state/locked";
import { HOVER } from "../chrome/messages";

interface Hover {
  key: string;
  geometry: ElementGeometryItem;
  kind: string;
  locked: boolean;
}

const keyOf = (id: ElementId) =>
  `${id.kind}:${String((id as { id?: unknown }).id)}`;

function HoverPreselectRender(props: OverlayProps) {
  const strings = useStrings();
  const client = useOptionalCanvasClient();
  const pointerStore = useScoped(CANVAS_POINTER);
  const pointer = useSyncExternalStore(
    pointerStore.subscribe,
    pointerStore.get,
    pointerStore.get,
  );
  const interactions = useInteractionCoordinator();
  const session = useSyncExternalStore(
    interactions.subscribe,
    interactions.snapshot,
    interactions.snapshot,
  );
  const { elementSelection, activeGroup } = useSelection();
  const tool = useOptionalTool();
  const effective = tool?.effectiveTool ?? SELECT_TOOL_ID;
  const directSelect = effective === DIRECT_SELECT_TOOL_ID;
  const selecting = effective === SELECT_TOOL_ID || directSelect;
  const [hover, setHover] = useState<Hover | null>(null);
  // One hit test at a time; the latest pointer waits for it (`retry`
  // asks again once the answer is in, if the pointer moved meanwhile).
  const busy = useRef(false);
  const [retry, setRetry] = useState(0);

  const idle = selecting && session.active === null;
  const at = idle && pointer?.pageId && pointer.pagePoint ? pointer : null;

  useEffect(() => {
    // Off the pages, or not idle: nothing is asked, and nothing is drawn
    // (the render checks `at`).
    if (!client || !at || !at.pageId || !at.pagePoint) return;
    if (busy.current) return;
    busy.current = true;
    const pageId = at.pageId;
    const docPoint: [number, number] = [at.pagePoint[0], at.pagePoint[1]];
    void (async () => {
      const reply = await client.send({
        kind: "hitTest",
        payload: { pageId, docPoint, filter: "any" },
      });
      const element = reply.kind === "hitResult" ? reply.payload.element : null;
      if (!element || reply.kind !== "hitResult") return null;
      const chain = reply.payload.groupChain ?? [];
      // What a click here selects (canvas-panel's `onHit`).
      const target: ElementId =
        directSelect || (activeGroup !== null && chain.includes(activeGroup))
          ? element
          : chain.length > 0
            ? ({ kind: "group", id: chain[0] } as ElementId)
            : element;
      const [geometry] = await client.elementGeometry([target]);
      if (!geometry) return null;
      const props = await client.elementProperties(target).catch(() => null);
      return {
        key: keyOf(target),
        geometry,
        kind: target.kind,
        locked: props ? isLockedEntries(props.entries) : false,
      } satisfies Hover;
    })()
      .catch(() => null)
      .then((next) => {
        busy.current = false;
        // The pointer moved on while the answer was out: ask again there.
        if (pointerStore.get() !== at) {
          setRetry((n) => n + 1);
          return;
        }
        setHover(next);
      });
  }, [client, at, activeGroup, directSelect, pointerStore, retry]);

  if (!at || !hover) return null;
  if (elementSelection.some((id) => keyOf(id) === hover.key)) return null;
  const g = hover.geometry;
  const pr = g.pageId ? props.pageRects.get(g.pageId) : undefined;
  if (!pr) return null;
  const [top, left, bottom, right] = g.bounds;
  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ] as const;
  const pts = corners.map(([x, y]) => applyAffine(g.itemTransform, x, y));
  const points = pts.map(([x, y]) => `${pr.x + x},${pr.y + y}`).join(" ");
  const scale = props.camera.scale > 0 ? props.camera.scale : 1;
  const [lx, ly] = pts.reduce(
    (best, p) =>
      p[1] < best[1] || (p[1] === best[1] && p[0] < best[0]) ? p : best,
    pts[0]!,
  );
  const label = hover.locked
    ? strings.t(HOVER.locked, { kind: kindLabel(strings, hover.kind) })
    : kindLabel(strings, hover.kind);
  return (
    <g
      data-hover-preselect={hover.key}
      data-hover-locked={hover.locked ? "" : undefined}
      pointerEvents="none"
    >
      <polygon
        points={points}
        fill="none"
        stroke="var(--overlay-selection)"
        strokeOpacity={0.55}
        strokeWidth={1}
        strokeDasharray={hover.locked ? "3 2" : undefined}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={pr.x + lx}
        y={pr.y + ly - 4 / scale}
        fontSize={10 / scale}
        fill="var(--overlay-selection)"
        fillOpacity={0.8}
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {label}
      </text>
    </g>
  );
}

/** The type of an item, in words. */
function kindLabel(
  strings: ReturnType<typeof useStrings>,
  kind: string,
): string {
  switch (kind) {
    case "rectangle":
      return strings.t(HOVER.rectangle);
    case "oval":
      return strings.t(HOVER.oval);
    case "polygon":
      return strings.t(HOVER.polygon);
    case "graphicLine":
      return strings.t(HOVER.line);
    case "textFrame":
      return strings.t(HOVER.textFrame);
    case "group":
      return strings.t(HOVER.group);
    default:
      return strings.t(HOVER.item);
  }
}

export const hoverPreselectContribution: OverlayContribution = {
  id: "paged.hover-preselect",
  render: HoverPreselectRender,
  // Above the page decorations, below the selection chrome (§14.1's
  // stacking: hover, then selection outlines).
  z: 150,
};
