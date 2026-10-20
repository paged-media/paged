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

// A placed Word document is native text (paged.doc lowers it to host
// stories, and its edit context names the host's own Type tool), so a
// Type-tool click in it must place the caret there. The owned-content
// entry used to swallow that click: the Word context opened, and no caret
// ever arrived, so the copy could not be typed into or formatted.

import { test, expect } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Designer } from "../journey/driver/designer";
import { activateTool, screenPoint } from "./harness/viewport";

type Page = import("@playwright/test").Page;

const DOCX = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "harness/doc-memo.docx",
);
const PLACE_CMD = "media.paged.doc.command.placeDoc";

type CanvasGlobal = {
  __canvas: {
    registries: { commands: { invoke: (id: string) => Promise<unknown> } };
    contentSelection?: { storyId: string; start: number } | null;
    client: {
      executeScript(s: string): Promise<{ output: string[] }>;
      send(m: unknown): Promise<{ payload: { items?: unknown[] } }>;
    };
  };
};

/** The placed Word frame: its story and its page-local bounds. */
async function wordFrame(page: Page): Promise<{
  storyId: string;
  bounds: [number, number, number, number];
} | null> {
  return page.evaluate(async () => {
    type Node = {
      id?: { kind: string; id: string } | null;
      children?: Node[];
      pluginMetadata?: Array<{ key: string }>;
    };
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("JSON.stringify(paged.tree())");
    let id: { kind: string; id: string } | null = null;
    const walk = (n: Node) => {
      if (n.pluginMetadata?.some((m) => m.key === "x-paged:media.paged.doc"))
        id = n.id ?? null;
      for (const ch of n.children ?? []) walk(ch);
    };
    for (const root of JSON.parse(JSON.parse(r.output[0])) as Node[])
      walk(root);
    if (!id) return null;
    const g = await c.send({
      kind: "requestElementGeometry",
      payload: { ids: [id] },
    });
    const item = (g.payload.items ?? [])[0] as
      | { storyId?: string; bounds: [number, number, number, number] }
      | undefined;
    return item?.storyId
      ? { storyId: item.storyId, bounds: item.bounds }
      : null;
  });
}

const storyLength = (page: Page, storyId: string) =>
  page.evaluate(async (sid) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.stories()");
    const list = JSON.parse(r.output[0]) as Array<{
      selfId: string;
      characterCount: number;
    }>;
    return (
      list.find((s) => s.selfId === sid || s.selfId.endsWith(`/${sid}`))
        ?.characterCount ?? -1
    );
  }, storyId);

test("a Type-tool click in a placed Word document places the caret in its story @feat:plugin-doc.edit-context @level:gesture", async ({
  page,
}) => {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();

  const chooser = page.waitForEvent("filechooser");
  const placed = page.evaluate(
    (id) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(id),
    PLACE_CMD,
  );
  await (await chooser).setFiles(DOCX);
  await placed;
  await expect.poll(() => wordFrame(page), { timeout: 15_000 }).not.toBeNull();
  const frame = (await wordFrame(page))!;

  // Into the first line of the copy, with the Type tool.
  await activateTool(page, "type");
  const [top, left, , right] = frame.bounds;
  const at = await screenPoint(page, left + (right - left) / 3, top + 6);
  await page.mouse.click(at.x, at.y);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as CanvasGlobal).__canvas.contentSelection
              ?.storyId ?? null,
        ),
      { timeout: 5_000 },
    )
    .toMatch(new RegExp(`${frame.storyId.replace(/^Story\//, "")}$`));

  // And the caret takes typing, into the Word story.
  const before = await storyLength(page, frame.storyId);
  await page.keyboard.type("x");
  await expect.poll(() => storyLength(page, frame.storyId)).toBe(before + 1);
});
