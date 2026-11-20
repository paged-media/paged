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

import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "./film";
import { press } from "./ui";

/** A sample a film uses, and the places in it the film goes. */
export interface SampleRef {
  /** The catalog id. */
  sample: string;
  /** Text of the window title once it is open (part of the title). */
  title: string;
  /** Document Map rows ("Pages 4–5") the film visits. */
  spreads?: string[];
  /** A page index (0-based) the film jumps to. */
  page?: number;
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

/** To page index `n` by the editor's go-to-page command (off camera, in a
 *  cut): a long document's Document Map is still filling while it prepares. */
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
