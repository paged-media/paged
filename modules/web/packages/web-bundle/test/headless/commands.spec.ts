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

// The seven paged.web commands and the .html importer on the REAL engine
// (the headless host; the Blitz engine wasm for the render and bake ones):
// each fired through its registered handler, asserting what it does to the
// document, when it does nothing, and that undo takes it back.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  BundleHost,
  CommandContribution,
  ElementId,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";
import { DEFAULT_SOURCE, type WebFrameSource } from "@paged-media/web-model";

import { webBundle } from "../../src";
import { resolveFlowChain } from "../../src/render-flow-command";
import { loadWebSource } from "../../src/source-part";
import { writeWebSource } from "../../src/source-part";
import {
  blitzPresent,
  layerText,
  primeBlitz,
  recordScene,
  requireBlitz,
  type SceneRecord,
} from "../conformance/blitz";
import { openHost } from "../conformance/host";
import { W1_EMPTY_PAGE } from "../fixtures/corpus";

requireBlitz("web headless — the commands");

const C = "media.paged.web.command.";
let h: HeadlessHost;
let host: BundleHost;
let rec: SceneRecord;

const fire = (id: string): Promise<unknown> => {
  const c = h.contributions.find((x) => x.kind === "command" && x.id === id);
  if (!c) throw new Error(`no command ${id}`);
  return Promise.resolve((c.value as CommandContribution).handler(undefined));
};
const idOf = (e: ElementId): string => (e as { id: string }).id;

