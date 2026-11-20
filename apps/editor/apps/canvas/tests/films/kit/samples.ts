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

// Sample publications in a take (editor ADR 1243, ADR 224): which sample a
// film opens, and where it goes in it, is the storyboard's data — the
// website's `films/samples.take.json` (or a film's own take file) — never
// this repository's, which names no publication. A film asks by role:
// "magazine", "catalogue", "report", "viewbook".
//
// The editor offers samples only in the demo build or with VITE_SAMPLES_URL
// (src/samples/catalog.ts): run the films with it in the environment, e.g.
//   VITE_SAMPLES_URL=https://modules.paged.media/samples/catalog.json
// A dev server reused from before, started without it, shows no samples;
// `openSample` says so instead of timing out.

import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "./film";
import { typeHuman } from "./pointer";
import { press } from "./ui";

/** A sample a film uses, and the places in it the film goes. */
export interface SampleRef {
  /** The catalog id. */
  sample: string;
  /** Text of the window title once it is open (part of the title). */
  title: string;
  /** Document Map rows ("Pages 4–5") the film visits. */
  spreads?: string[];
  /** The page number the film jumps to. */
  page?: number;
  /** Select the page's largest frame (its main photograph) in the cut. */
  select?: boolean;
  /** A page position (pt) a placed result moves to. */
  spot?: [number, number];
  /** Anything else the film needs from the storyboard. */
  [extra: string]: unknown;
}

/** The roles of `films/<file>` (default `samples.take.json`) in the
 *  website's media folder. */
export function sampleTake(
  file = "samples.take.json",
): Record<string, SampleRef> {
  const root = process.env.PAGED_MEDIA_ROOT;
  if (!root) throw new Error("PAGED_MEDIA_ROOT names no media folder");
  return JSON.parse(readFileSync(join(root, "films", file), "utf8")) as Record<
    string,
    SampleRef
  >;
}

/** One role of the take. */
export function sampleRole(role: string, file?: string): SampleRef {
  const ref = sampleTake(file)[role];
  if (!ref)
    throw new Error(`films/${file ?? "samples.take.json"}: no "${role}"`);
  return ref;
}

const escape = (t: string) =>
  new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** Every story's length: the document's text, loaded. */
export async function storyLengths(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            collection(n: string): Promise<Array<{ characterCount: number }>>;
          };
        };
      }
    ).__canvas;
    return (await c.client.collection("stories")).map((s) => s.characterCount);
  });
}

/** The sample open: its title in the window, its stories loaded, every
 *  page prepared. A recovery offer for the document left before (a take
 *  typed into it) is declined: the next sample opens as it was published. */
export async function opened(page: Page, title: RegExp): Promise<void> {
  const notNow = page.getByRole("button", { name: "Not now" });
  await expect(page).toHaveTitle(title, { timeout: 120_000 });
  await expect
    .poll(async () => (await storyLengths(page)).length, { timeout: 120_000 })
    .toBeGreaterThan(10);
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await expect(page.getByText(/Preparing pages/).first()).toBeHidden({
    timeout: 180_000,
  });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
}

/**
 * Open the sample `ref` names through its `?sample=` link (a reload of the
 * editor: in setup before the roll, or inside a `k.cut`), and wait until it
 * is open. Fails at once, saying why, when the dev server offers no samples
 * or the catalog does not list the id.
 */
export async function openSample(k: Kit, ref: SampleRef): Promise<void> {
  const warnings: string[] = [];
  const listen = (m: { text(): string }) => {
    if (m.text().startsWith("[samples]")) warnings.push(m.text());
  };
  k.page.on("console", listen);
  try {
    await k.designer.open({ search: `?sample=${ref.sample}` });
    const title = escape(ref.title);
    const off = async () => {
      // Samples off: the empty canvas lists none and the title never comes.
      await k.page.waitForTimeout(20_000);
      const listed = await k.page.locator("[data-empty-samples]").count();
      const titled = title.test(await k.page.title());
      if (!titled && listed === 0)
        throw new Error(
          warnings[0] ??
            "the editor offers no samples: start the dev server with VITE_SAMPLES_URL (a server reused from before may lack it)",
        );
      if (warnings.length > 0) throw new Error(warnings[0]);
    };
    await Promise.race([
      opened(k.page, title),
      off().then(() => opened(k.page, title)),
    ]);
  } finally {
    k.page.off("console", listen);
  }
}

