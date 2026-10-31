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
// it uses stops there; one it declines bubbles on to the canvas, which pans
// or zooms. Keys typed while focus is inside are the surface's
// (key-ownership: FRAME_SURFACE_ATTR).
//
// Editor ADR 283 — FULL SCREEN: on the surface's request the host pushes a
// chrome override (only the canvas region and the context menu stay; no
// title bar, rulers or thumbnails) and the surface fills the work area,
// upright and unscaled, its bar along the top. Esc or the bar's button
// asks for the frame again.

import {
  useEffect,
  useState,
  type CSSProperties,
  type RefObject,
  type SyntheticEvent,
} from "react";

import type { Camera, ElementGeometryItem, PageId } from "@paged-media/client";
import {
  FRAME_SURFACE_ATTR,
  useChromeOverride,
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
  /** The canvas host's size, CSS px (the full-screen work area). */
  hostSize: { width: number; height: number };
  /** Editor ADR 311 — the tool in hand works on the frame itself (Free
   *  Transform): the surface stays on screen but lets presses through to
   *  the canvas, so the tool reaches the frame under it. */
  passThrough?: boolean;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** What full screen leaves of the chrome. */
const FULLSCREEN_OVERRIDE = {
  keep: ["canvas", "context-menu"] as const,
  canvas: { titleBar: false, rulers: false, thumbnails: false },
};

/** Screen room the bar needs above the frame before it flips below. */
const BAR_ROOM_PX = 52;
const BAR_GAP_PX = 6;
/** Height reserved for the bar along the top in full screen. */
const FULLSCREEN_BAR_PX = 44;

export function FrameSurfaceHost(props: FrameSurfaceHostProps) {
  const registries = useRegistries();
  const surfaces = useRegistryView(registries.frameSurfaces);
  const stack = useOptionalEditContextStack();
  const active = stack?.active ?? null;
  const pushOverride = useChromeOverride();
  // Full screen belongs to one entered frame; entering another starts in
  // the frame presentation again.
  const activeKey = active
    ? `${active.type}:${active.scopeRoot.kind}:${String(active.scopeRoot.id)}`
    : null;
  const [fullscreenOf, setFullscreenOf] = useState<string | null>(null);
  const fullscreen = activeKey !== null && fullscreenOf === activeKey;
  useEffect(() => {
    if (!fullscreen) return;
    return pushOverride({
      keep: [...FULLSCREEN_OVERRIDE.keep],
      canvas: FULLSCREEN_OVERRIDE.canvas,
    });
  }, [fullscreen, pushOverride]);

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

  const [top, left, bottom, right] = geom.bounds;
  const frameBoxPt = {
    widthPt: Math.max(right - left, 0),
    heightPt: Math.max(bottom - top, 0),
  };
  // On the frame: the content-box transform. Full screen: upright, one CSS
  // pixel a point, below the bar.
  const m: [number, number, number, number, number, number] = fullscreen
    ? [1, 0, 0, 1, 0, FULLSCREEN_BAR_PX]
    : contentToHostMatrix(props.camera, page, geom);
  const inverse = invert(m);
  const widthPt = fullscreen
    ? Math.max(props.hostSize.width, 1)
    : frameBoxPt.widthPt;
  const heightPt = fullscreen
    ? Math.max(props.hostSize.height - FULLSCREEN_BAR_PX, 1)
    : frameBoxPt.heightPt;
  // Screen pixels per content point: the camera scale times the frame's own
  // scale (the square root of its linear part's determinant).
  const pxPerPt = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const elementId =
    typeof active.scopeRoot.id === "string" ? active.scopeRoot.id : "";
  const presentation: "frame" | "fullscreen" = fullscreen
    ? "fullscreen"
    : "frame";

  const surfaceProps = {
    elementId,
    widthPt,
    heightPt,
    pxPerPt,
    presentation,
    frameBoxPt,
    toContentPt: (
      clientX: number,
      clientY: number,
    ): [number, number] | null => {
      const host = props.hostRef.current;
      if (!host || !inverse) return null;
      const r = host.getBoundingClientRect();
      const x = clientX - r.left;
      const y = clientY - r.top;
      const cx = inverse[0] * x + inverse[2] * y + inverse[4];
      const cy = inverse[1] * x + inverse[3] * y + inverse[5];
      if (cx < 0 || cy < 0 || cx > widthPt || cy > heightPt) return null;
      return [cx, cy];
    },
    requestPresentation: (p: "frame" | "fullscreen") => {
      setFullscreenOf(p === "fullscreen" ? activeKey : null);
    },
    exit: ({ commit }: { commit: boolean }) => {
      setFullscreenOf(null);
      if (commit) stack.commit();
      else stack.cancel();
    },
  };

  const style: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: widthPt,
    height: heightPt,
    transformOrigin: "0 0",
    transform: `matrix(${m.join(",")})`,
    overflow: "hidden",
    pointerEvents: props.passThrough && !fullscreen ? "none" : "auto",
    // Above the canvas and the overlay SVG, below the HUD.
    zIndex: fullscreen ? 4 : 2,
    background: fullscreen ? "var(--pg-bg, #ffffff)" : undefined,
  };

  // The bar: above the frame's screen box (below it when the top edge is
  // too close to the viewport's), or along the top in full screen.
  const corners = [
    [0, 0],
    [widthPt, 0],
    [0, heightPt],
    [widthPt, heightPt],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const above = minY > BAR_ROOM_PX;
  const barStyle: CSSProperties = fullscreen
    ? {
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: FULLSCREEN_BAR_PX,
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        boxSizing: "border-box",
        pointerEvents: "auto",
        zIndex: 5,
        background: "var(--pg-bg, #ffffff)",
      }
    : {
        position: "absolute",
        left: Math.max(4, minX),
        top: above ? minY - BAR_GAP_PX : maxY + BAR_GAP_PX,
        transform: above ? "translateY(-100%)" : undefined,
        pointerEvents: "auto",
        zIndex: 3,
      };
  const Render = surface.render;
  const Bar = surface.bar;
  return (
    <>
      {Bar ? (
        <div
          {...{ [FRAME_SURFACE_ATTR]: active.type }}
          data-testid="frame-surface-bar"
          data-presentation={presentation}
          style={barStyle}
          onPointerDown={stop}
          onPointerMove={stop}
          onPointerUp={stop}
          onDoubleClick={stop}
          onContextMenu={stop}
          onWheel={stop}
        >
          <Bar {...surfaceProps} />
        </div>
      ) : null}
      <div
        {...{ [FRAME_SURFACE_ATTR]: active.type }}
        data-testid="frame-surface"
        data-presentation={presentation}
        style={style}
        onPointerDown={stop}
        onPointerMove={stop}
        onPointerUp={stop}
        onPointerCancel={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
      >
        <Render {...surfaceProps} />
      </div>
    </>
  );
}
