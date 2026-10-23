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

// The palette commands on the real engine (the published canvas-wasm,
// headless) and the real slide wasm, with a pages backend standing in for
// the editor's viewport: a PowerPoint-authored deck is opened, a slide made
// active, and each slide verb is run as the palette runs it (no payload).
// Each lands as ONE undo step; `when` follows the active slide.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { covers, waitFor } from "@paged-media/test-kit";

import type { CommandContribution } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import slideBundle from "../../src/index";
import { CMD } from "../../src/commands";
import { IMPORT_PPTX_COMMAND } from "../../src/object-model";
import { SLIDE_KEY } from "../../src/slides-model";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = new URL(
  "../../../../slide-conformance/fixtures/placeholders.pptx",
  import.meta.url,
);

type PageRow = {
  selfId: string;
  pluginMetadata?: Array<{ key: string; value: string }>;
};

let h: HeadlessHost;
let active: string | null = null;
const listeners = new Set<(p: string | null) => void>();

const pages = async () =>
  (await h.host.document.collection<PageRow>("pages")).map((p) => p.selfId);

function command(id: string): CommandContribution {
  const c = h.contributions.find((x) => x.kind === "command" && x.id === id);
  if (!c) throw new Error(`${id} is not registered`);
  return c.value as CommandContribution;
}
const applies = (id: string) => {
  const w = command(id).when;
  return typeof w === "function" ? w(null) : true;
};
const run = (id: string) => command(id).handler(null);

/** Make page `id` the active one, as scrolling the viewport does. */
async function activate(id: string | null): Promise<void> {
  active = id;
  for (const l of listeners) l(id);
}

beforeEach(async () => {
  active = null;
  listeners.clear();
  h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    pages: {
      goToPage: (id: string) => {
        void activate(id);
        return true;
      },
      activePage: () => active,
      onDidChangeActivePage: (l: (p: string | null) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
  });
  h.loadBundle(slideBundle);
});
afterEach(() => h.dispose());

async function openDeck(): Promise<string[]> {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  await h.objects.invoke(IMPORT_PPTX_COMMAND, {
    bytes,
    name: "placeholders.pptx",
  });
  const order = await pages();
  await activate(order[1]);
  // The store reads the deck after the open.
  await waitFor(() => expect(applies(CMD.newSlide)).toBe(true));
  return order;
}

describe("paged.slide palette commands, headless", () => {
  it("are offered only once a deck is open and a slide is active", async () => {
    await h.newBlank(612, 792);
    for (const id of [
      CMD.newSlide,
      CMD.duplicateSlide,
      CMD.deleteSlide,
      CMD.moveSlideUp,
      CMD.moveSlideDown,
    ])
      expect(applies(id), id).toBe(false);
    // A bare invoke outside a deck changes nothing and does not throw.
    const before = await pages();
    await run(CMD.newSlide);
    await run(CMD.deleteSlide);
    expect(await pages()).toEqual(before);

    const order = await openDeck();
    expect(applies(CMD.moveSlideUp)).toBe(true);
    await activate(order[0]);
    await waitFor(() => expect(applies(CMD.moveSlideUp)).toBe(false));
    expect(applies(CMD.moveSlideDown)).toBe(true);
  }, 60_000);

  it("New slide adds one slide after the active one from its layout; one undo removes it", async () => {
    covers("command:media.paged.slide.command.newSlide");
    const order = await openDeck();
    await run(CMD.newSlide);
    const after = await pages();
    expect(after.length).toBe(order.length + 1);
    const made = after[2];
    expect(order).not.toContain(made);
    // It goes to the new slide, which carries the layout of the one before.
    expect(active).toBe(made);
    const rows = await h.host.document.collection<PageRow>("pages");
    const layout = (id: string) =>
      JSON.parse(
        rows
          .find((p) => p.selfId === id)!
          .pluginMetadata!.find((m) => m.key === SLIDE_KEY)!.value,
      ).data.layout;
    expect(layout(made)).toBe(layout(order[1]));
    await h.host.document.undo();
    expect(await pages()).toEqual(order);
  }, 60_000);

  it("Duplicate slide copies the active slide right after it; one undo removes it", async () => {
    covers("command:media.paged.slide.command.duplicateSlide");
    const order = await openDeck();
    await run(CMD.duplicateSlide);
    const after = await pages();
    expect(after.length).toBe(order.length + 1);
    expect(after.slice(0, 2)).toEqual(order.slice(0, 2));
    expect(after.slice(3)).toEqual(order.slice(2));
    await h.host.document.undo();
    expect(await pages()).toEqual(order);
  }, 60_000);

  it("Delete slide removes the active slide; one undo brings it back", async () => {
    covers("command:media.paged.slide.command.deleteSlide");
    const order = await openDeck();
    await run(CMD.deleteSlide);
    expect(await pages()).toEqual(order.filter((p) => p !== order[1]));
    await h.host.document.undo();
    expect(await pages()).toEqual(order);
  }, 60_000);

  it("Move slide up and down swap the active slide with its neighbour, one undo step each", async () => {
    covers("command:media.paged.slide.command.moveSlideUp");
    covers("command:media.paged.slide.command.moveSlideDown");
    const order = await openDeck();
    await run(CMD.moveSlideUp);
    expect((await pages()).slice(0, 2)).toEqual([order[1], order[0]]);
    await h.host.document.undo();
    expect(await pages()).toEqual(order);
    await run(CMD.moveSlideDown);
    expect((await pages()).slice(0, 3)).toEqual([order[0], order[2], order[1]]);
    await h.host.document.undo();
    expect(await pages()).toEqual(order);
  }, 60_000);
});