/** To a spread through the Document Map's row for it ("Pages 4–5"): the
 *  row scrolled into view and settled before the click, and the page bar's
 *  "N / total" showing its first page after it. */
export async function goTo(k: Kit, row: string): Promise<void> {
  const first = row.replace(/^Pages /, "").split("–")[0];
  const item = k.page.getByText(row, { exact: true }).first();
  await item.scrollIntoViewIfNeeded();
  await k.hold(700);
  await press(k, item);
  await expect(
    k.page.getByText(new RegExp(`^${first} / \\d+$`)).first(),
  ).toBeVisible({ timeout: 15_000 });
  await k.hold(900);
  await k.recamera();
}

/** To page `n` (its number, as the page bar shows it) by the editor's
 *  go-to-page command (off camera, in a cut): a long document's Document Map
 *  is still filling while it prepares. */
export async function jumpTo(k: Kit, n: number): Promise<void> {
  await k.page.evaluate(async (want) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: { executeScript(s: string): Promise<{ output: string[] }> };
          registries: {
            commands: { invoke(id: string, args: unknown): Promise<unknown> };
          };
        };
      }
    ).__canvas;
    const r = await c.client.executeScript("JSON.stringify(paged.pages())");
    const pages = JSON.parse(JSON.parse(r.output[0])) as Array<{
      selfId: string;
      index: number;
    }>;
    const target = pages.find((p) => p.index === want);
    if (!target) throw new Error(`no page ${want}`);
    await c.registries.commands.invoke("paged.view.goToPage", {
      page: target.selfId,
    });
  }, n);
  await k.hold(1200);
  await k.recamera();
}

/** View ▸ Fit page in window, off camera (in a cut). The editor lays a
 *  publication's pages out one under the other, so the page, not the
 *  spread, is what fills the window. */
export async function fitPage(k: Kit): Promise<void> {
  await k.page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          registries: { commands: { invoke(id: string): Promise<unknown> } };
        };
      }
    ).__canvas;
    await c.registries.commands.invoke("paged.view.fitPage");
  });
  await k.hold(800);
  await k.recamera();
}

/**
 * A film's closing scene on a real publication (website ADR 863): a cut —
 * the reload and the open are off camera — to the sample `ref` names, at
 * its page, the spread fitted in the window. The take's files stay where
 * they were (`k.dir`), so the scene after it can place them.
 */
export async function cutToSample(
  k: Kit,
  ref: SampleRef,
  label: string,
): Promise<void> {
  await k.cut(label, async () => {
    await openSample(k, ref);
    // A take that ended in another workspace (the export centre has no
    // canvas) reopens there: back to Design first.
    const design = k.page.getByRole("button", { name: "Design", exact: true });
    if (await design.isVisible().catch(() => false)) await design.click();
    await expect(k.page.locator("canvas").first()).toBeAttached({
      timeout: 30_000,
    });
    if (ref.page !== undefined) await jumpTo(k, ref.page);
    await fitPage(k);
    // The take asks for the page's main photograph, selected (`select`).
    if (ref.select && ref.page !== undefined)
      await selectLargestOn(k, String(ref.page));
  });
}

/** Type a value into a field the way a person does: click it, select what
 *  is there, type, Enter. */
export async function retype(
  k: Kit,
  field: Locator,
  value: string,
): Promise<void> {
  await press(k, field);
  await expect(field).toBeFocused();
  await k.page.keyboard.press("ControlOrMeta+a");
  await typeHuman(k.page, value, 13);
  await k.hold(120);
  await k.page.keyboard.press("Enter");
  await k.hold(200);
}

/** Move the selection to a page position (pt) through the control bar's
 *  Left and Top edge fields. */
export async function moveTo(k: Kit, left: number, top: number): Promise<void> {
  await retype(k, k.page.getByLabel("Left edge (pt)").first(), String(left));
  await retype(k, k.page.getByLabel("Top edge (pt)").first(), String(top));
}

