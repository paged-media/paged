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

// The slide transition shaders on a real WebGPU device (slide ADR 721):
// Chrome (new headless, `--enable-unsafe-webgpu`) driven through the
// Playwright library, as the system lane drives Chromium. Every shader
// compiles with Tint without a diagnostic; every transition, rendered between
// two test slides at 64 × 48, shows the outgoing slide at progress 0, the
// incoming one at 1, something else at 0.25 / 0.5 / 0.75, and matches its
// golden frames there; and at 1920 × 1080 each frame takes under 2 ms of GPU
// time where timestamp queries exist.
//
//   cd tests && bun run test:gpu
//   PAGED_GOLDEN_UPDATE=1 bun run test:gpu     # re-record the golden frames
//   PAGED_GPU_ONLY=fade,push bun run test:gpu   # time only these
//   PAGED_GPU_SHEET=<dir> bun run test:gpu      # also write a 5-frame strip
//                                               # per case at 192 x 108, to look at
//
// Without a WebGPU adapter (bundled Chromium, Linux CI) the lane reports why
// and skips; PAGED_REQUIRE_GPU=1 makes that a failure. The goldens are small
// PNGs under modules/slide/packages/slide-bundle/test/fixtures/transitions.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Browser, Page } from "playwright-core";

import {
  TRANSITION_MANIFEST,
  defaultParams,
  renderKinds,
  type CompileReport,
} from "../../../modules/slide/packages/slide-bundle/src/show/shaders/index.ts";
import type { InitResult } from "./harness.ts";

const REPO = resolve(import.meta.dir, "..", "..", "..");
const GOLDEN_DIR = join(
  REPO,
  "modules/slide/packages/slide-bundle/test/fixtures/transitions",
);
const UPDATE = process.env.PAGED_GOLDEN_UPDATE === "1";
const REQUIRE = process.env.PAGED_REQUIRE_GPU === "1";
const W = 64;
const H = 48;
const PROGRESS = [0, 0.25, 0.5, 0.75, 1];
const BUDGET_MS = 2;

/** Every render key at its defaults, plus the variants a deck can ask for. */
const d = TRANSITION_MANIFEST.directions;
const CASES: { name: string; kind: string; params: Record<string, number> }[] =
  [
    ...renderKinds().map((kind) => ({
      name: kind,
      kind,
      params: defaultParams(kind),
    })),
    ...(
      [
        ["fade+thruBlk", "fade", { thruBlack: 1 }],
        ["cut+thruBlk", "cut", { thruBlack: 1 }],
        ["push+r", "push", { direction: d.r! }],
        ["push+u", "push", { direction: d.u! }],
        ["push+d", "push", { direction: d.d! }],
        ["wipe+u", "wipe", { direction: d.u! }],
        ["split+vert+in", "split", { direction: d.in!, vertical: 1 }],
        ["cover+rd", "cover", { direction: d.rd! }],
        ["pull+lu", "pull", { direction: d.lu! }],
        ["zoom+in", "zoom", { direction: d.in! }],
        ["randomBar+vert", "randomBar", { direction: d.vert! }],
        ["blinds+vert", "blinds", { direction: d.vert! }],
        ["checker+vert", "checker", { direction: d.vert! }],
        ["comb+vert", "comb", { direction: d.vert! }],
        ["strips+rd", "strips", { direction: d.rd! }],
        ["wheel+8", "wheel", { spokes: 8 }],
        ["vortex+u", "vortex", { direction: d.u! }],
        ["prism+u", "prism", { direction: d.u! }],
        ["prism+inverted", "prism", { direction: d.l!, inverted: 1 }],
        ["doors+horz", "doors", { direction: d.horz! }],
        ["window+horz", "window", { direction: d.horz! }],
        ["ripple+lu", "ripple", { direction: d.lu! }],
        ["glitter+hexagon", "glitter", { direction: d.l!, hexagon: 1 }],
        ["warp+in", "warp", { direction: d.in! }],
        ["flythrough+bounce", "flythrough", { direction: d.in!, bounce: 1 }],
        ["flythrough+out", "flythrough", { direction: d.out! }],
        ["shred+rectangle", "shred", { direction: d.in!, rectangle: 1 }],
        ["shred+out", "shred", { direction: d.out! }],
        ["reveal+thruBlk", "reveal", { direction: d.l!, thruBlack: 1 }],
        ["switch+r", "switch", { direction: d.r! }],
        ["pageCurlSingle+invX", "prstTrans:pageCurlSingle", { invX: 1 }],
        ["peelOff+invY", "prstTrans:peelOff", { invY: 1 }],
      ] as const
    ).map(([name, kind, params]) => ({
      name,
      kind,
      params: { ...params } as Record<string, number>,
    })),
  ];

