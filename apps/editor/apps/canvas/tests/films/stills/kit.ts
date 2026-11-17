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

// What every stills spec shares (website ADR 858): where a still is written,
// the record it leaves in `stills.json` (each still with the commit it was
// captured at, whether the tree was dirty, and when), and the editor's own
// automation for reaching a state off camera. Stills are recorded locally
// (PAGED_MEDIA_ROOT), into <media>/.build/stills/<id>.png, never in CI.

import { expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Designer } from "../../journey/driver/designer";
import { ShowcaseDoc } from "../../showcase/driver";
import { dressStage } from "../kit/stage";

export const ROOT = process.env.PAGED_MEDIA_ROOT;
export const OUT = join(ROOT ?? "", ".build", "stills");
/** The monorepo root (tests/films/stills is seven levels below it). */
export const REPO_ROOT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
);
/** The OFL faces in the engine's corpus (the showcase's and the films'). */
export const FONTS = join(REPO_ROOT, "engine", "core", "corpus", "fonts");
/** The media package's assets (the films' photograph, workbook, HTML, …). */
export const ASSETS = join(ROOT ?? "", "assets");
/** The showcase annual as the showcase project last built it. */
export const SHOWCASE =
  process.env.SHOWCASE_PAGED ??
  join(
    REPO_ROOT,
    "apps",
    "editor",
    "apps",
    "canvas",
    "showcase",
    "showcase.paged",
  );

/** The stills' viewport: 1536×860 CSS px at device scale 2 (3072×1720). */
export const STILL_VIEW = { width: 1536, height: 860 } as const;

type CanvasGlobal = { __canvas: any };

/** Run `fn` in the page with the editor's automation handle. */
export const canvas = <T>(
  page: Page,
  fn: (c: any, arg: any) => T | Promise<T>,
  arg?: unknown,
) =>
  page.evaluate(
    async ({ src, arg }) =>
      new Function("c", "arg", `return (${src})(c, arg)`)(
        (globalThis as unknown as CanvasGlobal).__canvas,
        arg,
      ),
    { src: fn.toString(), arg },
  );