/** The ids of every item on page `label` (its number, as the tree labels it). */
async function itemsOnPage(k: Kit, label: string, kind?: string) {
  return k.page.evaluate(
    async ({ label, kind }) => {
      type Node = {
        id?: { kind: string; id: string } | null;
        kind?: string;
        label?: string;
        children?: Node[];
      };
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              executeScript(s: string): Promise<{ output: string[] }>;
              send(m: unknown): Promise<{
                payload: {
                  items?: Array<{
                    id: { kind: string; id: string };
                    bounds: number[];
                  }>;
                };
              }>;
            };
          };
        }
      ).__canvas;
      const tree = JSON.parse(
        JSON.parse(
          (await c.client.executeScript("JSON.stringify(paged.tree())"))
            .output[0],
        ),
      ) as Node[];
      const ids: Array<{ kind: string; id: string }> = [];
      const walk = (n: Node, on: boolean) => {
        const here = on || (n.kind === "Page" && n.label === label);
        if (here && n.id && (!kind || n.id.kind === kind)) ids.push(n.id);
        for (const ch of n.children ?? []) walk(ch, here);
      };
      for (const root of tree) walk(root, false);
      const g = await c.client.send({
        kind: "requestElementGeometry",
        payload: { ids },
      });
      return g.payload.items ?? [];
    },
    { label, kind },
  );
}

/** Select, off camera, the largest frame of `kind` on page `label` — the
 *  page's main photograph, for a scene that works on it. */
export async function selectLargestOn(
  k: Kit,
  label: string,
  kind = "rectangle",
): Promise<void> {
  const items = await itemsOnPage(k, label, kind);
  const area = (b: number[]) => Math.abs((b[2] - b[0]) * (b[3] - b[1]));
  const best = items.sort((a, b) => area(b.bounds) - area(a.bounds))[0];
  if (!best) throw new Error(`no ${kind} on page ${label}`);
  await k.page.evaluate(async (id) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            setElementSelection?(
              ids: unknown[],
              mode: string,
            ): Promise<unknown[]>;
            elementGeometry?(ids: unknown[]): Promise<unknown>;
          };
          setElementSelection?(ids: unknown[], mode: string): void;
          setElementGeometry?(g: unknown): void;
        };
      }
    ).__canvas;
    const applied = c.client.setElementSelection
      ? await c.client.setElementSelection([id], "replace")
      : [id];
    c.setElementSelection?.(applied, "replace");
    if (c.client.elementGeometry && c.setElementGeometry)
      c.setElementGeometry(await c.client.elementGeometry(applied));
  }, best.id);
  await k.hold(500);
}

/** A screen point near the middle of the canvas, where a fitted page is. */
export async function canvasPoint(
  k: Kit,
  fx = 0.5,
  fy = 0.5,
): Promise<{ x: number; y: number }> {
  const box = await k.page.locator("canvas").evaluateAll(
    (cs) =>
      cs
        .map((c) => c.getBoundingClientRect())
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }))[0],
  );
  return { x: box.x + box.w * fx, y: box.y + box.h * fy };
}

/** Size the selection through the control bar's width and height fields. */
export async function sizeTo(k: Kit, w: number, h: number): Promise<void> {
  await retype(k, k.page.getByLabel(/^Width/).first(), String(w));
  await retype(k, k.page.getByLabel(/^Height/).first(), String(h));
}

/** The screen point of a point on page `n` (pt, page-local): pages stack
 *  24 pt apart under one another (the stills kit's pagePt). */
export async function pagePoint(
  k: Kit,
  n: number,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  return k.page.evaluate(
    (a) => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            handle: { pageSizesPt: [number, number][] };
            client: {
              camera: { read(): { scale: number; tx: number; ty: number } };
            };
          };
        }
      ).__canvas;
      const sizes = c.handle.pageSizesPt;
      let top = 0;
      for (let j = 0; j < a.n - 1; j++) top += sizes[j][1] + 24;
      let best: Element | null = null;
      let area = 0;
      for (const cv of Array.from(document.querySelectorAll("canvas"))) {
        const r = cv.getBoundingClientRect();
        if (r.width * r.height > area) {
          area = r.width * r.height;
          best = cv;
        }
      }
      const el = best as HTMLElement;
      const wrap = (el.parentElement ?? el).getBoundingClientRect();
      const cam = c.client.camera.read();
      return {
        x: wrap.left + a.x * cam.scale + cam.tx,
        y: wrap.top + (top + a.y) * cam.scale + cam.ty,
      };
    },
    { n, x, y },
  );
}
