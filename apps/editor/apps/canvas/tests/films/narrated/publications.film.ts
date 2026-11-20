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

// Real publications, the film (ADR 224): the website's
// `films/publications.yaml`. Publications read back from their PDFs (publish
// ADR 660) and offered as sample documents (editor ADR 1243): a magazine, its
// spreads and masters, a story typed into and flowing
// on through its threaded frames, its paragraph styles, then a long catalogue
// and an annual report's tables. Which samples, spreads and story the take
// uses is the storyboard's data (`films/publications.take.json` beside it),
// not this file's. The take needs the samples: the module host's catalog, or
// a local one named by VITE_SAMPLES_URL.

import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { film } from "../kit/film";
import { typeHuman } from "../kit/pointer";
import { menu, press } from "../kit/ui";
import { goTo, jumpTo, opened, storyLengths } from "../kit/samples";

/** The documents the take opens and where it goes in them. */
interface Take {
  magazine: {
    sample: string;
    title: string;
    spreads: string[];
    story: { spread: string; words: string; insert: string };
  };
  catalogue: { sample: string; title: string; spread: string };
  report: { sample: string; title: string; page: number };
}

const TAKE = (): Take =>
  JSON.parse(
    readFileSync(
      join(
        process.env.PAGED_MEDIA_ROOT ?? "",
        "films",
        "publications.take.json",
      ),
      "utf8",
    ),
  ) as Take;

type Bounds = [number, number, number, number]; // top, left, bottom, right (pt)

interface Item {
  id: { kind: string; id: string };
  bounds: Bounds;
  hasImage: boolean;
  storyId?: string;
}

/** Every page item with its bounds and its story. */
async function items(page: Page): Promise<Item[]> {
  return page.evaluate(async () => {
    type Node = { id?: { kind: string; id: string } | null; children?: Node[] };
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            executeScript(s: string): Promise<{ output: string[] }>;
            send(m: unknown): Promise<{ payload: { items?: unknown[] } }>;
          };
        };
      }
    ).__canvas;
    const r = await c.client.executeScript("JSON.stringify(paged.tree())");
    const ids: { kind: string; id: string }[] = [];
    const walk = (n: Node) => {
      if (n.id) ids.push(n.id);
      for (const ch of n.children ?? []) walk(ch);
    };
    for (const root of JSON.parse(JSON.parse(r.output[0])) as Node[])
      walk(root);
    const g = await c.client.send({
      kind: "requestElementGeometry",
      payload: { ids },
    });
    return (g.payload.items ?? []) as Item[];
  });
}

/** A story's paragraphs as text. */
async function storyText(page: Page, storyId: string): Promise<string[]> {
  return page.evaluate(async (sid) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            send(m: unknown): Promise<{
              payload: {
                content?: {
                  paragraphs: Array<{ runs: Array<{ text: string }> }>;
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
    return (r.payload.content?.paragraphs ?? []).map((p) =>
      p.runs.map((x) => x.text).join(""),
    );
  }, storyId);
}

/** The story whose text has `words`, and its frames. */
async function storyWith(
  page: Page,
  words: string,
): Promise<{ storyId: string; frames: Item[] }> {
  const all = await items(page);
  const stories = [
    ...new Set(all.map((i) => i.storyId).filter(Boolean)),
  ] as string[];
  for (const sid of stories) {
    if ((await storyText(page, sid)).some((p) => p.includes(words))) {
      return { storyId: sid, frames: all.filter((i) => i.storyId === sid) };
    }
  }
  throw new Error(`no story has "${words}"`);
}

/** To a spread through the Document Map's row for it ("Pages 4–5"):
 *  the row scrolled into view and settled before the click, and the page
 *  bar's "N / total" showing its first page after it. */

film("publications", async (k) => {
  const { page } = k;
  const take = TAKE();
  const titled = (t: string) =>
    new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  // The camera rolls on the GPU renderer, which a document starts: the
  // magazine is opened by its sample link before the roll.
  await k.setup(async () => {
    await k.designer.open({ search: `?sample=${take.magazine.sample}` });
    await opened(page, titled(take.magazine.title));
    await k.hold(1500);
  });
  await k.roll();

  // ── A real magazine, open in the browser. ──
  await k.scene("open", async () => {
    await k.recamera();
    await k.hold(2600);
  });

  // ── Its spreads, masters and page numbers. ──
  await k.scene("spreads", async () => {
    for (const spread of take.magazine.spreads) {
      await goTo(k, spread);
      await k.hold(1600);
    }
  });

  // ── Typed into: the story flows on through its threaded frames. ──
  const { spread: storySpread, words: WORDS, insert } = take.magazine.story;
  await k.scene("edit", async () => {
    await goTo(k, storySpread);
    await menu(k, ["View", "Editing aids", "Text threads"]);
    await k.hold(500);
    const { storyId, frames } = await storyWith(page, WORDS);
    expect(frames.length).toBeGreaterThan(1);
    const before = await storyLengths(page);
    await press(k, page.getByRole("button", { name: "Type (T)" }));
    await k.hold(400);
    // The view on the story's first frame (selected, then fitted), and the
    // caret at the story's first character.
    await k.designer.selectElement(frames[0].id.kind, frames[0].id.id);
    await menu(k, ["View", "Fit selection in window"]);
    await k.hold(900);
    await k.recamera();
    await k.designer.placeCaret(storyId, 0);
    await k.hold(400);
    await typeHuman(page, insert);
    await expect
      .poll(async () =>
        (await storyLengths(page))
          .map((n, i) => n - (before[i] ?? 0))
          .filter((d) => d !== 0),
      )
      .toEqual([insert.length]);
    await k.hold(1500);
    await press(k, page.locator('[data-tool-slot="select"]').first());
    await menu(k, ["View", "Fit spread in window"]);
    await k.hold(600);
    await k.recamera();
    await k.hold(500);
  });

  // ── Every paragraph in its style. ──
  await k.scene("styles", async () => {
    await press(k, page.getByRole("button", { name: "Styles" }).last());
    await k.hold(2600);
  });

  // ── A catalogue of 654 pages, opened the same way. ──
  await k.cut("Opening the catalogue", async () => {
    await k.designer.open({ search: `?sample=${take.catalogue.sample}` });
    await opened(page, titled(take.catalogue.title));
    await k.recamera();
  });
  await k.scene("catalogue", async () => {
    await k.hold(1200);
    await goTo(k, take.catalogue.spread);
    await k.hold(2200);
  });

  // ── An annual report: its tables, set with tabs. ──
  await k.cut("Opening the annual report", async () => {
    await k.designer.open({ search: `?sample=${take.report.sample}` });
    await opened(page, titled(take.report.title));
    await jumpTo(k, take.report.page);
  });
  await k.scene("report", async () => {
    await k.hold(2400);
  });

  await k.scene("read", async () => {
    await k.hold(2400);
  });
});
