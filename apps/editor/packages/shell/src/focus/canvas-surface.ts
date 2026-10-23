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

// The canvas viewport as a keyboard surface (ADR 234).
//
// The viewport is focusable and in the tab order, so a keyboard user can
// reach the document and leave it again. Tab on it hides the chrome — the
// InDesign convention — only when the user got there with the POINTER: a
// click in the canvas marks it `data-pointer-engaged` until focus leaves
// it. Reached by Tab, the viewport passes Tab on like any other stop, so
// it is never a keyboard trap (WCAG 2.1.2); Cmd/Ctrl+\ hides the chrome
// from anywhere.

import { t } from "@paged-media/strings";
import { SURFACE } from "../messages";
import type { FocusEvent, PointerEvent } from "react";

import { CANVAS_SURFACE_ATTR } from "./key-ownership";

import { queryEditor } from "../state/editor-dom";

const ENGAGED_ATTR = "data-pointer-engaged";

/** Elements inside the viewport that take focus themselves when clicked. */
const OWN_FOCUS =
  'input,textarea,select,button,a[href],[contenteditable="true"],[tabindex]';

/** The viewport surface element of the editor whose root is `root` (the
 *  page's without one), if one is mounted. */
export function canvasViewport(
  root: HTMLElement | null = null,
): HTMLElement | null {
  return queryEditor<HTMLElement>(root, `[${CANVAS_SURFACE_ATTR}="viewport"]`);
}

/** Focus the canvas viewport: a pointer click on a tool hands focus back
 *  to the document, as InDesign does, so the next arrow nudges and the
 *  next Tab hides the chrome (`engaged`: the hand-back counts as pointer
 *  focus). No-op when none is mounted or focus is already inside it. */
export function focusCanvasViewport(
  options: { engaged?: boolean; root?: HTMLElement | null } = {},
): void {
  const viewport = canvasViewport(options.root ?? null);
  if (!viewport || viewport.contains(document.activeElement)) return;
  if (options.engaged) viewport.setAttribute(ENGAGED_ATTR, "true");
  viewport.focus({ preventScroll: true });
}

/** Does the viewport hold focus because the user clicked in the canvas?
 *  The chrome toggle on Tab applies only then. */
export function canvasHasPointerFocus(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return (
    active !== null &&
    active.getAttribute(CANVAS_SURFACE_ATTR) === "viewport" &&
    active.getAttribute(ENGAGED_ATTR) === "true"
  );
}

/** Spread on the viewport element. */
export const canvasViewportSurfaceProps = {
  tabIndex: 0,
  role: "application",
  // Read when the props are spread, so it follows the editor's locale.
  get "aria-label"() {
    return t(SURFACE.documentCanvas);
  },
  [CANVAS_SURFACE_ATTR]: "viewport",
  onPointerDownCapture(e: PointerEvent<HTMLElement>) {
    const viewport = e.currentTarget;
    viewport.setAttribute(ENGAGED_ATTR, "true");
    const target = e.target as Element | null;
    const own = target?.closest?.(OWN_FOCUS);
    if (own && own !== viewport && viewport.contains(own)) return;
    if (viewport.contains(document.activeElement)) return;
    viewport.focus({ preventScroll: true });
  },
  onBlur(e: FocusEvent<HTMLElement>) {
    const viewport = e.currentTarget;
    const next = e.relatedTarget as Node | null;
    if (next && viewport.contains(next)) return;
    // The window lost focus (Cmd+Tab away): the user comes back to the
    // canvas they left, still engaged.
    if (next === null && !document.hasFocus()) return;
    viewport.removeAttribute(ENGAGED_ATTR);
  },
} as const;
