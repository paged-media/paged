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

// The performance budgets (editor ADR "Performance budgets"; interaction
// contract §20, UXI-PRF-001 to PRF-007; UX audit F-53, F-54, F-56), measured
// end to end in the running editor, with the methods of the October audit
// (docs/reference/performance.md says how each number is taken):
//
//   selection   a real click on an object → the selection mirror holds it →
//               the next frame (rAF + a task)
//   typing      a keydown (a capture listener installed before the app's) →
//               the engine's reply that carried its character → the next
//               frame; at a normal pace and in a burst (F-56)
//   first paint a document opened → the worker's first visible page
//               (`worker.firstPaint`) and, as the audit took it, the first
//               screenshot of the viewport more than 20 % non-dark
//   memory      `performance.measureUserAgentSpecificMemory()` (page and
//               workers; the editor is cross-origin isolated)
//
// Each reports p50 / p95 / p99 and writes them to $PAGED_PERF_OUT (JSON).
// With PAGED_PERF_BUDGETS=1 (the nightly workflow) the egregious budgets
// below are asserted: they catch a regression of several times, not jitter
// on a shared runner. The large documents are the stress suite's: a document
// generated here (40 pages of frames and text, no corpus), and any IDML
// named in PAGED_PERF_LARGE_IDML (comma-separated paths; local only; the
// test reports `unavailable` for a path that is not there, never a pass).

import { existsSync, statSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import { buildFixtureIdml, rect, textFrame } from "@paged-media/test-kit";

import { openCanvas } from "../fidelity/canvas-driver";
import { clientPointOf } from "../e2e/harness/interaction";
import { loadUxiFixture, UXI_A } from "../e2e/harness/uxi-fixtures";

const OUT = process.env.PAGED_PERF_OUT;
const ASSERT = process.env.PAGED_PERF_BUDGETS === "1";
const ROUNDS = Number(process.env.PAGED_PERF_ROUNDS ?? 24);
const LARGE = (process.env.PAGED_PERF_LARGE_IDML ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The egregious budgets (ms, bytes): a several-fold regression fails the
 *  nightly; anything under them is reported, not judged. */
export const BUDGETS = {
  selectionP95Ms: 250,
  typingNormalP95Ms: 300,
  typingBurstP95Ms: 1_000,
  firstPaintGeneratedMs: 30_000,
  memoryGeneratedBytes: 3 * 1024 ** 3,
};

// The full Chromium (new headless), not the headless shell: the shell
// refuses `measureUserAgentSpecificMemory` even when isolated.
test.use({ channel: "chromium" });

const results: Record<string, unknown> = {};

test.afterAll(() => {
  if (OUT) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`[perf] ${JSON.stringify(results)}`);
});

export function percentiles(xs: readonly number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) =>
    s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * q) - 1)]! : 0;
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    n: s.length,
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    max: r(s.at(-1) ?? 0),
  };
}

interface CanvasGlobal {
  __canvas: {
    ready?: boolean;
    elementSelection?: Array<{ kind: string; id: string }>;
    client: {
      setElementSelection(ids: unknown[], mode: string): Promise<unknown[]>;
      mutate(m: unknown): Promise<unknown>;
      drainJournal(timeoutMs?: number): Promise<{
        entries: Array<{ code: string; durMs?: number; data?: unknown }>;
      } | null>;
    };
    setContentSelection(
      s: { storyId: string; start: number; end: number } | null,
    ): void;
    setElementSelection(ids: unknown[]): void;
  };
}

/** Selection latency: a real click, until the mirror holds the object,
 *  then the next frame. */
async function selectionLatency(page: Page): Promise<number[]> {
  const targets = [UXI_A.front, UXI_A.free, UXI_A.back, UXI_A.locked];
  const out: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t = targets[i % targets.length]!;
    // Start from nothing selected, so every click changes the selection.
    await page.evaluate(async () => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      await c.client.setElementSelection([], "replace");
      c.setElementSelection([]);
    });
    const at = await clientPointOf(page, { at: t.at });
    // The listener is in place before the click is sent (one evaluate
    // installs it, a second awaits it), and a click that selects nothing
    // gives up after 5 s rather than hanging the run.
    await page.evaluate((want) => {
      const w = globalThis as unknown as CanvasGlobal & {
        __selectionProbe?: Promise<number>;
      };
      w.__selectionProbe = new Promise<number>((resolve) => {
        let t0 = -1;
        const started = performance.now();
        const onDown = () => {
          t0 = performance.now();
          window.removeEventListener("pointerdown", onDown, true);
        };
        window.addEventListener("pointerdown", onDown, true);
        const poll = () => {
          // The handle is re-published as the editor renders: read it
          // fresh.
          const sel =
            (globalThis as unknown as CanvasGlobal).__canvas.elementSelection ??
            [];
          if (t0 >= 0 && sel.some((s) => `${s.kind}:${s.id}` === want)) {
            requestAnimationFrame(() =>
              setTimeout(() => resolve(performance.now() - t0), 0),
            );
            return;
          }
          if (performance.now() - started > 5_000) {
            resolve(-1);
            return;
          }
          requestAnimationFrame(poll);
        };
        poll();
      });
    }, `${t.id.kind}:${t.id.id}`);
    await page.mouse.click(at.x, at.y);
    const ms = await page.evaluate(
      () =>
        (globalThis as unknown as { __selectionProbe: Promise<number> })
          .__selectionProbe,
    );
    if (ms >= 0) out.push(ms);
  }
  return out;
}

