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

// The presenter's pointer tools over the slide (slide ADR 716): the laser
// pointer (Ctrl+L, a red dot that follows the pointer) and the pen (Ctrl+P,
// ink drawn on the slide). Ink is kept per slide for the show, in slide
// coordinates (0…1 across and down), so the audience window draws the
// same strokes at its own size; E erases the slide's ink. It is not
// written into the document.

import type { SlideBox } from "./compositor.js";
import type { PointerTool } from "./show-model.js";

export type Stroke = ReadonlyArray<readonly [number, number]>;

export interface Ink {
  setTool(tool: PointerTool): void;
  /** The strokes on the slide up. */
  setStrokes(strokes: readonly Stroke[]): void;
  /** Show the laser at a slide position, or hide it (null). */
  laser(at: readonly [number, number] | null): void;
  /** Lay the overlay over the slide's box. */
  layout(box: SlideBox): void;
  dispose(): void;
}

export interface InkOptions {
  /** Pointer input is taken (the show and the console; not the audience). */
  interactive: boolean;
  onStroke?(stroke: Stroke): void;
  onLaser?(at: readonly [number, number] | null): void;
}

const PEN = "#e3242b";

export function createInk(
  container: HTMLElement,
  win: Window,
  opts: InkOptions,
): Ink {
  const doc = container.ownerDocument;
  const layer = doc.createElement("canvas");
  layer.setAttribute("data-show-ink", "");
  Object.assign(layer.style, {
    position: "absolute",
    touchAction: "none",
    pointerEvents: "none",
  });
  const dot = doc.createElement("div");
  dot.setAttribute("data-show-laser", "");
  Object.assign(dot.style, {
    position: "absolute",
    width: "14px",
    height: "14px",
    marginLeft: "-7px",
    marginTop: "-7px",
    borderRadius: "50%",
    background: "radial-gradient(#ff5a5a, #d10000 60%, rgba(209,0,0,0))",
    boxShadow: "0 0 10px 3px rgba(255,0,0,.6)",
    pointerEvents: "none",
    display: "none",
  });
  container.append(layer, dot);
  const g = layer.getContext("2d");

  let tool: PointerTool = "arrow";
  let strokes: Stroke[] = [];
  let live: Array<[number, number]> | null = null;
  let rect: SlideBox = { x: 0, y: 0, width: 0, height: 0 };

  const redraw = () => {
    if (!g) return;
    const dpr = win.devicePixelRatio || 1;
    layer.width = Math.max(1, Math.round(rect.width * dpr));
    layer.height = Math.max(1, Math.round(rect.height * dpr));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rect.width, rect.height);
    g.strokeStyle = PEN;
    g.lineWidth = Math.max(2, rect.width / 400);
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const s of live ? [...strokes, live] : strokes) {
      if (s.length === 0) continue;
      g.beginPath();
      g.moveTo(s[0][0] * rect.width, s[0][1] * rect.height);
      for (const [x, y] of s.slice(1))
        g.lineTo(x * rect.width, y * rect.height);
      g.stroke();
    }
  };

  const toSlide = (e: PointerEvent): [number, number] => {
    const r = layer.getBoundingClientRect();
    return [
      r.width > 0 ? (e.clientX - r.left) / r.width : 0,
      r.height > 0 ? (e.clientY - r.top) / r.height : 0,
    ];
  };

  const showDot = (at: readonly [number, number] | null) => {
    if (!at) {
      dot.style.display = "none";
      return;
    }
    dot.style.display = "block";
    dot.style.left = `${rect.x + at[0] * rect.width}px`;
    dot.style.top = `${rect.y + at[1] * rect.height}px`;
  };

  const offs: Array<() => void> = [];
  if (opts.interactive) {
    const down = (e: PointerEvent) => {
      if (tool !== "pen") return;
      e.preventDefault();
      e.stopPropagation();
      layer.setPointerCapture?.(e.pointerId);
      live = [toSlide(e)];
    };
    const move = (e: PointerEvent) => {
      if (tool === "laser") {
        const at = toSlide(e);
        showDot(at);
        opts.onLaser?.(at);
      } else if (tool === "pen" && live) {
        live.push(toSlide(e));
        redraw();
      }
    };
    const up = () => {
      if (!live) return;
      const done = live;
      live = null;
      if (done.length > 0) {
        strokes = [...strokes, done];
        opts.onStroke?.(done);
      }
      redraw();
    };
    const leave = () => {
      if (tool !== "laser") return;
      showDot(null);
      opts.onLaser?.(null);
    };
    layer.addEventListener("pointerdown", down);
    layer.addEventListener("pointermove", move);
    layer.addEventListener("pointerup", up);
    layer.addEventListener("pointerleave", leave);
    offs.push(() => {
      layer.removeEventListener("pointerdown", down);
      layer.removeEventListener("pointermove", move);
      layer.removeEventListener("pointerup", up);
      layer.removeEventListener("pointerleave", leave);
    });
  }

  return {
    setTool(t) {
      tool = t;
      layer.style.pointerEvents =
        opts.interactive && t !== "arrow" ? "auto" : "none";
      layer.style.cursor =
        t === "pen" ? "crosshair" : t === "laser" ? "none" : "";
      if (t !== "laser") showDot(null);
    },
    setStrokes(next) {
      strokes = [...next];
      redraw();
    },
    laser: showDot,
    layout(box) {
      rect = box;
      Object.assign(layer.style, {
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
      redraw();
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      layer.remove();
      dot.remove();
    },
  };
}
