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

// Focus returns to the opener (editor ADR 1206, decision D-11 of ADR 1201,
// the interaction specification's UXI-KEY-009 and UXI-A11Y-005).
//
// A surface that takes focus while it is open — the command palette, a
// dialog, a menu, the canvas context menu — records where focus was as it
// opens and hands it back as it closes: to that control when it is still
// there to take it (in the document, shown, enabled), and otherwise to the
// canvas, the place the user works: the caret's text input while a caret
// is live, else the viewport. Never to `<body>`, where the next key would
// belong to nobody in particular, and never by marking the viewport
// pointer-engaged (UXI-KEY-010: a hand-back is not a click).
//
// One service per editor (its scope): a palette closing in one editor never
// moves focus in another.

import { scoped, useScoped, type EditorScope } from "../state/editor-scope";
import { editorRootOf, isActiveEditor } from "../state/editor-root";
import { queryEditor } from "../state/editor-dom";
import { CANVAS_SURFACE_ATTR } from "./key-ownership";

export interface FocusReturn {
  /** `surface` opens: remember `opener` (default: the focused element)
   *  as where focus goes back to. Call before focus moves in. */
  open(surface: string, opener?: Element | null): void;
  /** `surface` closed: give focus back (to its opener, else the canvas,
   *  else the editor's root). Returns the element that took focus, or
   *  null when nothing could. A surface never opened is a no-op. */
  close(surface: string): Element | null;
  /** The opener recorded for `surface` (tests, diagnostics). */
  openerOf(surface: string): Element | null;
}

/** Where focus may land: an element still in the document, shown, not
 *  disabled, and not the page itself. (A modal's `aria-hidden` on the rest
 *  of the editor may still be in place as the modal closes; whether focus
 *  really landed is checked after the move.) */
export function canTakeFocus(
  el: Element | null | undefined,
): el is HTMLElement {
  if (!el || typeof (el as HTMLElement).focus !== "function") return false;
  if (!el.isConnected) return false;
  const doc = el.ownerDocument;
  if (el === doc.body || el === doc.documentElement) return false;
  if ((el as HTMLButtonElement).disabled === true) return false;
  // Not rendered (display: none on it or an ancestor). getClientRects is
  // empty for such an element in a browser; a DOM without layout (tests)
  // reports nothing either way, so only an explicit hidden style counts.
  for (let n: Element | null = el; n; n = n.parentElement) {
    const style = (n as HTMLElement).style;
    if (style?.display === "none" || style?.visibility === "hidden")
      return false;
    if ((n as HTMLElement).hidden === true) return false;
  }
  return true;
}

/** The canvas element focus falls back to in the editor whose root is
 *  `root`: the text input while a caret is live, else the viewport. */
export function canvasFocusTarget(
  root: HTMLElement | null,
): HTMLElement | null {
  const text = queryEditor<HTMLElement>(
    root,
    `textarea[${CANVAS_SURFACE_ATTR}="text"][data-caret-active="true"]`,
  );
  if (canTakeFocus(text)) return text;
  const viewport = queryEditor<HTMLElement>(
    root,
    `[${CANVAS_SURFACE_ATTR}="viewport"]`,
  );
  return canTakeFocus(viewport) ? viewport : null;
}

function createFocusReturn(scope: EditorScope): FocusReturn {
  const openers = new Map<string, Element | null>();
  const focusOn = (el: HTMLElement): Element | null => {
    el.focus({ preventScroll: true });
    return el.ownerDocument.activeElement === el ? el : null;
  };
  return {
    open(surface, opener) {
      const at =
        opener !== undefined
          ? opener
          : typeof document === "undefined"
            ? null
            : document.activeElement;
      openers.set(surface, at);
    },
    close(surface) {
      if (!openers.has(surface)) return null;
      const opener = openers.get(surface) ?? null;
      openers.delete(surface);
      // Focus the user already moved somewhere (a click in another editor or
      // a panel's field closed the surface) stays there: only focus that
      // dropped with the surface — to `<body>`, the root, or a node that left
      // the document — is handed back, and only while this editor is still
      // the page's active one.
      if (typeof document !== "undefined") {
        const now = document.activeElement;
        const root = editorRootOf(scope);
        if (!isActiveEditor(root)) return null;
        const dropped =
          now === null ||
          now === document.body ||
          now === document.documentElement ||
          now === root ||
          !now.isConnected;
        if (!dropped) return null;
      }
      if (canTakeFocus(opener)) {
        const landed = focusOn(opener);
        if (landed) return landed;
      }
      // The fallbacks are this editor's own: an editor that is gone (a
      // surface closing as its editor unmounts, Radix closes a beat later)
      // or a dialog with no editor around it moves no focus at all, and
      // never into another editor on the page.
      const root = editorRootOf(scope);
      if (!root || !root.isConnected) return null;
      const canvas = canvasFocusTarget(root);
      if (canvas) {
        const landed = focusOn(canvas);
        if (landed) return landed;
      }
      return focusOn(root);
    },
    openerOf: (surface) => openers.get(surface) ?? null,
  };
}

const FOCUS_RETURN = scoped("focusReturn", createFocusReturn);

/** `scope`'s focus-return service. */
export function focusReturnOf(scope: EditorScope): FocusReturn {
  return scope.get(FOCUS_RETURN);
}

/** This component's editor's focus-return service. */
export function useFocusReturn(): FocusReturn {
  return useScoped(FOCUS_RETURN);
}