export function editorCommit(): { commit: string; dirty: boolean } {
  const git = (...a: string[]) =>
    execFileSync("git", a, { encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
  };
}

/** Add one still's entry to `stills.json`, keeping every other one: each
 *  entry carries its own commit, dirty flag and capture time, so stills
 *  captured by different runs keep their own provenance. */
function record(id: string, facts: Record<string, unknown>): void {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, "stills.json");
  const prev = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as {
        stills?: Record<string, unknown>;
      })
    : {};
  const editor = editorCommit();
  const capturedAt = new Date().toISOString();
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...prev,
        editor,
        captured: capturedAt,
        stills: {
          ...(prev.stills ?? {}),
          [id]: { ...facts, ...editor, capturedAt },
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** Capture `<id>.png` (the page, or one element of it) and record it. */
export async function shot(
  page: Page,
  id: string,
  facts: Record<string, unknown>,
  of?: Locator,
): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${id}.png`);
  if (of) await of.screenshot({ path });
  else {
    // A passing notice ("Imported … · View report") is closed first, as a
    // person reading the screen would close it.
    const toasts = page.locator("[data-feedback-close]:visible");
    if ((await toasts.count()) > 0) {
      for (const close of await toasts.all())
        await close.click().catch(() => {});
      await park(page).catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path });
  }
  record(id, facts);
}

/** The page under the camera, from the control bar (only shown with nothing selected). */
export async function current(page: Page): Promise<number> {
  return Number(
    (await page.locator("[data-control-page]").textContent({ timeout: 3000 }))
      ?.split("/")[0]
      .trim(),
  );
}

/** Nothing selected, canvas focused: a click on the pasteboard left of the pages. */
export async function deselect(page: Page): Promise<void> {
  const vp = (await page.locator("[data-paged-viewport]").boundingBox())!;
  await page.keyboard.press("Escape");
  // The selection tool: a mode (the raster editor) can leave another armed.
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("v");
  await page.mouse.click(vp.x + 12, vp.y + vp.height / 2);
  await page.locator("[data-control-page]").waitFor({ timeout: 5000 });
}

/** The pointer rests off the canvas, on the empty middle of the bottom bar:
 *  over the canvas the selection tool would show its modifier hints. */
export async function park(page: Page): Promise<void> {
  const view = page.viewportSize() ?? STILL_VIEW;
  await page.mouse.move(Math.round(view.width * 0.72), view.height - 14);
  await page.waitForTimeout(300);
}

/** To page n with the editor's own page keys. */
export async function goTo(page: Page, n: number): Promise<void> {
  await deselect(page);
  for (let g = 0; g < 200; g++) {
    const c = await current(page);
    if (c === n) return;
    await page.keyboard.press(c < n ? "PageDown" : "PageUp");
    await page.waitForTimeout(110);
  }
  throw new Error(`could not reach page ${n}`);
}

/** Screen point of a point on page n (pages stack 24 pt apart). */
export async function pagePt(page: Page, n: number, x: number, y: number) {
  return canvas(
    page,
    (c, a) => {
      const sizes: [number, number][] = c.handle.pageSizesPt;
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
      const wrap = (
        (best as HTMLElement).parentElement ?? (best as HTMLElement)
      ).getBoundingClientRect();
      const cam = c.client.camera.read();
      return {
        x: wrap.left + a.x * cam.scale + cam.tx,
        y: wrap.top + (top + a.y) * cam.scale + cam.ty,
      };
    },
    { n, x, y },
  );
}

/** Zoom with the wheel (Ctrl) anchored at a page point, to at least `scale`. */
export async function zoomAt(
  page: Page,
  n: number,
  x: number,
  y: number,
  scale: number,
): Promise<number> {
  const at = await pagePt(page, n, x, y);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  for (let i = 0; i < 80; i++) {
    if ((await canvas(page, (c) => c.client.camera.read().scale)) >= scale)
      break;
    await page.mouse.wheel(0, -10);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("Control");
  await page.waitForTimeout(700);
  return canvas(page, (c) => c.client.camera.read().scale);
}

/** Close the panels a still opened, so the next one starts from the default dock. */
export const hidePanels = (page: Page, match: RegExp) =>
  canvas(
    page,
    async (c, src) => {
      const re = new RegExp(src);
      for (const cmd of c.registries.commands.list())
        if (cmd.id.startsWith("paged.panel.hide.") && re.test(cmd.id))
          await c.registries.commands.invoke(cmd.id);
    },
    match.source,
  );

export const showPanel = (page: Page, id: string) =>
  canvas(
    page,
    (c, i) => c.registries.commands.invoke(`paged.panel.show.${i}`),
    id,
  );

/** Run `paged.*` source in the editor's engine; a script error fails. */
export async function script(page: Page, source: string): Promise<string[]> {
  const r = (await canvas(
    page,
    (c, s) => c.client.executeScript(s),
    source,
  )) as { output: string[]; error: string | null };
  if (r.error) throw new Error(`script failed: ${r.error}`);
  return r.output.map((l) => l.replace(/^\[log\] /, ""));
}

/** The camera stops moving (a fit animates). */
export async function settled(page: Page): Promise<void> {
  let last = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(
          await canvas(page, (c) => c.client.camera.read()),
        );
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [250], timeout: 10_000 },
    )
    .toBe(true);
}

/** The editor as someone who has used it sees it: the modifier hints a
 *  tool shows on its first uses (editor ADR 1201) have receded. The count
 *  is the editor's own remembered setting (`paged.modifierHints.uses`). */
export async function seasoned(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const uses: Record<string, number> = {};
    for (const tool of [
      "paged.tool.select",
      "paged.tool.directSelect",
      "paged.tool.rectangle",
      "paged.tool.ellipse",
      "paged.tool.polygon",
      "paged.tool.hand",
      "paged.tool.zoom",
      "paged.tool.type",
      "paged.tool.pen",
    ])
      uses[tool] = 99;
    try {
      localStorage.setItem("paged.modifierHints.uses", JSON.stringify(uses));
    } catch {
      /* no storage: the hints show, as they would */
    }
  });
}

/** The showcase annual, open with its fonts, every page laid out. */
export async function openShowcase(page: Page): Promise<void> {
  await dressStage(page);
  await seasoned(page);
  await new Designer(page).open();
  // Fonts BEFORE the document: registration seeds shaping at load.
  await new ShowcaseDoc(page).registerFonts(FONTS);
  await page.setInputFiles('input[type="file"]', SHOWCASE);
  await page.waitForFunction(
    () =>
      (globalThis as unknown as CanvasGlobal).__canvas?.ready === true &&
      (globalThis as unknown as CanvasGlobal).__canvas.handle?.pageCount ===
        134,
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(2000);
}