/** The selectable page items, by id. */
async function items(): Promise<string[]> {
  const out: string[] = [];
  const walk = (
    nodes: Array<{ id?: { id?: string } | null; children?: unknown[] }>,
  ) => {
    for (const n of nodes) {
      if (n.id?.id) out.push(n.id.id);
      if (n.children) walk(n.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out.sort();
}

/** Insert a web frame through the command and answer it (it is selected). */
async function insert(): Promise<ElementId> {
  await fire(`${C}insertWebFrame`);
  return h.host.selection.get()[0]!;
}

beforeEach(async () => {
  h = await openHost();
  await h.load(W1_EMPTY_PAGE.bytes());
  rec = recordScene(h);
  h.loadBundle(webBundle);
  host = h.host as unknown as BundleHost;
}, 60_000);

afterEach(() => h?.dispose());

describe("paged.web commands on the real engine", () => {
  it("insertWebFrame adds one frame carrying the default source, selects it; one undo removes it", async () => {
    covers("command:media.paged.web.command.insertWebFrame");
    const before = await items();
    const id = await insert();
    expect(await items()).toEqual([...before, idOf(id)].sort());
    expect(await loadWebSource(host, id)).toEqual(DEFAULT_SOURCE);
    await h.host.document.undo();
    expect(await items()).toEqual(before);
  });

  it("threadWebFlow persists the selected frames as the source's region chain; undo unthreads", async () => {
    covers("command:media.paged.web.command.threadWebFlow");
    const source = await insert();
    const recipient = await insert();
    await h.host.selection.set([source, recipient]);
    await fire(`${C}threadWebFlow`);
    expect((await resolveFlowChain(host, [source]))!.map(idOf)).toEqual([
      idOf(source),
      idOf(recipient),
    ]);
    await h.host.document.undo();
    expect(await resolveFlowChain(host, [source])).toBeNull();
  });

  it("threadWebFlow with one frame selected threads nothing", async () => {
    covers("command:media.paged.web.command.threadWebFlow");
    const source = await insert();
    await h.host.selection.set([source]);
    await fire(`${C}threadWebFlow`);
    expect(await resolveFlowChain(host, [source])).toBeNull();
  });

  it("unthreadWebFlow takes the selected recipient out of the chain; undo puts it back", async () => {
    covers("command:media.paged.web.command.unthreadWebFlow");
    const source = await insert();
    const recipient = await insert();
    await h.host.selection.set([source, recipient]);
    await fire(`${C}threadWebFlow`);
    await h.host.selection.set([source, recipient]);
    await fire(`${C}unthreadWebFlow`);
    expect(await resolveFlowChain(host, [source])).toBeNull();
    await h.host.document.undo();
    expect((await resolveFlowChain(host, [source]))!.map(idOf)).toEqual([
      idOf(source),
      idOf(recipient),
    ]);
  });

  it("threadWebFlowNamed routes the selected frame into the source's second named flow; undo takes it out", async () => {
    covers("command:media.paged.web.command.threadWebFlowNamed");
    const source = await insert();
    const target = await insert();
    const twoFlows: WebFrameSource = {
      ...DEFAULT_SOURCE,
      html: '<div id="story">Main</div><div id="notes">Side</div>',
      css: "#story{flow-into:main} #notes{flow-into:side}",
    };
    expect((await writeWebSource(host, source, twoFlows)).applied).toBe(true);
    await h.host.selection.set([source, target]);
    await fire(`${C}threadWebFlowNamed`);
    expect((await loadWebSource(host, source))?.flow?.recipients).toEqual([
      { ...(target as object), flow: "side" },
    ]);
    await h.host.document.undo();
    expect((await loadWebSource(host, source))?.flow).toBeUndefined();
  });

  it("threadWebFlowNamed does nothing when the source declares one flow only", async () => {
    covers("command:media.paged.web.command.threadWebFlowNamed");
    const source = await insert();
    const target = await insert();
    await h.host.selection.set([source, target]);
    await fire(`${C}threadWebFlowNamed`);
    expect((await loadWebSource(host, source))?.flow).toBeUndefined();
  });
});

describe.skipIf(!blitzPresent)(
  "paged.web render and bake commands on the real engine (unavailable without bin/blitz_web_bg.wasm: bash scripts/build-wasm.sh --engine; REQUIRE_REAL_ENGINE=1 fails instead)",
  () => {
    const SOURCE: WebFrameSource = {
      ...DEFAULT_SOURCE,
      html: '<div class="box"><p>Rendered here</p></div>',
      css: "body{margin:0}.box{background:#cc3333;width:120px;height:80px}p{margin:0;color:#ffffff;font-size:24px}",
    };

    beforeEach(async () => {
      await primeBlitz(host);
    });

    it("renderWebFrame submits the selected frame's render as its scene layer, and changes no item", async () => {
      covers("command:media.paged.web.command.renderWebFrame");
      const id = await insert();
      expect((await writeWebSource(host, id, SOURCE)).applied).toBe(true);
      const before = await items();
      await h.host.selection.set([id]);
      await fire(`${C}renderWebFrame`);
      expect(layerText(rec.layers.get(idOf(id)))).toMatch(/Rendered\s+here/);
      expect(await items()).toEqual(before);
    });

    it("renderWebFrame with nothing selected renders nothing", async () => {
      covers("command:media.paged.web.command.renderWebFrame");
      const id = await insert();
      rec.layers.clear();
      await h.host.selection.set([]);
      await fire(`${C}renderWebFrame`);
      expect(rec.layers.has(idOf(id))).toBe(false);
    });

    it("renderWebFlow renders one source across its threaded frames, one layer per frame", async () => {
      covers("command:media.paged.web.command.renderWebFlow");
      const source = await insert();
      const recipient = await insert();
      const long: WebFrameSource = {
        ...DEFAULT_SOURCE,
        html: Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1}</p>`).join(
          "",
        ),
        css: "body{margin:0} p{margin:0;font-size:16px;line-height:20px}",
      };
      expect((await writeWebSource(host, source, long)).applied).toBe(true);
      await h.host.selection.set([source, recipient]);
      await fire(`${C}threadWebFlow`);
      rec.layers.clear();
      await h.host.selection.set([source]);
      await fire(`${C}renderWebFlow`);
      expect(layerText(rec.layers.get(idOf(source)))).toContain("Line 1");
      expect(rec.layers.has(idOf(recipient))).toBe(true);
    });

    it("bakeWebFrame turns the frame's render into native content in one undo step", async () => {
      covers("command:media.paged.web.command.bakeWebFrame");
      const id = await insert();
      expect((await writeWebSource(host, id, SOURCE)).applied).toBe(true);
      const stories = async () =>
        (await h.host.document.collection("stories")).length;
      const beforeItems = await items();
      const beforeStories = await stories();
      await h.host.selection.set([id]);
      await fire(`${C}bakeWebFrame`);
      // Native text now holds the words the render painted.
      expect(await stories()).toBeGreaterThan(beforeStories);
      expect((await items()).length).toBeGreaterThan(beforeItems.length);
      await h.host.document.undo();
      expect(await items()).toEqual(beforeItems);
      expect(await stories()).toBe(beforeStories);
    });

    it("bakeWebFrame on a frame that is not a web frame bakes nothing", async () => {
      covers("command:media.paged.web.command.bakeWebFrame");
      const out = await host.document.mutate({
        op: "insertFrame",
        args: { pageId: W1_EMPTY_PAGE.pageId, bounds: [10, 10, 50, 50] },
      } as never);
      if (!out.applied || !out.createdId) throw new Error("no frame created");
      const plain = out.createdId as ElementId;
      const before = await items();
      await h.host.selection.set([plain]);
      await fire(`${C}bakeWebFrame`);
      expect(await items()).toEqual(before);
    });
  },
);

describe("the .html importer on the real engine", () => {
  it("File ▸ Open of an .html file inserts a web frame with that page as its source, scripts removed; one undo removes it", async () => {
    covers("importer:media.paged.web.importer.html");
    const importer = h
      .importersContributed()
      .find((c) => c.id === "media.paged.web.importer.html")!;
    const before = await items();
    await importer.import({
      name: "page.html",
      bytes: new TextEncoder().encode(
        "<html><head><style>h1{color:red}</style></head><body><h1>Hello</h1><script>alert(1)</script></body></html>",
      ),
      mimeType: "text/html",
    });
    const [id] = h.host.selection.get();
    expect(await items()).toEqual([...before, idOf(id!)].sort());
    const source = await loadWebSource(host, id!);
    expect(source?.html).toContain("<h1>Hello</h1>");
    // Sanitised on ingest: page JavaScript never reaches the frame.
    expect(source?.html).not.toContain("<script");
    expect(source?.css).toContain("h1{color:red}");
    await h.host.document.undo();
    expect(await items()).toEqual(before);
  });
});
