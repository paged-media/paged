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

// An animated slide's layers, drawn (slide ADR 714): one
// `host.render.layers` call for the background, the animated items and the
// text frames built by paragraph (extensions ADR 346 and its C4
// amendment), and one transparent snapshot per run of static items that
// sits above an animated one. Decoded once per page and scale; the show
// prefetches the next slide's, so a slide change waits for nothing.

import type {
  BundleHost,
  RenderRect,
  RenderedLayer,
} from "@paged-media/plugin-api";

import type { Box } from "../anim/model.js";
import { idOf } from "../anim/shapes.js";
import type { Frame } from "./frames.js";
import type { LayerPart, ScenePlan } from "./scene.js";

/** One drawn layer, bottom first. */
export interface SceneLayer {
  image: Frame;
  /** The page area the image covers, pt. */
  region: RenderRect;
  /** The animated target it belongs to (null: a static run). */
  target: string | null;
  part: LayerPart | null;
}

export interface SlideScene {
  pageId: string;
  scale: number;
  sizePt: [number, number];
  background: Frame;
  layers: SceneLayer[];
  /** Each layer key's box (the plan's, and each paragraph's region). */
  boxes: Record<string, Box>;
}

const decode = async (l: RenderedLayer): Promise<Frame | null> => {
  if (l.bitmap) return l.bitmap;
  if (l.png && typeof createImageBitmap === "function")
    return createImageBitmap(
      new Blob([l.png as Uint8Array<ArrayBuffer>], { type: "image/png" }),
    );
  return null;
};

/** Draw `plan` at `scale`; null when the page cannot be drawn. */
export async function drawScene(
  host: BundleHost,
  plan: ScenePlan,
  scale: number,
  sizePt: [number, number],
): Promise<SlideScene | null> {
  if (!host.supports("render.layers@1")) return null;
  const items = plan.entries.flatMap((e) =>
    e.kind === "item" ? [e.item.id] : [],
  );
  const paraFrames = plan.entries.flatMap((e) =>
    e.kind === "paragraphs" ? [e.item.id] : [],
  );
  const withParagraphs = host.supports("render.layers.paragraphs@1");
  const out = await host.render.layers(plan.pageId, {
    scale,
    format: "bitmap",
    items: withParagraphs ? items : [...items, ...paraFrames],
    hideItems: plan.hide,
    ...(withParagraphs && paraFrames.length > 0
      ? { paragraphs: paraFrames }
      : {}),
  });
  if (!out) return null;
  const background = await decode(out.background);
  if (!background) return null;
  const byItem = new Map(
    out.items.map((l) => [l.id ? idOf(l.id) : "", l] as const),
  );
  const paras = new Map<string, RenderedLayer[]>();
  for (const l of out.paragraphs ?? []) {
    const k = l.id ? idOf(l.id) : "";
    paras.set(k, [...(paras.get(k) ?? []), l]);
  }
  const layers: SceneLayer[] = [];
  const boxes: Record<string, Box> = { ...plan.boxes };
  for (const e of plan.entries) {
    if (e.kind === "static") {
      const shot = await host.render.snapshot(plan.pageId, {
        dpi: scale * 72,
        only: e.items.map((i) => i.id),
        background: "transparent",
        trim: true,
      });
      if (!shot?.region || typeof createImageBitmap !== "function") continue;
      const image = await createImageBitmap(
        new Blob([shot.png as Uint8Array<ArrayBuffer>], { type: "image/png" }),
      );
      layers.push({ image, region: shot.region, target: null, part: null });
      continue;
    }
    const id = idOf(e.item.id);
    if (e.kind === "paragraphs" && withParagraphs) {
      for (const l of paras.get(id) ?? []) {
        const image = await decode(l);
        if (!image || l.paragraph === undefined) continue;
        layers.push({
          image,
          region: l.region,
          target: e.target,
          part: { paragraph: l.paragraph },
        });
        boxes[`${e.target}#p${l.paragraph}`] = {
          x: l.region.x,
          y: l.region.y,
          w: l.region.width,
          h: l.region.height,
        };
      }
      continue;
    }
    const l = byItem.get(id);
    if (!l) continue;
    const image = await decode(l);
    if (!image) continue;
    layers.push({
      image,
      region: l.region,
      target: e.target,
      // A frame built by paragraph on a host without paragraph layers
      // plays as the whole frame (every paragraph at the first one's
      // build).
      part: e.kind === "paragraphs" ? { paragraph: 0 } : e.part,
    });
  }
  return {
    pageId: plan.pageId,
    scale,
    sizePt,
    background,
    layers,
    boxes,
  };
}

/** Release a scene's images. */
export function closeScene(s: SlideScene): void {
  s.background.close?.();
  for (const l of s.layers) l.image.close?.();
}
