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

// Editor ADR 281 / extensions ADR 334 — the FRAME SURFACE host. While an
// edit context is active on a frame and its bundle registered a frame
// surface for that context, this mounts the bundle's component exactly over
// the frame's content box: a DOM element whose CSS transform is the camera,
// the page's place on the spread, the frame's ItemTransform and the
// content-box origin, so one CSS pixel inside it is one point of frame
// content. Pointer and context-menu events stop here (they belong to the
// surface, not the canvas's tools). A wheel is the surface's to stop: one
// it uses (the grid scrolled) stops there; one it declines (an edge, or
// Cmd/Ctrl-wheel) bubbles on to the canvas, which pans or zooms. Keys typed while focus is inside are the
// surface's (key-ownership: FRAME_SURFACE_ATTR).

import type { CSSProperties, RefObject, SyntheticEvent } from "react";

import type { Camera, ElementGeometryItem, PageId } from "@paged-media/client";
import {
  FRAME_SURFACE_ATTR,
  useOptionalEditContextStack,
  useRegistries,
  useRegistryView,
} from "@paged-media/shell";

import { contentToHostMatrix, invert } from "./frame-surface-math";
import type { PageRect } from "./layout";

export interface FrameSurfaceHostProps {
  camera: Camera;
  pageIds: ReadonlyArray<PageId>;
  pageRects: ReadonlyArray<PageRect>;
  elementGeometry: ReadonlyArray<ElementGeometryItem> | undefined;
  /** The canvas host the camera's pixels are relative to. */
  hostRef: RefObject<HTMLDivElement | null>;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function FrameSurfaceHost(props: FrameSurfaceHostProps) {
  const registries = useRegistries();
  const surfaces = useRegistryView(registries.frameSurfaces);
  const stack = useOptionalEditContextStack();
  const active = stack?.active ?? null;
  if (!active || !stack) return null;
  const surface = surfaces.get(active.type);
  if (!surface) return null;
  const rootKey = `${active.scopeRoot.kind}:${String(active.scopeRoot.id)}`;
  const geom = (props.elementGeometry ?? []).find(
    (g) => `${g.id.kind}:${String(g.id.id)}` === rootKey,
  );
  if (!geom || !geom.pageId) return null;
  const pageIndex = props.pageIds.indexOf(geom.pageId);
  const page = pageIndex >= 0 ? props.pageRects[pageIndex] : undefined;
  if (!page) return null;

  const m = contentToHostMatrix(props.camera, page, geom);
  const inverse = invert(m);
  const [top, left, bottom, right] = geom.bounds;
  const widthPt = Math.max(right - left, 0);
  const heightPt = Math.max(bottom - top, 0);
  // Screen pixels per content point: the camera scale times the frame's own
  // scale (the square root of its linear part's determinant).
  const pxPerPt = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const elementId =
    typeof active.scopeRoot.id === "string" ? active.scopeRoot.id : "";

  const style: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: widthPt,
    height: heightPt,
    transformOrigin: "0 0",
    transform: `matrix(${m.join(",")})`,
    overflow: "hidden",
    pointerEvents: "auto",
    // Above the canvas and the overlay SVG, below the HUD.
    zIndex: 2,
  };
  const Render = surface.render;
  return (
    <div
      {...{ [FRAME_SURFACE_ATTR]: active.type }}
      data-testid="frame-surface"
      style={style}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={stop}
      onContextMenu={stop}

    >
      <Render
        elementId={elementId}
        widthPt={widthPt}
        heightPt={heightPt}
        pxPerPt={pxPerPt}
        presentation="frame"
        toContentPt={(clientX, clientY) => {
          const host = props.hostRef.current;
          if (!host || !inverse) return null;
          const r = host.getBoundingClientRect();
          const x = clientX - r.left;
          const y = clientY - r.top;
          const cx = inverse[0] * x + inverse[2] * y + inverse[4];
          const cy = inverse[1] * x + inverse[3] * y + inverse[5];
          if (cx < 0 || cy < 0 || cx > widthPt || cy > heightPt) return null;
          return [cx, cy];
        }}
        requestPresentation={() => {
          // Full-screen lands with editor ADR 283; until then the host
          // keeps the frame presentation.
        }}
        exit={({ commit }) => {
          if (commit) stack.commit();
          else stack.cancel();
        }}
      />
    </div>
  );
}
