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

// The slide show on screen (slide ADR 716): the controller that owns the
// show's state, and the view that draws it. The SHOW surface (F5 on one
// screen) is a controller with a view; the presenter CONSOLE (presenter.ts)
// is a controller with its own layout; the AUDIENCE window is a view fed
// by the console over the presentation's channel.
//
// The controller advances by itself where a slide says "after N seconds"
// (the transition's advanceAfterMs, which the Transition panel edits and
// Rehearse Timings records), keeps each slide's ink for the show, and
// times the slides when rehearsing. When the show ends the editor goes to
// the slide it ended on.

import { t } from "@paged-media/strings";

import { SHOW } from "../messages.js";
import { createCompositor, type Compositor } from "./compositor.js";
import { frameScale, type FrameSource } from "./frames.js";
import { createInk, type Ink, type Stroke } from "./ink.js";
import {
  current,
  keyAction,
  reduce,
  startShow,
  upNext,
  type ShowAction,
  type ShowSlide,
  type ShowState,
} from "./show-model.js";

/** What the audience window draws, as the console sends it. */
export interface ViewSnapshot {
  /** The slide up, null on the end screen. */
  slide: ShowSlide | null;
  index: number;
  blank: "black" | "white" | null;
  ended: boolean;
  strokes: readonly Stroke[];
  /** Whether the slide changed since the last snapshot (run its
   *  transition). */
  advanced: boolean;
}

/** The messages between the console and the audience. */
export type ShowMessage =
  | { t: "snapshot"; snapshot: ViewSnapshot }
  | { t: "laser"; at: readonly [number, number] | null }
  | { t: "ready" }
  | {
      t: "key";
      key: string;
      ctrlKey: boolean;
      metaKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }
  | { t: "advance" };

export interface ShowControllerOptions {
  slides: readonly ShowSlide[];
  from?: number;
  loop?: boolean;
  /** Time each slide instead of advancing by the slides' timings. */
  rehearse?: boolean;
  /** Timers, injectable for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

/** The show's state and what it drives: automatic advance, ink, timings. */
export class ShowController {
  private s: ShowState;
  private readonly listeners = new Set<
    (s: ShowState, prev: ShowState) => void
  >();
  private readonly ink = new Map<string, Stroke[]>();
  private timer: unknown = null;
  private enteredAt: number;
  private readonly startedAt: number;
  private readonly timings = new Map<string, number>();
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly now: () => number;
  readonly rehearse: boolean;

  constructor(opts: ShowControllerOptions) {
    this.s = startShow(opts.slides, { from: opts.from, loop: opts.loop });
    this.rehearse = opts.rehearse === true;
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT =
      opts.clearTimeout ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
    this.enteredAt = this.now();
    this.startedAt = this.enteredAt;
    this.schedule();
  }

  state(): ShowState {
    return this.s;
  }

  dispatch(action: ShowAction): void {
    const prev = this.s;
    const next = reduce(prev, action);
    if (next === prev) return;
    if (action.type === "erase") {
      const slide = current(prev);
      if (slide) this.ink.delete(slide.pageId);
    }
    const moved = next.index !== prev.index || next.ended !== prev.ended;
    if (moved || next.done) this.leave(prev);
    this.s = next;
    if (moved || next.blank !== prev.blank || next.grid !== prev.grid)
      this.schedule();
    if (next.done) this.cancel();
    for (const l of [...this.listeners]) l(next, prev);
  }

  /** A key press; true when the show used it. */
  key(e: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  }): boolean {
    const a = keyAction(e, this.s);
    if (!a) return false;
    this.dispatch(a);
    return true;
  }