/** Transitions whose middle frames are, by design, one of the two slides. */
const INSTANT = new Set(
  Object.values(TRANSITION_MANIFEST.transitions)
    .filter((t) => t.instant)
    .map((t) => t.kind),
);

let browser: Browser | null = null;
let page: Page | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let init: InitResult = { ok: false, reason: "not started", timestamps: false };
const perf: { name: string; medianMs: number; minMs: number; maxMs: number }[] =
  [];

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** Share of pixels whose largest channel difference exceeds `tol`, and the
 *  mean absolute channel difference. */
function diff(
  a: Uint8Array,
  b: Uint8Array,
  tol: number,
): { over: number; mean: number } {
  let over = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.abs(a[i + c]! - b[i + c]!);
      sum += v;
      if (v > m) m = v;
    }
    if (m > tol) over++;
  }
  return { over: over / (a.length / 4), mean: sum / ((a.length / 4) * 3) };
}

async function call<T>(fn: string, ...args: unknown[]): Promise<T> {
  return page!.evaluate(
    ([f, a]) =>
      (
        window.slideTransitions as unknown as Record<
          string,
          (...x: unknown[]) => unknown
        >
      )[f as string]!(...(a as unknown[])),
    [fn, args] as const,
  ) as Promise<T>;
}

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "harness.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const js = await build.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/harness.js")
        return new Response(js, {
          headers: { "content-type": "text/javascript" },
        });
      return new Response(
        '<!doctype html><meta charset=utf-8><link rel="icon" href="data:,"><title>slide transitions</title><script type="module" src="/harness.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const { chromium } = await import("playwright-core");
  try {
    browser = await chromium.launch({
      channel: process.env.PAGED_CHROMIUM ? undefined : "chrome",
      executablePath: process.env.PAGED_CHROMIUM,
      headless: false,
      args: [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--enable-webgpu-developer-features",
        ...(process.platform === "darwin"
          ? ["--use-angle=metal"]
          : ["--enable-features=Vulkan"]),
      ],
    });
  } catch (e) {
    init = {
      ok: false,
      reason: `no Chrome: ${(e as Error).message.split("\n")[0]}`,
      timestamps: false,
    };
    return;
  }
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => "slideTransitions" in window);
  init = await call<InitResult>("init");
  if (!init.ok) console.warn(`slide transitions: skipped — ${init.reason}`);
  else
    console.log(
      `slide transitions on ${init.adapter} (timestamps: ${init.timestamps})`,
    );
}, 120_000);

afterAll(async () => {
  if (perf.length) {
    perf.sort((a, b) => b.medianMs - a.medianMs);
    console.log(
      `GPU ms per frame at 1920x1080 (median, min-max), slowest first:\n${perf
        .map(
          (p) =>
            `  ${p.name.padEnd(28)} ${p.medianMs.toFixed(3)}  (${p.minMs.toFixed(3)}-${p.maxMs.toFixed(3)})`,
        )
        .join("\n")}`,
    );
  }
  await browser?.close();
  server?.stop(true);
});

const gpu = () => {
  if (!init.ok) {
    if (REQUIRE) throw new Error(`PAGED_REQUIRE_GPU=1 but ${init.reason}`);
    return false;
  }
  return true;
};

