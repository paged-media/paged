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

// Preview on the canvas (slide ADR 714): the Animations pane's Preview
// plays the active slide's animations over the slide in the editor, as
// PowerPoint's does: every click step in turn, each when the one before has
// finished, then the slide as it was. Drawn with the show's own layers and
// player, by the Canvas2D compositor, in an overlay over the page.

import type {
  BundleHost,
  OverlayContribution,
  OverlayProps,
} from "@paged-media/plugin-api";
import * as React from "react";

import type { SlideEngine } from "../engine.js";
import { SlideAnimation } from "../show/animation.js";
import { attachAnimations, playerFor } from "../show/contribute.js";
import { drawScene2d } from "../show/scene-2d.js";
import { closeScene, drawScene } from "../show/scene-source.js";
import type { ShowSlide } from "../show/show-model.js";
import type { SlidesStore } from "../slides-model.js";

export const PREVIEW_OVERLAY_ID = "media.paged.slide.overlay.animationPreview";

type Listener = () => void;

/** Which slide previews, and from when (a fresh run each start). */
export class PreviewModel {
  private state: { pageId: string; run: number } | null = null;
  private runs = 0;
  private readonly listeners = new Set<Listener>();

  start(pageId: string): void {
    this.state = { pageId, run: ++this.runs };
    this.emit();
  }

  stop(): void {
    if (!this.state) return;
    this.state = null;
    this.emit();
  }

  snapshot = (): { pageId: string; run: number } | null => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}

/** Play one slide's animations onto `canvas` (page pt mapped onto it),
 *  every step after the last; resolves when they are done or `signal`
 *  stops them. */
export async function playPreview(
  host: BundleHost,
  engine: () => Promise<SlideEngine>,
  store: SlidesStore,
  pageId: string,
  canvas: HTMLCanvasElement,
  signal: { stopped: boolean },
  win: Window = window,
): Promise<void> {
  const s = store.list().find((x) => x.pageId === pageId);
  if (!s) return;
  const slide: ShowSlide = {
    pageId,
    number: s.number,
    hidden: false,
    advanceAfterMs: null,
    transition: null,
    notes: "",
    sizePt: s.sizePt,
  };
  const e = await engine();
  await attachAnimations(host, e, [slide], new Map([[pageId, s.state.timing]]));
  if (!slide.anim || signal.stopped) return;
  const [w] = slide.sizePt;
  const scale = Math.max(0.25, Math.min(4, canvas.width / (w || 1)));
  const scene = await drawScene(host, slide.anim.plan, scale, slide.sizePt);
  if (!scene) return;
  const player = await playerFor(engine)(slide, scene);
  if (!player || signal.stopped) {
    player?.free();
    closeScene(scene);
    return;
  }
  const anim = new SlideAnimation(player, scene, () => win.performance.now());
  const g = canvas.getContext("2d");
  const clicks = anim.clicks();
  canvas.dataset.previewClicks = String(clicks);
  await new Promise<void>((done) => {
    let quietSince: number | null = null;
    const frame = () => {
      if (signal.stopped || !g) return done();
      const { states, running } = anim.draws();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const k = canvas.width / (w || 1);
      g.setTransform(k, 0, 0, k, 0, 0);
      drawScene2d(g, scene, states);
      canvas.dataset.previewStep = String(anim.step());
      if (running) quietSince = null;
      else {
        const now = win.performance.now();
        quietSince ??= now;
        // A beat between steps, as PowerPoint's preview leaves.
        if (now - quietSince > 250) {
          if (anim.step() >= clicks) return done();
          anim.next();
          quietSince = null;
        }
      }
      win.requestAnimationFrame(frame);
    };
    win.requestAnimationFrame(frame);
  });
  anim.dispose();
  closeScene(scene);
}

/** The overlay that shows the preview over its page. */
export function previewOverlay(
  host: BundleHost,
  engine: () => Promise<SlideEngine>,
  store: SlidesStore,
  model: PreviewModel,
): OverlayContribution {
  const Render: React.FC<OverlayProps> = ({ camera, pageRects }) => {
    const s = React.useSyncExternalStore(model.subscribe, model.snapshot);
    const ref = React.useRef<HTMLCanvasElement | null>(null);
    const rect = s ? pageRects.get(s.pageId) : undefined;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const px = rect ? Math.max(1, Math.round(rect.w * camera.scale * dpr)) : 1;
    React.useEffect(() => {
      if (!s || !ref.current) return;
      const signal = { stopped: false };
      void playPreview(host, engine, store, s.pageId, ref.current, signal)
        .catch((err) =>
          host.log.warn(
            `paged.slide preview: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => {
          if (!signal.stopped) model.stop();
        });
      return () => {
        signal.stopped = true;
      };
      // A new run (or page) starts a new preview: the model answers a new
      // state object for each.
    }, [s]);
    if (!s || !rect) return <g data-slide-animation-preview="" />;
    return (
      <foreignObject
        data-slide-animation-preview={s.pageId}
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        style={{ pointerEvents: "none" }}
      >
        <canvas
          ref={ref}
          width={px}
          height={Math.max(1, Math.round((px * rect.h) / (rect.w || 1)))}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </foreignObject>
    );
  };
  return { id: PREVIEW_OVERLAY_ID, render: Render, z: 340 };
}
