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

// Phones and tablets (editor ADR 293). The fill shapes (`template-fill`,
// `form`) change layout below a breakpoint measured on the EDITOR's root,
// not the window: an editor embedded in a narrow column of a wide page is
// narrow. Their controls are touch-sized below the breakpoint and wherever
// the primary pointer is coarse (a tablet held wide). A profile without a
// compact layout, the full and focused editors, is a desktop editor at
// every width and none of this applies to it.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import type { CompactLayout } from "../profile/types";
import { useChromeRegions } from "./chrome-regions";
import { useEditorRoot } from "./editor-root";

/** Below this width (CSS px, exclusive) a fill shape uses its compact
 *  layout. 720 keeps a tablet in portrait (768) on the desktop layout
 *  with touch-sized controls, and puts every phone on the compact one. */
export const COMPACT_MAX_WIDTH_PX = 720;

/** The smallest side of a touch target (WCAG 2.5.5, Apple's and
 *  Android's guidance): 44 CSS px. */
export const TOUCH_TARGET_PX = 44;

export function isCompactWidth(width: number): boolean {
  return width > 0 && width < COMPACT_MAX_WIDTH_PX;
}

function widthOf(root: HTMLElement | null): number {
  const measured = root ? root.getBoundingClientRect().width : 0;
  if (measured > 0) return measured;
  // Not laid out yet (or no layout at all, as in a DOM test): the window.
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

/** The editor root's width in CSS px, kept current. */
export function useEditorWidth(): number {
  const root = useEditorRoot();
  const [width, setWidth] = useState(() => widthOf(root));
  useEffect(() => {
    const update = () => setWidth(widthOf(root));
    update();
    window.addEventListener("resize", update);
    let observer: ResizeObserver | null = null;
    if (root && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(root);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [root]);
  return width;
}

/** The profile's compact layout when the editor is narrow now; null for
 *  a desktop editor or a wide one. */
export function useCompactLayout(): CompactLayout | null {
  const { compact } = useChromeRegions();
  const width = useEditorWidth();
  return compact && isCompactWidth(width) ? compact : null;
}

const COARSE = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(COARSE);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function coarseNow(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COARSE).matches;
}

/** Whether a fill shape's controls are touch-sized now: compact, or a
 *  coarse primary pointer. Always false in a desktop editor. */
export function useTouchSized(): boolean {
  const { compact } = useChromeRegions();
  const layout = useCompactLayout();
  const coarse = useSyncExternalStore(subscribeCoarse, coarseNow, () => false);
  return compact !== null && (layout !== null || coarse);
}

/** The inline size of a touch target, or nothing when not touch-sized. */
export function touchTargetStyle(touch: boolean): CSSProperties {
  return touch ? { minHeight: TOUCH_TARGET_PX, minWidth: TOUCH_TARGET_PX } : {};
}
