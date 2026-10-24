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

// WP4.6 — isolation dimming (Illustrator's isolation mode). While an edit
// context is entered (vectorGraphic, rasterImage, wordDocument, …) or a
// group is entered (Track L's `activeGroup`), everything OUTSIDE the
// scope root is veiled: a path covering the whole document with the scope
// root's outline cut out (even-odd), filled with `--overlay-isolation-dim`
// (white at 50 % in the light theme, as Illustrator draws it; a dark veil
// in the dark theme). The breadcrumb names the scope; this shows it.
//
// The veil is display only: it takes no pointer events, so a click
// outside still reaches the canvas, which leaves the scope as before.

import { useEffect, useState } from "react";

import type { ElementGeometryItem, ElementId } from "@paged-media/client";

import type { OverlayContribution, OverlayProps } from "../registries/overlay";
import { useOptionalCanvasClient } from "../state/canvas-client-context";
import { useOptionalEditContextStack } from "../state/edit-context-stack";
import { useSelection } from "../state/selection-context";

import { applyAffine } from "./affine";

/** Far enough past any document that the veil covers the pasteboard. */
const FAR = 1_000_000;

/** The element whose outside is dimmed: the active edit context's scope
 *  root, else the entered group, else nothing. */
export function isolationScopeRoot(
  editContextRoot: ElementId | null | undefined,
  activeGroup: string | null,
): ElementId | null {
  if (editContextRoot) return editContextRoot;
  if (activeGroup) return { kind: "group", id: activeGroup } as ElementId;
  return null;
}

/** The scope root's outline in document space (its bounds through its
 *  transform, offset by its page), or null when it sits on no page. */
export function isolationOutline(
  g: ElementGeometryItem,
  pageRects: OverlayProps["pageRects"],
): Array<[number, number]> | null {
  const pr = g.pageId ? pageRects.get(g.pageId) : undefined;
  if (!pr) return null;
  const [top, left, bottom, right] = g.bounds;
  const corners: Array<[number, number]> = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  return corners
    .map(([x, y]) => applyAffine(g.itemTransform, x, y))
    .map(([x, y]) => [pr.x + x, pr.y + y]);
}

/** The veil's path: the far rectangle with `hole` cut out (even-odd). */
export function isolationVeilPath(hole: ReadonlyArray<[number, number]>) {
  const outer = `M${-FAR},${-FAR}H${FAR}V${FAR}H${-FAR}Z`;
  const inner = `M${hole.map(([x, y]) => `${x},${y}`).join("L")}Z`;
  return `${outer} ${inner}`;
}

const keyOf = (id: ElementId | null) =>
  id ? `${id.kind}:${String((id as { id?: unknown }).id)}` : "";

function IsolationDimRender(props: OverlayProps) {
  const client = useOptionalCanvasClient();
  const stack = useOptionalEditContextStack();
  const { activeGroup } = useSelection();
  // The frame's scope root is held in the stack's state, so it keeps its
  // identity between renders; the group is a string.
  const contextRoot = stack?.active?.scopeRoot ?? null;
  const root = isolationScopeRoot(contextRoot, activeGroup);
  const key = keyOf(root);
  const [geometry, setGeometry] = useState<{
    key: string;
    item: ElementGeometryItem;
  } | null>(null);

  // The root's geometry, again after every edit (the scope's own content
  // may move it, and undo may put it back).
  useEffect(() => {
    const target = isolationScopeRoot(contextRoot, activeGroup);
    if (!client || !target) return;
    const at = keyOf(target);
    let live = true;
    const fetch = () => {
      void client
        .elementGeometry([target])
        .then((items) => {
          if (live && items[0]) setGeometry({ key: at, item: items[0] });
        })
        .catch(() => {});
    };
    fetch();
    const off = client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "gestureCommitted"
      ) {
        fetch();
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [client, contextRoot, activeGroup]);

  if (!root || !geometry || geometry.key !== key) return null;
  const hole = isolationOutline(geometry.item, props.pageRects);
  if (!hole) return null;
  return (
    <path
      d={isolationVeilPath(hole)}
      fillRule="evenodd"
      style={{ fill: "var(--overlay-isolation-dim)" }}
      pointerEvents="none"
      data-isolation-dim={key}
    />
  );
}

/** Over the page decorations and guides, below the selection chrome
 *  (z 200), so the scope's own handles stay crisp. */
export const isolationDimContribution: OverlayContribution = {
  id: "paged.isolationDim",
  z: 90,
  render: IsolationDimRender,
};
