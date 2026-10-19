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

// Keyboard shortcuts for the canvas.
//
// Window-level keydown listener. Behaviours mirror common viewer
// conventions (Cmd/Ctrl+0 and Cmd/Ctrl+1 are registry bindings onto
// paged.view.zoomFit / zoom100 now, APP_KEYBINDINGS, F-16 / SH-9):
//
//   Page Down     → next page (fit-to-page animated)
//   Page Up       → previous page (fit-to-page animated)
//   Home          → first page
//   End           → last page
//
// Handlers are skipped when the focused control owns the key (a field,
// a dialog, an open menu, a toolbar's arrows — `canvasKeyYields`, ADR
// 234) so the shortcuts don't fight ordinary typing or navigation.

import { useEffect } from "react";
import type { Camera } from "@paged-media/client";
import { canvasKeyYields } from "@paged-media/shell";
import { fitCamera, layoutPages } from "./layout";
import type { PageId } from "@paged-media/client";

export interface ShortcutContext {
  pageIds: ReadonlyArray<PageId>;
  pageSizesPt: ReadonlyArray<readonly [number, number]>;
  camera: Camera;
  viewportSize: readonly [number, number];
  animateCamera: (target: Camera) => void;
}

export function useKeyboardShortcuts(ctx: ShortcutContext) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (canvasKeyYields(e)) return;
      const [vw, vh] = ctx.viewportSize;
      if (vw < 10 || vh < 10) return;

      const rects = layoutPages(ctx.pageSizesPt);

      if (
        e.key === "PageDown" ||
        e.key === "PageUp" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        if (rects.length === 0) return;
        // Determine the page closest to viewport centre — used as
        // the "current" page for relative navigation.
        const cx = vw / 2;
        const cy = vh / 2;
        const docX = (cx - ctx.camera.tx) / ctx.camera.scale;
        const docY = (cy - ctx.camera.ty) / ctx.camera.scale;
        let currentIdx = 0;
        let bestDistSq = Number.POSITIVE_INFINITY;
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          const px = r.x + r.w / 2;
          const py = r.y + r.h / 2;
          const dsq = (px - docX) ** 2 + (py - docY) ** 2;
          if (dsq < bestDistSq) {
            bestDistSq = dsq;
            currentIdx = i;
          }
        }
        let target: number;
        switch (e.key) {
          case "PageDown":
            target = Math.min(rects.length - 1, currentIdx + 1);
            break;
          case "PageUp":
            target = Math.max(0, currentIdx - 1);
            break;
          case "Home":
            target = 0;
            break;
          case "End":
            target = rects.length - 1;
            break;
          default:
            return;
        }
        if (target === currentIdx) return;
        e.preventDefault();
        ctx.animateCamera(fitCamera(vw, vh, rects[target]));
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx]);
}