/** Typing latency: keydown → the reply that carried the key's character
 *  → the next frame, per key, at `delayMs` between keys. */
async function typingLatency(
  page: Page,
  delayMs: number,
  storyId: string = UXI_A.note.storyId,
): Promise<{ latencies: number[]; inserts: number }> {
  const text = "the quick brown fox jumps over the lazy dog ".repeat(2);
  await page.evaluate((storyId) => {
    const w = globalThis as unknown as CanvasGlobal & {
      __typing?: { downs: number[]; done: number[]; inserts: number };
    };
    w.__canvas.setContentSelection({ storyId, start: 0, end: 0 });
    const probe = { downs: [] as number[], done: [] as number[], inserts: 0 };
    w.__typing = probe;
    window.addEventListener(
      "keydown",
      () => probe.downs.push(performance.now()),
      true,
    );
    const client = w.__canvas.client;
    const mutate = client.mutate.bind(client);
    client.mutate = async (m: unknown) => {
      const reply = await mutate(m);
      const op = m as { op?: string; args?: { text?: string } };
      if (op.op === "insertText") {
        probe.inserts += 1;
        const n = [...(op.args?.text ?? "")].length;
        requestAnimationFrame(() =>
          setTimeout(() => {
            const now = performance.now();
            for (let i = 0; i < n; i++) probe.done.push(now);
          }, 0),
        );
      }
      return reply;
    };
  }, storyId);
  // The caret took focus for the text input surface.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute("data-canvas-surface") ?? "",
      ),
    )
    .toBe("text");
  await page.keyboard.type(text, { delay: delayMs });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __typing: { done: number[] } }).__typing
              .done.length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual([...text].length);
  return page.evaluate(() => {
    const p = (
      globalThis as unknown as {
        __typing: { downs: number[]; done: number[]; inserts: number };
      }
    ).__typing;
    return {
      latencies: p.done.map((d, i) => d - (p.downs[i] ?? d)),
      inserts: p.inserts,
    };
  });
}

/** Fraction of the viewport's pixels that are not the dark surround. */
async function litFraction(page: Page): Promise<number> {
  const shot = await page
    .locator('[data-testid="viewport-canvas-host"]')
    .screenshot();
  const png = PNG.sync.read(shot);
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const l = (png.data[i]! + png.data[i + 1]! + png.data[i + 2]!) / 3;
    if (l > 60) lit++;
  }
  return lit / (png.width * png.height);
}

async function memoryBytes(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const perf = performance as unknown as {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    if (!crossOriginIsolated || !perf.measureUserAgentSpecificMemory)
      return null;
    try {
      return (await perf.measureUserAgentSpecificMemory()).bytes;
    } catch {
      return null;
    }
  });
}

/** Open a document (bytes as `name`, or a file by its path) and time it:
 *  ready, the worker's first paint, and the audit's screenshot first paint. */
async function openAndTime(
  page: Page,
  file: { name: string; bytes: Buffer } | string,
) {
  await page.evaluate(() => {
    const c = (globalThis as unknown as Partial<CanvasGlobal>).__canvas;
    if (c) c.ready = false;
    void c?.client.drainJournal(30_000);
  });
  const t0 = Date.now();
  await page.setInputFiles(
    'input[type="file"]',
    // Past 50 MB Playwright takes a path, not a buffer.
    typeof file === "string"
      ? file
      : {
          name: file.name,
          mimeType: "application/vnd.adobe.indesign-idml-package",
          buffer: file.bytes,
        },
  );
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean((globalThis as unknown as CanvasGlobal).__canvas.ready),
        ),
      { timeout: 300_000, intervals: [100] },
    )
    .toBe(true);
  const readyMs = Date.now() - t0;
  let screenshotMs: number | null = null;
  while (Date.now() - t0 < 300_000) {
    if ((await litFraction(page)) > 0.2) {
      screenshotMs = Date.now() - t0;
      break;
    }
    await page.waitForTimeout(250);
  }
  let workerMs: number | null = null;
  for (let i = 0; i < 40 && workerMs === null; i++) {
    const drain = await page.evaluate(() =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.drainJournal(
        30_000,
      ),
    );
    const hit = drain?.entries.find((e) => e.code === "worker.firstPaint");
    if (hit) workerMs = Math.round(hit.durMs ?? 0);
    else await page.waitForTimeout(250);
  }
  return {
    readyMs,
    firstPaintScreenshotMs: screenshotMs,
    firstPaintWorkerMs: workerMs,
  };
}

