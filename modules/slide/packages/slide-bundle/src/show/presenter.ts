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

// The presenter view (slide ADR 716, Alt+F5): the console in the editor's
// window — the slide up (with the pen and the laser), the next slide, the
// speaker notes with their own zoom, a timer that pauses and resets, the
// clock, "Slide x of y", the slide grid and a black screen — while the
// audience window shows the slide alone. The console owns the show: every
// change goes to the audience as a snapshot over the presentation's
// channel, and a key pressed in the audience window comes back here.
// Without an audience window (refused, or asked for one screen) the
// console runs alone.

import { t } from "@paged-media/strings";

import { SHOW } from "../messages.js";
import type { Player } from "./animation.js";
import type { FrameSource, SceneSource } from "./frames.js";
import type { SlideScene } from "./scene-source.js";
import {
  current,
  position,
  upNext,
  type ShowSlide,
  type ShowState,
} from "./show-model.js";
import {
  clock,
  keyOf,
  renderGrid,
  ShowView,
  type ShowController,
  type ShowMessage,
} from "./slide-show.js";

export interface ConsoleDeps {
  frames: FrameSource;
  scenes?: SceneSource;
  player?(slide: ShowSlide, scene: SlideScene): Promise<Player | null>;
  thumbnail(pageId: string): string | null;
  /** Re-render when a thumbnail lands. */
  subscribeThumbnails(fn: () => void): () => void;
  channel: {
    post(m: unknown): void;
    onMessage(h: (m: unknown) => void): { dispose(): void };
  };
  /** An audience window is showing the slides. */
  audience: boolean;
  exit(): void;
  now?: () => number;
}

const button = (
  doc: Document,
  id: string,
  label: string,
  text: string,
): HTMLButtonElement => {
  const b = doc.createElement("button");
  b.type = "button";
  b.setAttribute("data-presenter", id);
  b.title = label;
  b.setAttribute("aria-label", label);
  b.textContent = text;
  Object.assign(b.style, {
    background: "#2a2a2a",
    color: "#eee",
    border: "1px solid #444",
    borderRadius: "6px",
    padding: "6px 12px",
    font: "13px system-ui, sans-serif",
    cursor: "pointer",
  });
  return b;
};

