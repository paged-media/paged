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

// The slide show's frames (slide ADR 716): each slide as a decoded image at
// the screen's resolution, through the host's page layers (extensions ADR
// 346). For now the whole slide is the background layer; animated items
// become layers of their own with the animations (wave 5). The pages are
// drawn as the exports draw them, without the editor's markers (the pink
// highlight behind text in a substitute face), because a snapshot never
// asks for them (engine ADR 205).
//
// Frames are cached per page and scale and prefetched one slide ahead, so
// an advance shows a frame that is already decoded.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import type { ShowSlide } from "./show-model.js";
import { closeScene, drawScene, type SlideScene } from "./scene-source.js";

/** A decoded frame: an ImageBitmap in a browser. */
export type Frame = ImageBitmap;

export interface FrameSource {
  /** The page as a frame at `scale` pixels per pt; null when the page is
   *  unknown or nothing could be drawn. */
  frame(
    pageId: string,
    scale: number,
    hide?: readonly string[],
  ): Promise<Frame | null>;
  /** Start drawing a frame that will be needed soon. */
  prefetch(pageId: string, scale: number, hide?: readonly string[]): void;
  /** Drop every cached frame (the document changed). */
  clear(): void;
  dispose(): void;
}

/** How many frames are kept: the current, the next, the previous, and a
 *  few a jump visited. */
const KEEP = 12;

/** Scales are rounded to quarter steps so the console and the audience
 *  share frames when their screens are alike. */
export function frameScale(
  sizePt: readonly [number, number],
  box: { width: number; height: number },
  dpr = 1,
): number {
  const [w, h] = sizePt;
  if (!(w > 0 && h > 0) || !(box.width > 0 && box.height > 0)) return 1;
  const raw = Math.min(box.width / w, box.height / h) * dpr;
  return Math.max(0.25, Math.min(4, Math.ceil(raw * 4) / 4));
}

export function createFrameSource(host: BundleHost): FrameSource {
  const cache = new Map<string, Promise<Frame | null>>();
  const settled = new Map<string, Frame>();

  const draw = async (
    pageId: string,
    scale: number,
    hide: readonly string[],
  ): Promise<Frame | null> => {
    if (typeof createImageBitmap !== "function") return null;
    if (host.supports("render.layers@1")) {
      const out = await host.render.layers(pageId, {
        scale,
        format: "bitmap",
        // Media hidden while they do not play (slide ADR 718).
        ...(hide.length > 0
          ? {
              hideItems: hide.map(
                (id) => ({ kind: "rectangle", id }) as unknown as ElementId,
              ),
            }
          : {}),
      });
      return out?.background.bitmap ?? null;
    }
    if (!host.supports("render.snapshot@1")) return null;
    const shot = await host.render.snapshot(pageId, { dpi: scale * 72 });
    if (!shot) return null;
    return createImageBitmap(
      new Blob([shot.png as Uint8Array<ArrayBuffer>], { type: "image/png" }),
    );
  };

  const evict = () => {
    while (cache.size > KEEP) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
      settled.get(oldest)?.close();
      settled.delete(oldest);
    }
  };

  const frame = (
    pageId: string,
    scale: number,
    hide: readonly string[] = [],
  ): Promise<Frame | null> => {
    const key = `${pageId}@${scale}${hide.length > 0 ? `-${hide.join(",")}` : ""}`;
    const hit = cache.get(key);
    if (hit) {
      // Most recently used goes last.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const job = draw(pageId, scale, hide)
      .then((f) => {
        if (f && cache.get(key) === job) settled.set(key, f);
        return f;
      })
      .catch(() => null);
    cache.set(key, job);
    evict();
    return job;
  };

  return {
    frame,
    prefetch(pageId, scale, hide) {
      void frame(pageId, scale, hide);
    },
    clear() {
      for (const f of settled.values()) f.close();
      settled.clear();
      cache.clear();
    },
    dispose() {
      this.clear();
    },
  };
}

/** Animated slides' layers (slide ADR 714), cached per page and scale and
 *  prefetched like the frames. */
export interface SceneSource {
  scene(slide: ShowSlide, scale: number): Promise<SlideScene | null>;
  prefetch(slide: ShowSlide, scale: number): void;
  clear(): void;
  dispose(): void;
}

export function createSceneSource(host: BundleHost): SceneSource {
  const cache = new Map<string, Promise<SlideScene | null>>();
  const settled = new Map<string, SlideScene>();
  const evict = () => {
    while (cache.size > KEEP) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
      const s = settled.get(oldest);
      if (s) closeScene(s);
      settled.delete(oldest);
    }
  };
  const scene = (slide: ShowSlide, scale: number) => {
    const key = `${slide.pageId}@${scale}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const plan = slide.anim?.plan;
    const job: Promise<SlideScene | null> = plan
      ? drawScene(host, plan, scale, slide.sizePt)
          .then((s) => {
            if (s && cache.get(key) === job) settled.set(key, s);
            return s;
          })
          .catch(() => null)
      : Promise.resolve(null);
    cache.set(key, job);
    evict();
    return job;
  };
  return {
    scene,
    prefetch(slide, scale) {
      if (slide.anim) void scene(slide, scale);
    },
    clear() {
      for (const s of settled.values()) closeScene(s);
      settled.clear();
      cache.clear();
    },
    dispose() {
      this.clear();
    },
  };
}
