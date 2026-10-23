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

// v70 — the editor half of the plugin page doors (`host.viewport.goToPage`,
// `activePage`, `onDidChangeActivePage`; plugin-sdk `PagesBackend`). The
// camera and the page layout live in the React tree, the plugin hosts are
// built once outside it, so this is the hand-off: the canvas publishes the
// active page and registers how to go to one; the backend reads both. One
// per editor (plan task E1), kept in its scope.

import type { Camera } from "@paged-media/client";
import { scoped, type EditorScope } from "@paged-media/shell";

import { fitCamera, layoutPages } from "./ui/layout";

type Listener = (pageId: string | null) => void;
type GoTo = (
  pageId: string,
  fit: "page" | "width",
) => boolean | Promise<boolean>;

type Reveal = (range: TextRange, select: boolean) => Promise<boolean>;

/** One editor's page and text doors. */
export interface PageDoors {
  /** The canvas reports the page the user is on; listeners hear changes
   *  only. */
  publishActivePage(pageId: string | null): void;
  /** The canvas registers how it moves the camera to a page (null: none). */
  setPageGoTo(fn: GoTo | null): void;
  /** The canvas registers how it reveals a text range (null: none). */
  setTextReveal(fn: Reveal | null): void;
  /** The backend every plugin host gets (plugin-sdk `PagesBackend`). */
  readonly pages: {
    goToPage(pageId: string, fit: "page" | "width"): boolean | Promise<boolean>;
    activePage(): string | null;
    onDidChangeActivePage(listener: Listener): () => void;
  };
  /** The backend every plugin host gets (plugin-sdk `TextRevealBackend`). */
  readonly text: {
    revealText(range: TextRange, select: boolean): Promise<boolean> | boolean;
  };
}

export function createPageDoors(): PageDoors {
  let active: string | null = null;
  let goTo: GoTo | null = null;
  let reveal: Reveal | null = null;
  const listeners = new Set<Listener>();
  return {
    publishActivePage(pageId) {
      if (pageId === active) return;
      active = pageId;
      for (const l of [...listeners]) {
        try {
          l(pageId);
        } catch {
          // One plugin's listener must not stop the others.
        }
      }
    },
    setPageGoTo(fn) {
      goTo = fn;
    },
    setTextReveal(fn) {
      reveal = fn;
    },
    pages: {
      goToPage: (pageId, fit) => (goTo ? goTo(pageId, fit) : false),
      activePage: () => active,
      onDidChangeActivePage(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    text: {
      revealText: (range, select) => (reveal ? reveal(range, select) : false),
    },
  };
}

/** `scope`'s page doors. */
export const PAGE_DOORS = scoped("pageDoors", () => createPageDoors());

export function pageDoorsOf(scope: EditorScope): PageDoors {
  return scope.get(PAGE_DOORS);
}

/** The camera that shows page `index` of `pageSizesPt`: the whole page,
 *  or its full width from its top edge. */
export function cameraForPage(
  pageSizesPt: ReadonlyArray<readonly [number, number]>,
  index: number,
  fit: "page" | "width",
  viewportWidthPx: number,
  viewportHeightPx: number,
  marginPx = 40,
): Camera | null {
  const rect = layoutPages(pageSizesPt)[index];
  if (!rect || viewportWidthPx <= 0 || viewportHeightPx <= 0) return null;
  if (fit === "page") {
    return fitCamera(viewportWidthPx, viewportHeightPx, rect, marginPx);
  }
  const scale = Math.max(0.01, (viewportWidthPx - 2 * marginPx) / rect.w);
  return {
    scale,
    tx: (viewportWidthPx - rect.w * scale) / 2 - rect.x * scale,
    ty: marginPx - rect.y * scale,
  };
}

// `host.viewport.revealText` (plugin-sdk `TextRevealBackend`): the same
// hand-off. The canvas registers how it takes the user to a range of text
// (camera onto the range, optionally select it); the backend calls it.

export interface TextRange {
  storyId: string;
  start: number;
  end: number;
}

/** The camera, at `scale`, that centres page-local point (`xPt`, `yPt`) of
 *  page `index` in the viewport. */
export function cameraCentredOn(
  pageSizesPt: ReadonlyArray<readonly [number, number]>,
  index: number,
  xPt: number,
  yPt: number,
  scale: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
): Camera | null {
  const rect = layoutPages(pageSizesPt)[index];
  if (!rect || viewportWidthPx <= 0 || viewportHeightPx <= 0 || !(scale > 0))
    return null;
  return {
    scale,
    tx: viewportWidthPx / 2 - (rect.x + xPt) * scale,
    ty: viewportHeightPx / 2 - (rect.y + yPt) * scale,
  };
}