  subscribe(fn: (s: ShowState, prev: ShowState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  strokes(pageId: string): readonly Stroke[] {
    return this.ink.get(pageId) ?? [];
  }

  addStroke(pageId: string, stroke: Stroke): void {
    this.ink.set(pageId, [...(this.ink.get(pageId) ?? []), stroke]);
    for (const l of [...this.listeners]) l(this.s, this.s);
  }

  /** The time spent on each slide (rehearsal), ms by page id. */
  rehearsed(): ReadonlyMap<string, number> {
    return this.timings;
  }

  /** How long the slide up has been up, ms. */
  onSlideMs(): number {
    return this.now() - this.enteredAt;
  }

  /** How long the show has run, ms. */
  showMs(): number {
    return this.now() - this.startedAt;
  }

  /** The snapshot the audience draws. */
  snapshot(prev?: ShowState): ViewSnapshot {
    const s = this.s;
    const slide = current(s);
    return {
      slide,
      index: s.index,
      blank: s.blank,
      ended: s.ended,
      strokes: slide ? this.strokes(slide.pageId) : [],
      advanced:
        prev !== undefined &&
        (prev.index !== s.index || prev.ended !== s.ended),
    };
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private leave(prev: ShowState): void {
    const slide = current(prev);
    const t = this.now();
    if (slide && this.rehearse)
      this.timings.set(
        slide.pageId,
        (this.timings.get(slide.pageId) ?? 0) + (t - this.enteredAt),
      );
    this.enteredAt = t;
  }

  private cancel(): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
  }

  /** Arm the automatic advance of the slide up, if it has one. */
  private schedule(): void {
    this.cancel();
    const s = this.s;
    const slide = current(s);
    if (
      this.rehearse ||
      !slide ||
      s.blank ||
      s.grid !== null ||
      s.done ||
      slide.advanceAfterMs === null
    )
      return;
    this.timer = this.setT(() => {
      this.timer = null;
      this.dispatch({ type: "next" });
    }, slide.advanceAfterMs);
  }
}

// ------------------------------------------------------------- the view

export interface ShowViewOptions {
  frames: FrameSource;
  /** Pointer input for the pen and the laser. */
  interactive: boolean;
  onStroke?(pageId: string, stroke: Stroke): void;
  onLaser?(at: readonly [number, number] | null): void;
  /** A click on the slide with the arrow tool (advance). */
  onClick?(): void;
}

/** Draws one slide surface: the slide, the blank screens, the end screen
 *  and the ink. The data attributes on `container` say what is up. */
export class ShowView {
  readonly compositor: Compositor;
  readonly ink: Ink;
  private readonly end: HTMLElement;
  private readonly win: Window;
  private shown: string | null = null;
  private seq = 0;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly container: HTMLElement,
    win: Window,
    private readonly opts: ShowViewOptions,
  ) {
    this.win = win;
    container.style.position = container.style.position || "relative";
    this.compositor = createCompositor(container, win, {
      // A device without WebGPU cuts between slides; say so once.
      onNoGpu: () => {
        const note = container.ownerDocument.createElement("div");
        note.setAttribute("data-show-notice", "no-webgpu");
        note.textContent = t(SHOW.noWebGpu);
        Object.assign(note.style, {
          position: "absolute",
          left: "16px",
          bottom: "12px",
          font: "13px system-ui, sans-serif",
          color: "#ccc",
          background: "rgba(0,0,0,.6)",
          padding: "4px 8px",
          borderRadius: "4px",
          pointerEvents: "none",
        });
        container.appendChild(note);
        const timer = win.setTimeout(() => note.remove(), 6000);
        this.offs.push(() => {
          win.clearTimeout(timer);
          note.remove();
        });
      },
    });
    this.ink = createInk(container, win, {
      interactive: opts.interactive,
      onStroke: (s) => {
        if (this.shown) opts.onStroke?.(this.shown, s);
      },
      onLaser: opts.onLaser,
    });
    const doc = container.ownerDocument;
    this.end = doc.createElement("div");
    this.end.setAttribute("data-show-end", "");
    Object.assign(this.end.style, {
      position: "absolute",
      left: "0",
      right: "0",
      top: "48%",
      textAlign: "center",
      font: "16px system-ui, sans-serif",
      color: "#ddd",
      display: "none",
    });
    this.end.textContent = t(SHOW.endOfShow);
    container.appendChild(this.end);
    const click = () => opts.onClick?.();
    container.addEventListener("click", click);
    const resize = () => {
      this.compositor.resize();
      this.ink.layout(this.compositor.box());
    };
    win.addEventListener("resize", resize);
    this.offs.push(
      () => container.removeEventListener("click", click),
      () => win.removeEventListener("resize", resize),
    );
  }

  /** The frame scale for a slide at this surface's size. */
  scale(slide: ShowSlide): number {
    return frameScale(
      slide.sizePt,
      {
        width: this.container.clientWidth || this.win.innerWidth,
        height: this.container.clientHeight || this.win.innerHeight,
      },
      this.win.devicePixelRatio || 1,
    );
  }

  update(v: ViewSnapshot, next: ShowSlide | null = null): void {
    const el = this.container;
    el.dataset.slideIndex = String(v.index);
    el.dataset.slideNumber = v.slide ? String(v.slide.number) : "";
    el.dataset.pageId = v.slide?.pageId ?? "";
    el.dataset.blank = v.blank ?? "";
    el.dataset.ended = v.ended ? "true" : "false";
    this.end.style.display = v.ended ? "block" : "none";
    this.compositor.blank(v.ended ? "black" : v.blank);
    const slide = v.slide;
    if (!slide) {
      this.shown = null;
      this.ink.setStrokes([]);
      return;
    }
    const [w, h] = slide.sizePt;
    const aspect = h > 0 ? w / h : 16 / 9;
    if (slide.pageId !== this.shown || v.advanced) {
      this.shown = slide.pageId;
      const seq = ++this.seq;
      const scale = this.scale(slide);
      void this.opts.frames.frame(slide.pageId, scale).then((f) => {
        if (seq !== this.seq) return;
        this.compositor.show(f, aspect, v.advanced ? slide.transition : null);
        this.ink.layout(this.compositor.box());
        el.dataset.frame = f ? "drawn" : "none";
      });
      if (next) this.opts.frames.prefetch(next.pageId, this.scale(next));
    }
    this.ink.setStrokes(v.strokes);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.compositor.dispose();
    this.ink.dispose();
    this.end.remove();
  }
}

// ---------------------------------------------------------- the grid

/** The slide grid (G): every slide as a thumbnail, the picked one
 *  outlined; a click jumps to it. */
export function renderGrid(
  overlay: HTMLElement,
  s: ShowState,
  thumbnail: (pageId: string) => string | null,
  onPick: (index: number) => void,
): void {
  overlay.replaceChildren();
  if (s.grid === null) {
    overlay.style.display = "none";
    return;
  }
  const doc = overlay.ownerDocument;
  Object.assign(overlay.style, {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "16px",
    padding: "32px",
    alignContent: "start",
    overflow: "auto",
    background: "rgba(20,20,20,.96)",
  });
  s.slides.forEach((slide, i) => {
    const cell = doc.createElement("button");
    cell.type = "button";
    cell.setAttribute("data-show-grid-cell", String(i));
    cell.title = t(SHOW.goTo, { number: slide.number });
    Object.assign(cell.style, {
      padding: "0",
      border: i === s.grid ? "3px solid #e0218a" : "3px solid transparent",
      background: "#333",
      color: "#ccc",
      cursor: "pointer",
      opacity: slide.hidden ? "0.5" : "1",
      aspectRatio: `${slide.sizePt[0]} / ${slide.sizePt[1]}`,
      position: "relative",
    });
    const url = thumbnail(slide.pageId);
    if (url) {
      const img = doc.createElement("img");
      img.src = url;
      img.alt = "";
      Object.assign(img.style, {
        width: "100%",
        height: "100%",
        display: "block",
      });
      cell.appendChild(img);
    }
    const num = doc.createElement("span");
    num.textContent = String(slide.number);
    Object.assign(num.style, {
      position: "absolute",
      left: "4px",
      bottom: "2px",
      font: "12px system-ui, sans-serif",
      textShadow: "0 0 3px #000",
    });
    cell.appendChild(num);
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(i);
    });
    overlay.appendChild(cell);
  });
}

