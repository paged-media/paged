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

// The shared parts of the interaction-latency probes (`tests/perf`): the
// input probe, the sample a probe takes after an interaction, a summary of
// samples, and the seeded document. Two probes use them: panels.perf.spec.ts
// (the React Compiler, ADR 229) and features.perf.spec.ts (the React 19
// features, ADR 230). Numbers, not assertions.

import type { Page } from "@playwright/test";

import { Designer } from "../journey/driver/designer";
import type { RenderCounter } from "./render-counter";

export const ROUNDS = Number(process.env.PAGED_PERF_ROUNDS ?? 12);
export const OUT = process.env.PAGED_PERF_OUT;

export interface Sample {
  nextFrame: number;
  settled: number;
  commits: number;
  renders: number;
  /** Listeners added to `window` or `document` for the interaction: an
   *  effect that re-subscribes because a value it reads changed. */
  listeners: number;
}

/** The input probe: the first pointerdown / keydown / change after a reset
 *  marks the input; the frame after it is timed with rAF + a task. It also
 *  counts the listeners added to `window` and `document` since the reset. */
export function installInputProbe(target: object): void {
  const g = target as {
    __pagedProbe?: unknown;
    addEventListener: (t: string, f: () => void, o: boolean) => void;
    document?: unknown;
    EventTarget?: { prototype: { addEventListener: (...a: never[]) => void } };
  };
  const probe = {
    inputAt: -1,
    nextFrameAt: -1,
    listeners: 0,
    reset() {
      probe.inputAt = -1;
      probe.nextFrameAt = -1;
      probe.listeners = 0;
    },
    mark() {
      if (probe.inputAt >= 0) return;
      probe.inputAt = performance.now();
      requestAnimationFrame(() =>
        setTimeout(() => {
          probe.nextFrameAt = performance.now();
        }, 0),
      );
    },
  };
  g.__pagedProbe = probe;
  for (const type of ["pointerdown", "keydown", "change", "input"]) {
    g.addEventListener(type, () => probe.mark(), true);
  }
  const proto = g.EventTarget?.prototype;
  if (proto) {
    const add = proto.addEventListener;
    proto.addEventListener = function (this: unknown, ...args: never[]) {
      if (this === g || this === g.document) probe.listeners++;
      return add.apply(this, args);
    };
  }
}

export type ProbeWindow = {
  __pagedRenderCounter: RenderCounter;
  __pagedProbe: {
    inputAt: number;
    nextFrameAt: number;
    listeners: number;
    reset(): void;
    mark(): void;
  };
};

export async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as ProbeWindow;
    w.__pagedRenderCounter.reset();
    w.__pagedProbe.reset();
  });
}

/** Wait until React has not committed for `quietMs`, then read the sample. */
export async function sample(page: Page, quietMs = 300): Promise<Sample> {
  return page.evaluate(async (quiet) => {
    const w = globalThis as unknown as ProbeWindow;
    const deadline = performance.now() + 5_000;
    for (;;) {
      const times = w.__pagedRenderCounter.counts().commitTimes;
      const last = times.at(-1) ?? w.__pagedProbe.inputAt;
      if (
        w.__pagedProbe.nextFrameAt >= 0 &&
        performance.now() - last >= quiet
      ) {
        break;
      }
      if (performance.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const c = w.__pagedRenderCounter.counts();
    const t0 = w.__pagedProbe.inputAt;
    const last = c.commitTimes.at(-1) ?? t0;
    return {
      nextFrame: w.__pagedProbe.nextFrameAt - t0,
      settled: Math.max(0, last - t0),
      commits: c.commits,
      renders: c.renders,
      listeners: w.__pagedProbe.listeners,
    };
  }, quietMs);
}

/** A programmatic input: mark it in the page, then run it there. */
export async function selectInPage(
  page: Page,
  refs: Array<{ kind: string; id: string }>,
): Promise<void> {
  await page.evaluate((r) => {
    const w = globalThis as unknown as ProbeWindow & {
      __canvas: {
        setContentSelection?: (s: null) => void;
        setElementSelection?: (r: unknown[], mode: string) => void;
      };
    };
    w.__pagedProbe.mark();
    w.__canvas.setContentSelection?.(null);
    w.__canvas.setElementSelection?.(r, "replace");
  }, refs);
}

export function summarize(name: string, samples: Sample[]) {
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const median = (xs: number[]) => {
    const s = sorted(xs);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const p95 = (xs: number[]) => {
    const s = sorted(xs);
    return s.length
      ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
      : 0;
  };
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {
    panel: name,
    interactions: samples.length,
    nextFrameMedianMs: +median(samples.map((s) => s.nextFrame)).toFixed(1),
    nextFrameP95Ms: +p95(samples.map((s) => s.nextFrame)).toFixed(1),
    settledMedianMs: +median(samples.map((s) => s.settled)).toFixed(1),
    settledP95Ms: +p95(samples.map((s) => s.settled)).toFixed(1),
    commitsPerInteraction: +mean(samples.map((s) => s.commits)).toFixed(1),
    rendersPerInteraction: +mean(samples.map((s) => s.renders)).toFixed(1),
    listenersPerInteraction: +mean(samples.map((s) => s.listeners)).toFixed(1),
  };
}

/** A document with what the five panels show: frames, layers, pages,
 *  swatches. */
export async function seed(page: Page) {
  const d = new Designer(page);
  await d.open();
  await d.newDocument();
  const frames: Array<{ kind: string; id: string }> = [];
  for (let i = 0; i < 8; i++) {
    const f = await d.addFrame({
      x0: 40 + (i % 4) * 120,
      y0: 60 + Math.floor(i / 4) * 160,
      x1: 140 + (i % 4) * 120,
      y1: 200 + Math.floor(i / 4) * 160,
    });
    if (f) frames.push(f);
  }
  const layers: string[] = [];
  for (let i = 0; i < 6; i++) layers.push(await d.addLayer(`Layer ${i + 1}`));
  for (let i = 0; i < 6; i++) await d.addPage();
  const swatches: string[] = [];
  for (let i = 0; i < 6; i++) {
    swatches.push(
      await d.createSwatch(`Swatch ${i + 1}`, [40 * i, 255 - 40 * i, 128]),
    );
  }
  return { d, frames, layers, swatches };
}
