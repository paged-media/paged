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

// Video and audio in the show (slide ADR 718, extensions ADR 345, amendment 1): each
// medium of the slide up plays in an HTML `<video>` / `<audio>` element of
// the presentation surface, laid over its frame. The engine drew the
// poster into the slide; the element is shown while the medium plays (and
// keeps its last frame once played, as PowerPoint does, unless it rewinds).
// A medium starts at its build step (0: with the slide) or when it is
// clicked; a click on a playing medium pauses it and another resumes it.
// Trim, loop, volume and fades are the medium's. Leaving the slide stops
// every medium.

import type { MediaItem, MediaRead } from "@paged-media/plugin-api";

import type { MediaReader, ShowMedia } from "../media.js";
import type { ShowSlide } from "./show-model.js";

/** The page area the slide is drawn in, CSS px of the container. */
export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Playing {
  m: ShowMedia;
  el: HTMLMediaElement;
  url: string | null;
  started: boolean;
  /** Played to its end (and not looping). */
  done: boolean;
}

const num = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** The volume a medium plays at `t` s of its own timeline: its volume,
 *  faded in from its trimmed start and out towards its trimmed end. */
export function volumeAt(m: MediaItem, t: number, duration: number): number {
  const v = Math.min(1, Math.max(0, m.volume ?? 1));
  const start = num(m.trimStartMs) / 1000;
  const end = duration - num(m.trimEndMs) / 1000;
  let k = 1;
  const fin = num(m.fadeInMs) / 1000;
  const fout = num(m.fadeOutMs) / 1000;
  if (fin > 0) k = Math.min(k, Math.max(0, (t - start) / fin));
  if (fout > 0 && Number.isFinite(end))
    k = Math.min(k, Math.max(0, (end - t) / fout));
  return v * k;
}

