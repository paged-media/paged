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

// FREE TRANSFORM of a layer (Edit ▸ Free Transform; WP5.6 / I-36) — the
// host draws the box and does the gesture math (`host.transformBox`,
// extensions ADR 339: the same box as the host's Free Transform tool); this
// module only names the quad and applies the matrix it reports.
//
// The quad is the canvas extent of the active layer (the layer is a
// canvas-sized buffer; what lies outside its pixels is transparent and
// stays so), placed on the page through the frame's aspect fit. The box
// reports a page-space matrix; the layer needs an image-px one, which is
// the same map seen through the fit: `M_img = F⁻¹ · M_page · F`, with
// F the image-px → page-pt fit (a uniform scale and an offset). The
// session resamples the layer once on commit with `geom.warp_projective`
// (bilinear or bicubic, transparent outside) — one undo step. With a
// selection the selected pixels transform and the rest stay (the kernel's
// masked lane), which is Photoshop's floating selection made in one pass.

import type {
  BundleHost,
  GestureHandler,
  PagedEditor,
  ProjectiveMatrix,
  TransformBoxSession,
  TransformBoxUpdate,
  TransformQuad,
} from "@paged-media/plugin-api";

import { invert3, multiply3 } from "@paged-media/plugin-sdk";

import { resolveFrameFit, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";

/** image px → page pt, as a projective matrix. */
export function fitMatrix(fit: FitTransform): ProjectiveMatrix {
  return [fit.scale, 0, fit.originX, 0, fit.scale, fit.originY, 0, 0, 1];
}

/** The page-space box matrix seen in image px: `F⁻¹ · M · F`. */
export function pageToImageMatrix(
  fit: FitTransform,
  m: ProjectiveMatrix,
): ProjectiveMatrix {
  const f = fitMatrix(fit);
  // The fit is a uniform scale and an offset: never singular.
  return multiply3(invert3(f)!, multiply3(m, f));
}

/** The canvas extent `w`×`h` placed on the page (NW, NE, SE, SW). */
export function layerQuadOnPage(
  fit: FitTransform,
  w: number,
  h: number,
): TransformQuad {
  const at = (x: number, y: number): [number, number] => [
    fit.originX + x * fit.scale,
    fit.originY + y * fit.scale,
  ];
  return [at(0, 0), at(w, 0), at(w, h), at(0, h)];
}

/** Open the box over the active layer. Resolves the session's box, or
 *  null with the reason in the status line. */
export async function beginLayerTransform(
  host: BundleHost,
  session: ImageSession,
  toolId: string,
): Promise<TransformBoxSession | null> {
  const src = session.state().source;
  if (!src) return null;
  const fit = await resolveFrameFit(host, src, "free transform");
  if (!fit) return null;
  return host.transformBox.open({
    pageId: fit.pageId,
    quad: layerQuadOnPage(fit, src.width, src.height),
    toolId,
    onCommit(u: TransformBoxUpdate) {
      void session.transformLayer(pageToImageMatrix(fit, u.matrix));
    },
  });
}

/** The tool that hosts the box: activating it opens the box over the
 *  active layer (when none is open); its own pointer events are only the
 *  presses the box lets through — outside it, which commit (Photoshop
 *  commits a transform on a click outside). */
export function makeTransformGesture(
  host: BundleHost,
  session: ImageSession,
  toolId: string,
): GestureHandler {
  return {
    onActivate(_p: PagedEditor) {
      if (!host.transformBox.active())
        void beginLayerTransform(host, session, toolId);
    },
    onDeactivate(reason) {
      // A real switch commits the open box, as Photoshop asks to.
      if (reason === "switch") host.transformBox.active()?.commit();
    },
    onPointerDown() {
      // Outside the box: commit it.
      host.transformBox.active()?.commit();
    },
    onPointerMove() {},
    onPointerUp() {},
  };
}