export function mountConsole(
  el: HTMLElement,
  win: Window,
  ctl: ShowController,
  deps: ConsoleDeps,
): () => void {
  const doc = el.ownerDocument;
  const now = deps.now ?? (() => Date.now());
  const root = doc.createElement("div");
  root.setAttribute("data-presenter-view", "");
  Object.assign(root.style, {
    position: "absolute",
    inset: "0",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    gap: "12px",
    padding: "12px 16px",
    background: "#111",
    color: "#eee",
    font: "14px system-ui, sans-serif",
    boxSizing: "border-box",
  });
  el.appendChild(root);

  // ---- header: timer, position, clock
  const header = doc.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  });
  const timer = doc.createElement("span");
  timer.setAttribute("data-presenter", "timer");
  Object.assign(timer.style, {
    fontSize: "22px",
    fontVariantNumeric: "tabular-nums",
  });
  const pause = button(doc, "pause", t(SHOW.pause), "❚❚");
  const reset = button(doc, "reset", t(SHOW.reset), "↺");
  const where = doc.createElement("span");
  where.setAttribute("data-presenter", "position");
  Object.assign(where.style, { flex: "1", textAlign: "center" });
  const wall = doc.createElement("span");
  wall.setAttribute("data-presenter", "clock");
  Object.assign(wall.style, {
    fontSize: "22px",
    fontVariantNumeric: "tabular-nums",
  });
  header.append(timer, pause, reset, where, wall);

  // ---- body: the slide up, and the next slide with the notes
  const body = doc.createElement("div");
  Object.assign(body.style, {
    display: "grid",
    gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
    gap: "16px",
    minHeight: "0",
  });
  const stage = doc.createElement("div");
  stage.setAttribute("data-show-stage", "console");
  Object.assign(stage.style, {
    position: "relative",
    minHeight: "0",
    background: "#000",
  });
  const side = doc.createElement("div");
  Object.assign(side.style, {
    display: "grid",
    gridTemplateRows: "auto auto auto minmax(0, 1fr)",
    gap: "8px",
    minHeight: "0",
  });
  const nextLabel = doc.createElement("div");
  nextLabel.textContent = t(SHOW.next);
  Object.assign(nextLabel.style, { opacity: "0.7" });
  const nextBox = doc.createElement("div");
  nextBox.setAttribute("data-presenter", "next-preview");
  Object.assign(nextBox.style, {
    aspectRatio: "16 / 9",
    background: "#222",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#999",
  });
  const notesBar = doc.createElement("div");
  Object.assign(notesBar.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  });
  const notesLabel = doc.createElement("span");
  notesLabel.textContent = t(SHOW.notes);
  Object.assign(notesLabel.style, { flex: "1", opacity: "0.7" });
  const smaller = button(doc, "notes-smaller", t(SHOW.zoomOut), "A−");
  const larger = button(doc, "notes-larger", t(SHOW.zoomIn), "A+");
  notesBar.append(notesLabel, smaller, larger);
  const notes = doc.createElement("div");
  notes.setAttribute("data-presenter", "notes");
  Object.assign(notes.style, {
    overflow: "auto",
    whiteSpace: "pre-wrap",
    lineHeight: "1.4",
    background: "#1a1a1a",
    padding: "10px",
    borderRadius: "6px",
  });
  side.append(nextLabel, nextBox, notesBar, notes);
  body.append(stage, side);

  // ---- footer: navigation and tools
  const footer = doc.createElement("div");
  Object.assign(footer.style, {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
  });
  const prev = button(doc, "prev", t(SHOW.previousSlide), "◀");
  const next = button(doc, "next", t(SHOW.nextSlide), "▶");
  const black = button(doc, "black", t(SHOW.black), t(SHOW.black));
  const gridButton = button(doc, "grid", t(SHOW.grid), t(SHOW.grid));
  const laser = button(doc, "laser", t(SHOW.laser), t(SHOW.laser));
  const pen = button(doc, "pen", t(SHOW.pen), t(SHOW.pen));
  const erase = button(doc, "erase", t(SHOW.erase), t(SHOW.erase));
  const end = button(doc, "end", t(SHOW.end), t(SHOW.end));
  const notice = doc.createElement("span");
  notice.setAttribute("data-presenter", "notice");
  Object.assign(notice.style, {
    alignSelf: "center",
    opacity: "0.7",
    fontSize: "12px",
  });
  if (!deps.audience) notice.textContent = t(SHOW.noAudience);
  footer.append(prev, next, black, gridButton, laser, pen, erase, end, notice);
  root.append(header, body, footer);

  const grid = doc.createElement("div");
  grid.setAttribute("data-show-grid", "");
  Object.assign(grid.style, {
    position: "absolute",
    inset: "0",
    display: "none",
  });
  el.appendChild(grid);

  const view = new ShowView(stage, win, {
    frames: deps.frames,
    scenes: deps.scenes,
    player: deps.player,
    interactive: true,
    onClick: (trigger) => {
      if (ctl.state().tool !== "arrow") return;
      if (trigger) ctl.trigger(trigger);
      else ctl.dispatch({ type: "next" });
    },
    onStroke: (pageId, s) => ctl.addStroke(pageId, s),
    onLaser: (at) =>
      deps.channel.post({ t: "laser", at } satisfies ShowMessage),
  });

  // ---- the timer
  let started = now();
  let pausedAt: number | null = null;
  const elapsed = () => (pausedAt ?? now()) - started;
  const tick = () => {
    timer.textContent = clock(elapsed());
    const d = new Date(now());
    wall.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  pause.addEventListener("click", () => {
    if (pausedAt === null) {
      pausedAt = now();
      pause.textContent = "▶";
      pause.title = t(SHOW.resume);
    } else {
      started += now() - pausedAt;
      pausedAt = null;
      pause.textContent = "❚❚";
      pause.title = t(SHOW.pause);
    }
    tick();
  });
  reset.addEventListener("click", () => {
    started = now();
    if (pausedAt !== null) pausedAt = started;
    tick();
  });
  const interval = win.setInterval(tick, 500);

  // ---- notes zoom
  let notesPx = 18;
  const zoom = (by: number) => {
    notesPx = Math.max(10, Math.min(48, notesPx + by));
    notes.style.fontSize = `${notesPx}px`;
  };
  zoom(0);
  smaller.addEventListener("click", () => zoom(-2));
  larger.addEventListener("click", () => zoom(2));

  // ---- navigation
  prev.addEventListener("click", () => ctl.dispatch({ type: "prev" }));
  next.addEventListener("click", () => ctl.dispatch({ type: "next" }));
  black.addEventListener("click", () =>
    ctl.dispatch({ type: "blank", color: "black" }),
  );
  gridButton.addEventListener("click", () => ctl.dispatch({ type: "grid" }));
  laser.addEventListener("click", () =>
    ctl.dispatch({ type: "tool", tool: "laser" }),
  );
  pen.addEventListener("click", () =>
    ctl.dispatch({ type: "tool", tool: "pen" }),
  );
  erase.addEventListener("click", () => ctl.dispatch({ type: "erase" }));
  end.addEventListener("click", () => ctl.dispatch({ type: "exit" }));

  const drawNext = (s: ShowState) => {
    const up = upNext(s);
    nextBox.replaceChildren();
    nextBox.dataset.pageId = up?.pageId ?? "";
    const url = up ? deps.thumbnail(up.pageId) : null;
    if (url) {
      const img = doc.createElement("img");
      img.src = url;
      img.alt = "";
      Object.assign(img.style, {
        maxWidth: "100%",
        maxHeight: "100%",
        display: "block",
      });
      nextBox.appendChild(img);
    } else if (!up) {
      nextBox.textContent = t(SHOW.endPreview);
    }
  };

  const draw = (s: ShowState, prevState: ShowState) => {
    const snap = ctl.snapshot(prevState);
    view.update(snap, upNext(s));
    view.ink.setTool(s.tool);
    const slide = current(s);
    const { at, of } = position(s);
    where.textContent = t(SHOW.slideOf, { at, of });
    root.dataset.slideIndex = String(s.index);
    notes.textContent = slide ? slide.notes || t(SHOW.noNotes) : "";
    black.setAttribute("aria-pressed", String(s.blank === "black"));
    laser.setAttribute("aria-pressed", String(s.tool === "laser"));
    pen.setAttribute("aria-pressed", String(s.tool === "pen"));
    drawNext(s);
    renderGrid(grid, s, deps.thumbnail, (i) =>
      ctl.dispatch({ type: "goto", index: i }),
    );
    deps.channel.post({ t: "snapshot", snapshot: snap } satisfies ShowMessage);
    if (s.done) deps.exit();
  };
  const off = ctl.subscribe(draw);
  const offThumbs = deps.subscribeThumbnails(() => drawNext(ctl.state()));
  const sub = deps.channel.onMessage((m) => {
    const msg = m as ShowMessage;
    if (msg.t === "ready")
      deps.channel.post({
        t: "snapshot",
        snapshot: ctl.snapshot(),
      } satisfies ShowMessage);
    else if (msg.t === "key") ctl.key(msg);
    else if (msg.t === "advance") {
      if (ctl.state().tool === "arrow") ctl.dispatch({ type: "next" });
    } else if (msg.t === "trigger") {
      if (ctl.state().tool === "arrow") ctl.trigger(msg.target);
    }
  });
  draw(ctl.state(), ctl.state());
  tick();

  const onKey = (e: KeyboardEvent) => {
    if (ctl.key(keyOf(e))) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  el.addEventListener("keydown", onKey);
  return () => {
    win.clearInterval(interval);
    el.removeEventListener("keydown", onKey);
    off();
    offThumbs();
    sub.dispose();
    view.dispose();
    root.remove();
    grid.remove();
  };
}