export class MediaPlayer {
  private playing: Playing[] = [];
  private slide: ShowSlide | null = null;
  private step = 0;
  private seq = 0;
  private readonly timers = new Set<number>();
  private readonly layer: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly win: Window,
    private readonly read: MediaReader,
    private readonly box: () => StageBox,
  ) {
    const doc = container.ownerDocument;
    this.layer = doc.createElement("div");
    this.layer.setAttribute("data-show-media", "");
    Object.assign(this.layer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
    });
    container.appendChild(this.layer);
  }

  /** The media elements of the slide up (tests). */
  elements(): HTMLMediaElement[] {
    return this.playing.map((p) => p.el);
  }

  /** A slide comes up at build step `step` (null: none, the end screen). */
  show(slide: ShowSlide | null, step = 0): void {
    this.stopAll();
    this.slide = slide;
    this.step = step;
    const seq = ++this.seq;
    const list = slide?.media ?? [];
    if (list.length === 0) return;
    const doc = this.layer.ownerDocument;
    for (const m of list) {
      const el = doc.createElement(
        m.media.kind === "sound" ? "audio" : "video",
      ) as HTMLMediaElement;
      el.setAttribute("data-show-media-item", String(m.element.id));
      el.setAttribute("data-media-state", "loading");
      el.preload = "auto";
      if ("playsInline" in el) (el as HTMLVideoElement).playsInline = true;
      el.controls = m.media.showControls === true;
      el.loop = false; // the loop honours the trim: see `tick`
      Object.assign(el.style, {
        position: "absolute",
        visibility: "hidden",
        objectFit: "fill",
        background: "transparent",
        pointerEvents: "none",
      });
      this.layer.appendChild(el);
      const p: Playing = { m, el, url: null, started: false, done: false };
      this.playing.push(p);
      el.addEventListener("timeupdate", () => this.tick(p));
      el.addEventListener("ended", () => this.finish(p));
      void this.read(m.element).then((r) => {
        if (seq !== this.seq) return;
        this.load(p, r);
      });
    }
    this.layout();
  }

  /** The build step advanced (or went back). */
  setStep(step: number): void {
    const prev = this.step;
    this.step = step;
    for (const p of this.playing) {
      if (p.m.step === null) continue;
      if (step < p.m.step && p.started) this.reset(p);
      else if (step >= p.m.step && prev < p.m.step) this.schedule(p);
    }
  }

  /** A click at a page point (pt): the medium under it plays or pauses.
   *  True when a medium took the click. */
  click(x: number, y: number): boolean {
    for (const p of [...this.playing].reverse()) {
      const b = p.m.box;
      if (p.m.media.kind === "sound" && p.m.media.hideWhileNotPlaying) continue;
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
      if (!p.started || p.el.paused) {
        if (p.done) this.reset(p);
        this.start(p);
      } else p.el.pause();
      return true;
    }
    return false;
  }

  /** Lay the elements over their frames. */
  layout(): void {
    const s = this.slide;
    if (!s) return;
    const b = this.box();
    const k = b.width / (s.sizePt[0] || 1);
    if (!(k > 0)) return;
    for (const p of this.playing) {
      if (p.m.media.kind === "sound") continue;
      const full = p.m.media.fullScreen === true && p.started && !p.done;
      const r = full
        ? { x: b.x, y: b.y, w: b.width, h: b.height }
        : {
            x: b.x + p.m.box.x * k,
            y: b.y + p.m.box.y * k,
            w: p.m.box.w * k,
            h: p.m.box.h * k,
          };
      Object.assign(p.el.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
      });
    }
  }

  /** Stop and drop every medium (the slide is left). */
  stopAll(): void {
    this.seq++;
    for (const t of this.timers) this.win.clearTimeout(t);
    this.timers.clear();
    for (const p of this.playing) {
      try {
        p.el.pause();
      } catch {
        // a detached element
      }
      p.el.removeAttribute("src");
      p.el.remove();
      if (p.url) this.realm().URL.revokeObjectURL(p.url);
    }
    this.playing = [];
  }

  /** The surface window's globals (its own Blob and URL: a blob URL lives
   *  in the window that made it). */
  private realm(): typeof globalThis {
    return this.win as unknown as typeof globalThis;
  }

  dispose(): void {
    this.stopAll();
    this.layer.remove();
  }

  private load(p: Playing, r: MediaRead | null): void {
    let src: string | null = null;
    if (r?.bytes && r.bytes.length > 0) {
      p.url = this.realm().URL.createObjectURL(
        new (this.realm().Blob)([r.bytes as Uint8Array<ArrayBuffer>], {
          type: p.m.media.mime ?? "",
        }),
      );
      src = p.url;
    } else if (r?.url) src = r.url;
    if (!src) {
      p.el.setAttribute("data-media-state", "missing");
      return;
    }
    p.el.src = src;
    p.el.volume = volumeAt(p.m.media, 0, Number.POSITIVE_INFINITY);
    const start = num(p.m.media.trimStartMs) / 1000;
    const seek = () => {
      if (start > 0) p.el.currentTime = start;
    };
    if (p.el.readyState >= 1) seek();
    else p.el.addEventListener("loadedmetadata", seek, { once: true });
    p.el.setAttribute("data-media-state", "ready");
    if (p.m.step !== null && this.step >= p.m.step) this.schedule(p);
  }

  private schedule(p: Playing): void {
    if (p.m.beginMs <= 0) {
      this.start(p);
      return;
    }
    const t = this.win.setTimeout(() => {
      this.timers.delete(t);
      this.start(p);
    }, p.m.beginMs);
    this.timers.add(t);
  }

  private start(p: Playing): void {
    if (!p.el.src && !p.el.currentSrc) return;
    p.started = true;
    p.done = false;
    if (p.m.media.kind !== "sound") p.el.style.visibility = "visible";
    p.el.setAttribute("data-media-state", "playing");
    this.layout();
    const play = p.el.play();
    // A window that never saw a gesture (the audience window) may refuse
    // sound: play it muted rather than not at all.
    void play?.catch?.(() => {
      p.el.muted = true;
      void p.el.play()?.catch?.(() => {
        p.el.setAttribute("data-media-state", "blocked");
      });
    });
  }

  private tick(p: Playing): void {
    const d = p.el.duration;
    const t = p.el.currentTime;
    const end = Number.isFinite(d) ? d - num(p.m.media.trimEndMs) / 1000 : Infinity;
    p.el.volume = volumeAt(p.m.media, t, Number.isFinite(d) ? d : Infinity);
    if (t >= end - 0.02) this.finish(p);
  }

  private finish(p: Playing): void {
    if (!p.started) return;
    if (p.m.media.loop) {
      p.el.currentTime = num(p.m.media.trimStartMs) / 1000;
      void p.el.play()?.catch?.(() => undefined);
      return;
    }
    p.el.pause();
    p.done = true;
    p.el.setAttribute("data-media-state", "ended");
    if (p.m.media.rewind) p.el.currentTime = num(p.m.media.trimStartMs) / 1000;
    if (p.m.media.hideWhileNotPlaying || p.m.media.rewind)
      p.el.style.visibility = "hidden";
    this.layout();
  }

  private reset(p: Playing): void {
    p.el.pause();
    p.started = false;
    p.done = false;
    p.el.currentTime = num(p.m.media.trimStartMs) / 1000;
    p.el.style.visibility = "hidden";
    p.el.setAttribute("data-media-state", "ready");
  }
}