/** The stress suite's large document: `pages` pages, each with a grid of
 *  frames and a text frame of several paragraphs. Deterministic bytes. */
export function stressIdml(pages = 40, perPage = 48): Uint8Array {
  const words =
    "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";
  const stories = Array.from({ length: pages }, (_, p) => ({
    id: `st${p}`,
    paragraphs: Array.from(
      { length: 12 },
      (_, i) => `${p + 1}.${i + 1} ${words} ${words}`,
    ),
  }));
  return buildFixtureIdml({
    name: "stress",
    pages: Array.from({ length: pages }, (_, p) => ({
      id: `sp${p}`,
      items: [
        ...Array.from({ length: perPage }, (_, i) => {
          const x = 36 + (i % 8) * 66;
          const y = 36 + Math.floor(i / 8) * 54;
          return rect(`r${p}x${i}`, [y, x, y + 44, x + 56], {
            fill: i % 3 === 0 ? "Color/Black" : undefined,
          });
        }),
        textFrame(`t${p}`, [380, 36, 756, 576], `st${p}`),
      ],
    })),
    stories,
  });
}

test.describe("performance budgets", () => {
  test.describe.configure({ timeout: 900_000 });

  test("interaction: selection and typing latency, p50 / p95 / p99", async ({
    page,
  }) => {
    await openCanvas(page);
    await loadUxiFixture(page, "A");
    const idle = await memoryBytes(page);
    const selection = percentiles(await selectionLatency(page));
    const typedNormal = await typingLatency(page, 150);
    const typedBurst = await typingLatency(page, 18);
    const normal = percentiles(typedNormal.latencies);
    const burst = percentiles(typedBurst.latencies);
    results.interaction = {
      selection,
      typingNormal: { ...normal, inserts: typedNormal.inserts },
      typingBurst: { ...burst, inserts: typedBurst.inserts },
      memoryIdleBytes: idle,
    };
    if (ASSERT) {
      expect(selection.p95).toBeLessThan(BUDGETS.selectionP95Ms);
      expect(normal.p95).toBeLessThan(BUDGETS.typingNormalP95Ms);
      expect(burst.p95).toBeLessThan(BUDGETS.typingBurstP95Ms);
    }
  });

  test("stress: a generated 40-page document opens, paints its first page and stays in its memory budget", async ({
    page,
  }) => {
    await openCanvas(page);
    const timing = await openAndTime(page, {
      name: "stress.idml",
      bytes: Buffer.from(stressIdml()),
    });
    // Sustained use: walk the pages and zoom, then measure again.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("PageDown");
      if (i % 5 === 4) await page.keyboard.press("ControlOrMeta+Equal");
    }
    const memory = await memoryBytes(page);
    // A burst in a long document: every insert re-lays the document out,
    // so this is where keys outrun the engine (F-56).
    const burst = await typingLatency(page, 18, "st0");
    results.stress = {
      ...timing,
      memoryBytes: memory,
      typingBurst: { ...percentiles(burst.latencies), inserts: burst.inserts },
    };
    if (ASSERT) {
      expect(timing.firstPaintWorkerMs ?? Infinity).toBeLessThan(
        BUDGETS.firstPaintGeneratedMs,
      );
      if (memory !== null)
        expect(memory).toBeLessThan(BUDGETS.memoryGeneratedBytes);
    }
  });

  for (const [i, path] of LARGE.entries()) {
    test(`large document ${i + 1}: first paint and memory (PAGED_PERF_LARGE_IDML)`, async ({
      page,
    }) => {
      if (!existsSync(path)) {
        results[`large${i + 1}`] = "unavailable";
        test.skip(true, `unavailable: ${path} is not there`);
        return;
      }
      await openCanvas(page);
      const size = statSync(path).size;
      const timing = await openAndTime(page, path);
      const opened = await memoryBytes(page);
      for (let k = 0; k < 20; k++) {
        await page.keyboard.press("PageDown");
        if (k % 5 === 4) await page.keyboard.press("ControlOrMeta+Equal");
      }
      const used = await memoryBytes(page);
      results[`large${i + 1}`] = {
        megabytes: Math.round(size / 1e5) / 10,
        ...timing,
        memoryOpenedBytes: opened,
        memoryAfterUseBytes: used,
      };
    });
  }
});