describe("slide transitions on WebGPU", () => {
  it("[plugin-slide.slideshow] compiles every shader without a WGSL diagnostic", async () => {
    if (!gpu()) return;
    const reports = await call<CompileReport[]>("compileAll");
    expect(reports.length).toBe(
      new Set(
        Object.values(TRANSITION_MANIFEST.shaders).flatMap((s) => s.passes),
      ).size,
    );
    expect(reports.filter((r) => r.errors.length || r.warnings.length)).toEqual(
      [],
    );
  }, 120_000);

  it("[plugin-slide.slideshow] shows the outgoing slide at 0, the incoming at 1, and matches the golden frames between", async () => {
    if (!gpu()) return;
    const s = await call<{ from: string; to: string }>("slides", W, H);
    const from = bytes(s.from);
    const to = bytes(s.to);
    if (UPDATE) mkdirSync(GOLDEN_DIR, { recursive: true });
    const failures: string[] = [];
    for (const c of CASES) {
      const frames = (
        await call<string[]>("render", c.kind, c.params, PROGRESS, W, H)
      ).map(bytes);
      const at0 = diff(frames[0]!, from, 4);
      const at1 = diff(frames[4]!, to, 4);
      if (at0.over > 0.01 || at0.mean > 1)
        failures.push(
          `${c.name}: progress 0 is not the outgoing slide (${JSON.stringify(at0)})`,
        );
      if (at1.over > 0.01 || at1.mean > 1)
        failures.push(
          `${c.name}: progress 1 is not the incoming slide (${JSON.stringify(at1)})`,
        );
      for (const [i, p] of [
        [1, 0.25],
        [2, 0.5],
        [3, 0.75],
      ] as const) {
        const f = frames[i]!;
        if (!INSTANT.has(c.kind)) {
          const a = diff(f, from, 8);
          const b = diff(f, to, 8);
          if (a.over < 0.005)
            failures.push(
              `${c.name}: progress ${p} still shows the outgoing slide`,
            );
          if (b.over < 0.005)
            failures.push(
              `${c.name}: progress ${p} already shows the incoming slide`,
            );
        }
        const file = join(
          GOLDEN_DIR,
          `${c.name.replace(/[:+]/g, "_")}@${p}.png`,
        );
        if (UPDATE || !existsSync(file)) {
          if (!UPDATE)
            failures.push(
              `${c.name}: no golden ${file} (PAGED_GOLDEN_UPDATE=1 records it)`,
            );
          else
            writeFileSync(
              file,
              bytes(
                await call<string>(
                  "png",
                  Buffer.from(f).toString("base64"),
                  W,
                  H,
                ),
              ),
            );
          continue;
        }
        const g = await call<{ rgba: string; w: number; h: number }>(
          "unpng",
          readFileSync(file).toString("base64"),
        );
        const gd = diff(f, bytes(g.rgba), 24);
        // Shaders with random cells or hard edges may land a boundary pixel
        // differently on another GPU; a real change moves far more.
        if (g.w !== W || g.h !== H || gd.over > 0.03 || gd.mean > 4) {
          failures.push(
            `${c.name}: progress ${p} differs from its golden (${JSON.stringify(gd)})`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it("writes contact strips when PAGED_GPU_SHEET names a directory", async () => {
    const dir = process.env.PAGED_GPU_SHEET;
    if (!dir || !gpu()) return;
    mkdirSync(dir, { recursive: true });
    const [sw, sh] = [192, 108];
    for (const c of CASES) {
      const frames = (
        await call<string[]>("render", c.kind, c.params, PROGRESS, sw, sh)
      ).map(bytes);
      const strip = new Uint8Array(sw * PROGRESS.length * sh * 4);
      frames.forEach((f, i) => {
        for (let y = 0; y < sh; y++)
          strip.set(
            f.subarray(y * sw * 4, (y + 1) * sw * 4),
            (y * sw * PROGRESS.length + i * sw) * 4,
          );
      });
      const png = await call<string>(
        "png",
        Buffer.from(strip).toString("base64"),
        sw * PROGRESS.length,
        sh,
      );
      writeFileSync(
        join(dir, `${c.name.replace(/[:+]/g, "_")}.png`),
        bytes(png),
      );
    }
  }, 300_000);

  it("renders every transition in under 2 ms of GPU time per 1080p frame", async () => {
    if (!gpu()) return;
    if (!init.timestamps) {
      console.warn(
        "slide transitions: GPU time not measured — the adapter has no timestamp-query",
      );
      return;
    }
    const over: string[] = [];
    const only = process.env.PAGED_GPU_ONLY?.split(",");
    for (const c of CASES.filter(
      (x) => !x.name.includes("+") && (!only || only.includes(x.name)),
    )) {
      const ms = await call<number[]>("time", c.kind, c.params, 1920, 1080, 30);
      ms.sort((a, b) => a - b);
      const median = ms[Math.floor(ms.length / 2)] ?? 0;
      perf.push({
        name: c.name,
        medianMs: median,
        minMs: ms[0] ?? 0,
        maxMs: ms[ms.length - 1] ?? 0,
      });
      if (median >= BUDGET_MS) over.push(`${c.name}: ${median.toFixed(3)} ms`);
    }
    expect(over).toEqual([]);
  }, 300_000);
});
