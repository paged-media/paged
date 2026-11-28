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

/**
 * Input lanes for the viewer — each independently disableable:
 * - wheel: Ctrl/⌘-wheel and pinch (`ctrlKey` wheel) zoom to cursor,
 *   plain wheel pans.
 * - drag: one pointer pans (mouse, pen or one finger).
 * - pinch: two touch pointers zoom about their midpoint and pan with it.
 * - double-click: zoom step at the cursor.
 * - keyboard: `+`/`-`/`0`, arrows, PgUp/PgDn, Home/End.
 */

export interface InputOptions {
  wheelZoom?: boolean;
  dragPan?: boolean;
  /** Two-finger pinch zoom on touch screens. */
  pinchZoom?: boolean;
  doubleClickZoom?: boolean;
  keyboard?: boolean;
}

export interface InputSink {
  zoomAt(factor: number, anchor: { x: number; y: number }): void;
  panBy(dx: number, dy: number): void;
  zoomStep(direction: 1 | -1, anchor?: { x: number; y: number }): void;
  fit(): void;
  pageStep(direction: 1 | -1): void;
  home(): void;
  end(): void;
}

const ARROW_PAN_PX = 48;

/** Attach listeners; returns the detach function. */
export function attachInput(
  canvas: HTMLCanvasElement,
  options: InputOptions,
  sink: InputSink,
): () => void {
  const teardown: Array<() => void> = [];
  const listen = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void => {
    canvas.addEventListener(type, handler as EventListener, opts);
    teardown.push(() =>
      canvas.removeEventListener(type, handler as EventListener, opts),
    );
  };

  const anchorOf = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  if (options.wheelZoom !== false) {
    listen(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // Trackpad pinch arrives as ctrlKey wheel; exponential map
          // keeps pinch and wheel-notch speeds comparable.
          sink.zoomAt(Math.exp(-e.deltaY * 0.0024), anchorOf(e));
        } else {
          sink.panBy(-e.deltaX, -e.deltaY);
        }
      },
      { passive: false },
    );
  }

  const dragPan = options.dragPan !== false;
  const pinchZoom = options.pinchZoom !== false;
  if (dragPan || pinchZoom) {
    // Every pointer that is down, by id, at its last position (client px).
    const pointers = new Map<number, { x: number; y: number }>();
    const pinchState = (): { x: number; y: number; span: number } | null => {
      if (pointers.size !== 2) return null;
      const [a, b] = [...pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        span: Math.hypot(a.x - b.x, a.y - b.y),
      };
    };

    // The browser's own touch panning and zooming would cancel the
    // pointer stream after the first few moves; the canvas handles both.
    const style = canvas.style as CSSStyleDeclaration | undefined;
    if (style) {
      const before = style.touchAction;
      style.touchAction = "none";
      teardown.push(() => {
        style.touchAction = before;
      });
    }

    listen("pointerdown", (e) => {
      // A mouse pans with its primary button only; touch and pen have one.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (pointers.size >= 2) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture?.(e.pointerId);
    });
    listen("pointermove", (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const before = pinchState();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = pinchState();
      if (before && after) {
        if (!pinchZoom) return;
        // Pan with the midpoint first, then zoom about where it now is,
        // so the document point between the fingers stays between them.
        sink.panBy(after.x - before.x, after.y - before.y);
        if (before.span > 0 && after.span > 0) {
          sink.zoomAt(
            after.span / before.span,
            anchorOf({
              clientX: after.x,
              clientY: after.y,
            }),
          );
        }
        return;
      }
      if (dragPan) sink.panBy(e.clientX - last.x, e.clientY - last.y);
    });
    const stop = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    listen("pointerup", stop);
    listen("pointercancel", stop);
  }

  if (options.doubleClickZoom !== false) {
    listen("dblclick", (e) => {
      e.preventDefault();
      sink.zoomStep(e.shiftKey ? -1 : 1, anchorOf(e));
    });
  }

  if (options.keyboard !== false) {
    // The canvas needs focusability for keydown.
    if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
    listen("keydown", (e) => {
      switch (e.key) {
        case "+":
        case "=":
          sink.zoomStep(1);
          break;
        case "-":
        case "_":
          sink.zoomStep(-1);
          break;
        case "0":
          sink.fit();
          break;
        case "ArrowLeft":
          sink.panBy(ARROW_PAN_PX, 0);
          break;
        case "ArrowRight":
          sink.panBy(-ARROW_PAN_PX, 0);
          break;
        case "ArrowUp":
          sink.panBy(0, ARROW_PAN_PX);
          break;
        case "ArrowDown":
          sink.panBy(0, -ARROW_PAN_PX);
          break;
        case "PageUp":
          sink.pageStep(-1);
          break;
        case "PageDown":
          sink.pageStep(1);
          break;
        case "Home":
          sink.home();
          break;
        case "End":
          sink.end();
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  return () => {
    for (const detach of teardown) detach();
  };
}
