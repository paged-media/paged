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

// For designers, the audience film for /designers (ADR 224): the website's
// `films/designers.yaml`. A page of a real magazine (a sample publication,
// website ADR 863; which one, and where in it, is the take's
// `films/samples.take.json` "designers"), and the things a layout person
// does with it, each through the editor's own controls: the threading
// ports, View ▸ Editing aids ▸ Text threads, the Type tool, the Paragraph
// styles and Glyphs panels, File ▸ Place…, a frame handle, the command
// palette and the workflow modes. Every step is asserted.
//
// Off camera: the sample opened at its page, and the page's story
// unthreaded after its first frame (the user's own unlink): the frames
// after the break empty, the first one overset. On camera the thread is
// made again, through the ports.

import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { film } from "../kit/film";
import { typeHuman } from "../kit/pointer";
import { menu, press } from "../kit/ui";
import {
  fitPage,
  itemsOnPage,
  jumpTo,
  openSample,
  pageLocal,
  pagePoint,
  pageRect,
  pageSize,
  sampleRole,
  type PageItem,
} from "../kit/samples";

const MEDIA = process.env.PAGED_MEDIA_ROOT ?? "";
const PHOTO = join(MEDIA, "assets", "pexels-618833-dolomites.jpg");
/** The photograph's natural size (px): Place keeps its proportions. */
const PHOTO_PX = { width: 2200, height: 1469 };

type Rect = [number, number, number, number]; // x0, y0, x1, y1 (pt), for focus()

/** What the take names on the page: a point in the story's opening
 *  paragraph and the style it is given, a point on the headline's last
 *  line and the word the dagger follows. */
interface DesignersTake {
  lede: [number, number];
  ledeStyle: string;
  headEnd: [number, number];
  headWord: string;
}

async function mutate(
  page: Page,
  op: string,
  args: unknown,
): Promise<{ kind: string }> {
  return page.evaluate(
    async (m) => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: { mutate(m: unknown): Promise<{ kind: string }> };
          };
        }
      ).__canvas;
      return c.client.mutate(m);
    },
    { op, args },
  );
}

async function story(
  page: Page,
  storyId: string,
): Promise<Array<{ style: string; text: string }>> {
  return page.evaluate(async (sid) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            send(m: unknown): Promise<{
              payload: {
                content?: {
                  paragraphs: Array<{
                    paragraphStyle: string;
                    runs: Array<{ text: string }>;
                  }>;
                };
              };
            }>;
          };
        };
      }
    ).__canvas;
    const r = await c.client.send({
      kind: "requestStoryContent",
      payload: { storyId: sid },
    });
    return (r.payload.content?.paragraphs ?? []).map((p) => ({
      style: p.paragraphStyle,
      text: p.runs.map((x) => x.text).join(""),
    }));
  }, storyId);
}

/** A frame's properties as the inspector reads them, as JSON. */
async function properties(page: Page, id: PageItem["id"]): Promise<string> {
  return page.evaluate(async (id) => {
    const c = (
      globalThis as unknown as {
        __canvas: { client: { send(m: unknown): Promise<unknown> } };
      }
    ).__canvas;
    return JSON.stringify(
      await c.client.send({
        kind: "requestElementProperties",
        payload: { id },
      }),
    );
  }, id);
}