// ------------------------------------------------------- the surfaces

/** A key event as the show reads it. */
export const keyOf = (e: KeyboardEvent) => ({
  key: e.key,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
});

export interface ShowSurfaceDeps {
  frames: FrameSource;
  thumbnail(pageId: string): string | null;
  /** The show is over: leave the presentation. */
  exit(): void;
}

/** The single-screen show: the slide, keys, the grid, the pointer tools. */
export function mountShow(
  el: HTMLElement,
  win: Window,
  ctl: ShowController,
  deps: ShowSurfaceDeps,
): () => void {
  const doc = el.ownerDocument;
  const stage = doc.createElement("div");
  stage.setAttribute("data-show-stage", "show");
  Object.assign(stage.style, { position: "absolute", inset: "0" });
  el.appendChild(stage);
  const view = new ShowView(stage, win, {
    frames: deps.frames,
    interactive: true,
    onStroke: (pageId, s) => ctl.addStroke(pageId, s),
    onClick: () => {
      if (ctl.state().tool === "arrow") ctl.dispatch({ type: "next" });
    },
  });
  const grid = doc.createElement("div");
  grid.setAttribute("data-show-grid", "");
  Object.assign(grid.style, {
    position: "absolute",
    inset: "0",
    display: "none",
  });
  el.appendChild(grid);
  const status = doc.createElement("div");
  status.setAttribute("data-show-typed", "");
  Object.assign(status.style, {
    position: "absolute",
    right: "16px",
    bottom: "12px",
    font: "14px system-ui, sans-serif",
    color: "#ccc",
  });
  el.appendChild(status);

  const draw = (s: ShowState, prev: ShowState) => {
    view.update(ctl.snapshot(prev), upNext(s));
    view.ink.setTool(s.tool);
    status.textContent = ctl.rehearse
      ? t(SHOW.recording, {
          time: clock(ctl.onSlideMs()),
          total: clock(ctl.showMs()),
        })
      : s.typed;
    renderGrid(grid, s, deps.thumbnail, (i) =>
      ctl.dispatch({ type: "goto", index: i }),
    );
    if (s.done) deps.exit();
  };
  const off = ctl.subscribe(draw);
  draw(ctl.state(), ctl.state());

  const onKey = (e: KeyboardEvent) => {
    if (ctl.key(keyOf(e))) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  el.addEventListener("keydown", onKey);
  const tick = ctl.rehearse
    ? win.setInterval(() => draw(ctl.state(), ctl.state()), 1000)
    : 0;
  return () => {
    if (tick) win.clearInterval(tick);
    el.removeEventListener("keydown", onKey);
    off();
    view.dispose();
    stage.remove();
    grid.remove();
    status.remove();
  };
}

/** The audience window: what the console sends, drawn; its keys go back
 *  to the console. */
export function mountAudience(
  el: HTMLElement,
  win: Window,
  channel: {
    post(m: unknown): void;
    onMessage(h: (m: unknown) => void): { dispose(): void };
  },
  frames: FrameSource,
): () => void {
  const doc = el.ownerDocument;
  const stage = doc.createElement("div");
  stage.setAttribute("data-show-stage", "audience");
  Object.assign(stage.style, { position: "absolute", inset: "0" });
  el.appendChild(stage);
  const view = new ShowView(stage, win, {
    frames,
    interactive: false,
    onClick: () => channel.post({ t: "advance" } satisfies ShowMessage),
  });
  const sub = channel.onMessage((m) => {
    const msg = m as ShowMessage;
    if (msg.t === "snapshot") view.update(msg.snapshot);
    else if (msg.t === "laser") view.ink.laser(msg.at);
  });
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    channel.post({ t: "key", ...keyOf(e) } satisfies ShowMessage);
  };
  el.addEventListener("keydown", onKey);
  channel.post({ t: "ready" } satisfies ShowMessage);
  return () => {
    el.removeEventListener("keydown", onKey);
    sub.dispose();
    view.dispose();
    stage.remove();
  };
}

/** `m:ss` (or `h:mm:ss`) of a duration in ms. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