film("designers", async (k) => {
  const { page, pointer } = k;
  const ref = sampleRole("designers");
  const take = ref as unknown as DesignersTake;
  const N = ref.page!;
  let width = 0;
  // The page's items in page-local [top, left, bottom, right].
  const onPage = async (kind?: string) =>
    (await itemsOnPage(k, String(N), kind))
      .map((i) => ({ ...i, local: pageLocal(i.bounds, N, width) }))
      .filter((i) => i.local[1] >= -1 && i.local[3] <= width + 1);
  const at = (x: number, y: number) => pagePoint(k, N, x, y);
  const mid = (b: number[]) => at((b[1] + b[3]) / 2, (b[0] + b[2]) / 2);
  const zoom = async (r: Rect) => k.focus(await pageRect(k, N, r));
  const around = (bs: number[][], pad = 12): Rect => [
    Math.min(...bs.map((b) => b[1])) - pad,
    Math.min(...bs.map((b) => b[0])) - pad,
    Math.max(...bs.map((b) => b[3])) + pad,
    Math.max(...bs.map((b) => b[2])) + pad,
  ];
  const deselect = async () => {
    await press(k, page.locator('[data-tool-slot="select"]').first());
    await pointer.click(await at(-60, 300), { targetWidth: 80 });
    await k.hold(200);
  };

  let first: PageItem & { local: number[] };
  let next: PageItem & { local: number[] };
  let body = "";

  await k.setup(async () => {
    await openSample(k, ref);
    // A take that ended in another workspace reopens there.
    const design = page.getByRole("button", { name: "Design", exact: true });
    if (await design.isVisible().catch(() => false)) await design.click();
    await expect(page.locator("canvas").first()).toBeAttached({
      timeout: 30_000,
    });
    await jumpTo(k, N);
    await fitPage(k);
    width = (await pageSize(k, N))[0];
    // The story threaded through most frames of this page, and its first
    // two frames, left to right.
    const frames = (await onPage("textFrame")).filter((f) => f.storyId);
    const byStory = new Map<string, typeof frames>();
    for (const f of frames)
      byStory.set(f.storyId!, [...(byStory.get(f.storyId!) ?? []), f]);
    const chain = [...byStory.values()].sort((a, b) => b.length - a.length)[0];
    expect(chain.length).toBeGreaterThanOrEqual(2);
    chain.sort((a, b) => a.local[1] - b.local[1] || a.local[0] - b.local[0]);
    [first, next] = chain;
    body = first.storyId!;
    expect(await properties(page, first.id)).toContain(next.id.id);
    // The user's unlink, made here: the story stops after its first frame.
    expect(
      (await mutate(page, "unlinkFrames", { frame: first.id.id })).kind,
    ).toBe("mutationApplied");
    await page.keyboard.press("Escape");
    await k.hold(1500);
  });
  await k.roll();
  const columns = around([first!.local, next!.local]);

  // ── The copy runs over its frame. ──
  await k.scene("story", async () => {
    await zoom(columns);
    await k.hold(500);
    await press(k, page.locator('[data-tool-slot="select"]').first());
    await pointer.click(await mid(first.local), { targetWidth: 120 });
    await expect(page.locator('[data-thread-port="out"]')).toHaveAttribute(
      "data-thread-state",
      "overset",
    );
    await k.hold(600);
  });

  // ── Thread the story on. ──
  await k.scene("thread", async () => {
    // The first frame is still selected: its out-port is the red marker.
    await press(k, page.locator('[data-thread-port="out"]').first());
    await k.hold(300);
    await pointer.click(await mid(next.local), { targetWidth: 120 });
    await expect.poll(() => properties(page, first.id)).toContain(next.id.id);
    await expect(page.locator('[data-thread-port="out"]')).not.toHaveAttribute(
      "data-thread-state",
      "overset",
    );
    await k.hold(400);
  });

  // ── Where the story goes. ──
  await k.scene("threads", async () => {
    k.unfocus();
    await menu(k, ["View", "Editing aids", "Text threads"]);
    await expect
      .poll(() => page.locator("[data-thread-hop]").count())
      .toBeGreaterThan(0);
    // Punch-ins hold at least 2 s, or the compositor drops them as twitches.
    await zoom(columns);
    await k.hold(2200);
  });

  // ── A paragraph takes one of the magazine's styles. ──
  await k.scene("styles", async () => {
    k.unfocus();
    await press(k, page.locator('[data-tool-slot="type"]').first());
    await pointer.click(await at(...take.lede), { targetWidth: 40 });
    await menu(k, ["Type", "Paragraph styles"]);
    await press(
      k,
      page.locator(`[data-apply-item="${take.ledeStyle}"]`).first(),
    );
    await expect
      .poll(async () => (await story(page, body))[0]?.style)
      .toBe(take.ledeStyle);
    await zoom(around([first.local]));
    await k.hold(2200);
  });

  // ── A character from the Glyphs panel. ──
  let head = "";
  await k.scene("glyph", async () => {
    k.unfocus();
    const [hx, hy] = take.headEnd;
    const frame = (await onPage("textFrame")).find(
      (f) =>
        f.local[1] <= hx &&
        hx <= f.local[3] &&
        f.local[0] <= hy &&
        hy <= f.local[2],
    );
    expect(frame?.storyId).toBeTruthy();
    head = frame!.storyId!;
    await pointer.click(await at(hx, hy), { targetWidth: 40 });
    await k.key("End");
    await menu(k, ["Type", "Glyphs…"]);
    await press(k, page.locator('[data-glyph="†"]:visible').first());
    await expect
      .poll(async () =>
        (await story(page, head)).some((p) =>
          p.text.includes(`${take.headWord}†`),
        ),
      )
      .toBe(true);
    await zoom(around([frame!.local], 24));
    await k.hold(2200);
    k.unfocus();
    await deselect();
  });

  // ── A photograph, placed over the portrait in the box it should fill. ──
  const pictures = async () =>
    (await onPage("rectangle")).filter((i) => i.hasImage);
  let portrait: number[] = [];
  let before = new Set<string>();
  await k.scene("place", async () => {
    const now = await pictures();
    before = new Set(now.map((i) => i.id.id));
    const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
    portrait = now.sort((a, b) => area(b.local) - area(a.local))[0].local;
    const [top, left, , right] = portrait;
    // As wide as the portrait: the photograph's own proportions decide the
    // height, a little more than the portrait's.
    const tall = ((right - left) * PHOTO_PX.height) / PHOTO_PX.width;
    const chooser = page.waitForEvent("filechooser");
    await menu(k, ["File", "Place…"]);
    k.chip("dolomites.jpg", "file");
    await (await chooser).setFiles(PHOTO);
    await k.hold(500);
    await pointer.drag(await at(left, top), await at(right, top + tall + 2), {
      speed: 0.8,
    });
    await expect
      .poll(
        async () =>
          (await pictures()).filter((i) => !before.has(i.id.id)).length,
      )
      .toBe(1);
    await zoom(around([portrait], 30));
    await k.hold(900);
  });

  // ── Cropped by its frame to the portrait's. ──
  await k.scene("crop", async () => {
    const placed = (await pictures()).find((i) => !before.has(i.id.id))!;
    // ⌘ held while dragging, as the modifier hints say, ignores snapping:
    // the corner stops on the portrait's own (an edge nearby pulled it
    // 6 pt off).
    await pointer.drag(
      await at(placed.local[3], placed.local[2]),
      await at(portrait[3], portrait[2]),
      { speed: 0.9, hold: "Meta" },
    );
    await expect
      .poll(async () =>
        (await pictures())
          .find((i) => i.id.id === placed.id.id)
          ?.local.map(Math.round),
      )
      .toEqual([
        Math.round(placed.local[0]),
        Math.round(placed.local[1]),
        Math.round(portrait[2]),
        Math.round(portrait[3]),
      ]);
    await deselect();
    await k.hold(900);
  });

  // ── Every command by name. ──
  await k.scene("palette", async () => {
    k.unfocus();
    await k.key("Meta+k", "Command palette", "⌘K");
    await k.hold(300);
    await typeHuman(page, "show text threads", 11);
    await k.hold(300);
    await press(
      k,
      page
        .locator('[role="option"], [cmdk-item]')
        .filter({ hasText: /^Show text threads/ })
        .first(),
    );
    await expect(page.locator("[data-thread-hop]")).toHaveCount(0);
    await k.hold(600);
  });

  // ── The workspace follows the job. ──
  await k.scene("modes", async () => {
    const mode = () =>
      page.evaluate(
        () =>
          (globalThis as unknown as { __canvas: { mode?: string } }).__canvas
            .mode ?? null,
      );
    for (const [label, id] of [
      ["Content", "content"],
      ["Export", "export"],
      ["Design", "design"],
    ] as const) {
      await press(
        k,
        page.getByRole("button", { name: label, exact: true }).last(),
      );
      await expect.poll(mode).toBe(id);
      await k.hold(label === "Design" ? 400 : 1000);
    }
  });
});
