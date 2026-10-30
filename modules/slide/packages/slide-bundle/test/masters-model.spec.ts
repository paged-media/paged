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

// Slide masters and layouts, UNIT (slide ADR 712): the reading of the
// engine's master pages, the mutations the Slide Master view and the slide
// verbs build, and the palette commands over a stub host. The same verbs
// on the real engine: test/headless/masters.spec.ts.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  contributeMasterCommands,
  MASTER_CMD,
  MASTER_VIEW,
  masterTypedCommands,
} from "../src/masters-commands";
import {
  bare,
  deleteLayoutMutation,
  fills,
  insertPlaceholderMutation,
  newSlideMutation,
  placeholdersOf,
  preserveMutation,
  readMasters,
  type MasterSpread,
} from "../src/masters-model";
import { SLIDE_KEY } from "../src/slides-model";

const ph = (type: string, idx: number | null, shape: string) => ({
  key: SLIDE_KEY,
  value: JSON.stringify({ v: 1, data: { shape, placeholder: { type, idx } } }),
});

const layout = (over: Partial<MasterSpread> = {}): MasterSpread => ({
  masterId: "m1",
  pageId: "m1pg",
  name: "Title Slide",
  kind: "layout",
  part: "ppt/slideLayouts/slideLayout1.xml",
  preserve: false,
  basedOn: "M1",
  overrides: [],
  sizePt: [960, 540],
  placeholders: [
    {
      type: "title",
      idx: null,
      name: "Title 1",
      shape: "L#2",
      elements: [
        { kind: "polygon", id: "u5p" },
        { kind: "textFrame", id: "u5t" },
      ],
    },
    {
      type: "dt",
      idx: 10,
      name: "Date",
      shape: "L#4",
      elements: [{ kind: "textFrame", id: "u7t" }],
    },
  ],
  slides: 0,
  ...over,
});

describe("masters and layouts", () => {
  it("groups a placeholder's elements by its shape key", () => {
    const rows = placeholdersOf([
      {
        id: { kind: "polygon", id: "a" },
        kind: "Polygon",
        pluginMetadata: [ph("title", null, "L#2")],
      },
      {
        id: { kind: "textFrame", id: "b" },
        kind: "TextFrame",
        pluginMetadata: [ph("title", null, "L#2")],
      },
      {
        id: { kind: "textFrame", id: "c" },
        kind: "TextFrame",
        pluginMetadata: [ph("body", 1, "L#3")],
      },
      { id: { kind: "polygon", id: "d" }, kind: "Polygon", pluginMetadata: [] },
    ]);
    expect(
      rows.map((r) => [r.type, r.idx, r.elements.map((e) => e.id)]),
    ).toEqual([
      ["title", null, ["a", "b"]],
      ["body", 1, ["c"]],
    ]);
  });

  it("matches placeholders by index, else by type", () => {
    expect(fills({ type: "body", idx: 1 }, { type: "obj", idx: 1 })).toBe(true);
    expect(fills({ type: "body", idx: 2 }, { type: "body", idx: 1 })).toBe(
      false,
    );
    expect(
      fills({ type: "title", idx: null }, { type: "title", idx: null }),
    ).toBe(true);
    expect(bare("MasterSpread/m3")).toBe("m3");
    expect(bare("n")).toBeNull();
  });

  it("reads masters first, each with its layouts, from the engine's master pages", async () => {
    const label = (d: unknown) => [
      { key: SLIDE_KEY, value: JSON.stringify({ v: 1, data: { master: d } }) },
    ];
    const host = {
      document: {
        collection: async (name: string) =>
          name === "masterPages"
            ? [
                {
                  selfId: "m2",
                  label: "Blank",
                  pages: [
                    {
                      selfId: "m2pg",
                      appliedMaster: "M1",
                      pluginMetadata: label({ kind: "layout", type: "blank" }),
                    },
                  ],
                  items: [],
                },
                {
                  selfId: "M1",
                  label: "Office",
                  pages: [
                    {
                      selfId: "M1pg",
                      appliedMaster: "n",
                      pluginMetadata: label({ kind: "master" }),
                    },
                  ],
                  items: [],
                },
                {
                  selfId: "m1",
                  label: "Title",
                  pages: [
                    {
                      selfId: "m1pg",
                      appliedMaster: "M1",
                      pluginMetadata: label({ kind: "layout", preserve: true }),
                    },
                  ],
                  items: [],
                },
              ]
            : [
                { selfId: "p1", appliedMaster: "m1" },
                { selfId: "p2", appliedMaster: "m1" },
              ],
      },
    } as unknown as BundleHost;
    const ms = await readMasters(host);
    expect(ms.map((m) => [m.masterId, m.kind, m.slides])).toEqual([
      ["M1", "master", 0],
      ["m1", "layout", 2],
      ["m2", "layout", 0],
    ]);
    expect(ms[1]!.preserve).toBe(true);
    expect(ms[2]!.type).toBe("blank");
  });

  it("builds the view's mutations", () => {
    const l = layout();
    expect(deleteLayoutMutation({ ...l, slides: 2 }, [l])).toBe(
      "Title Slide is used by 2 slides",
    );
    expect(deleteLayoutMutation(l, [l])).toEqual({
      op: "deleteMaster",
      args: { master: "m1" },
    });
    const pres = preserveMutation(l, true) as {
      op: string;
      args: { mutation: { args: { value: string } } };
    };
    expect(pres.op).toBe("onMaster");
    expect(JSON.parse(pres.args.mutation.args.value).data.master.preserve).toBe(
      true,
    );
    const ins = insertPlaceholderMutation(l, "body") as unknown as {
      args: { ops: { op: string; args: Record<string, unknown> }[] };
    };
    expect(ins.args.ops.map((o) => o.op)).toEqual([
      "onMaster",
      "bindCreated",
      "insertText",
      "onMaster",
    ]);
    // The first free index is 1 (the date has 10).
    const meta = (ins.args.ops[3]!.args.mutation as { args: { value: string } })
      .args.value;
    expect(JSON.parse(meta).data.placeholder).toEqual({ type: "body", idx: 1 });
  });

  it("makes a new slide of the layout's placeholders, footers left out, in one batch", () => {
    const m = newSlideMutation(layout(), "p1") as unknown as {
      op: string;
      args: { ops: { op: string; args: Record<string, unknown> }[] };
    };
    expect(m.op).toBe("batch");
    expect(m.args.ops.map((o) => o.op)).toEqual([
      "insertPage",
      "bindCreated",
      "overrideMasterItems",
      "setPageOverrides",
      "setPageMetadata",
    ]);
    expect(m.args.ops[2]!.args).toEqual({
      page: "$h:slide",
      items: ["u5p", "u5t"],
      emptyText: true,
    });
    expect(m.args.ops[3]!.args.overrides).toEqual(["u5p", "u5t", "u7t"]);
  });

  it("offers View ▸ Slide Master and Reset Slide as palette commands", () => {
    covers("command:media.paged.slide.command.slideMaster");
    covers("command:media.paged.slide.command.resetSlide");
    const commands: {
      id: string;
      when: () => boolean;
      handler: () => unknown;
    }[] = [];
    let shown: string | null = null;
    const host = {
      contribute: {
        command: (c: (typeof commands)[number]) => {
          commands.push(c);
          return { dispose() {} };
        },
        menu: () => ({ dispose() {} }),
      },
      supports: () => true,
      shell: {
        activeView: () => shown,
        showView: (id: string | null) => {
          shown = id;
          return true;
        },
      },
      log: { warn() {}, info() {} },
    } as unknown as BundleHost;
    const c = contributeMasterCommands(host, {
      activePage: () => null,
      deckOpen: () => true,
      views: true,
    });
    expect([...c.ids]).toEqual([MASTER_CMD.slideMaster, MASTER_CMD.resetSlide]);
    const master = commands.find((x) => x.id === MASTER_CMD.slideMaster)!;
    expect(master.when()).toBe(true);
    master.handler();
    expect(shown).toBe(MASTER_VIEW);
    master.handler();
    expect(shown).toBeNull();
    // Reset Slide needs an active slide.
    expect(commands.find((x) => x.id === MASTER_CMD.resetSlide)!.when()).toBe(
      false,
    );
    c.dispose();
  });

  it("runs the typed commands against the host's doors", async () => {
    covers(
      "command:media.paged.slide.layouts",
      "command:media.paged.slide.renameLayout",
      "command:media.paged.slide.setPreserve",
      "command:media.paged.slide.deleteLayout",
      "command:media.paged.slide.insertPlaceholder",
      "command:media.paged.slide.setPlaceholderStyle",
      "command:media.paged.slide.changeLayout",
    );
    const label = (d: unknown) => [
      { key: SLIDE_KEY, value: JSON.stringify({ v: 1, data: { master: d } }) },
    ];
    const title = (id: string, kind: string) => ({
      id: { kind, id },
      kind,
      label: "Title 1",
      pluginMetadata: [ph("title", null, "L#2")],
    });
    const sent: { op: string; args: Record<string, unknown> }[] = [];
    const host = {
      supports: () => true,
      document: {
        collection: async (name: string) => {
          if (name === "masterPages")
            return [
              {
                selfId: "M1",
                label: "Office",
                pages: [
                  {
                    selfId: "M1pg",
                    appliedMaster: "n",
                    pluginMetadata: label({ kind: "master" }),
                  },
                ],
                items: [],
              },
              {
                selfId: "m1",
                label: "Title",
                pages: [
                  {
                    selfId: "m1pg",
                    appliedMaster: "M1",
                    pluginMetadata: label({ kind: "layout" }),
                  },
                ],
                items: [title("u5t", "textFrame")],
              },
              {
                selfId: "m2",
                label: "Blank",
                pages: [
                  {
                    selfId: "m2pg",
                    appliedMaster: "M1",
                    pluginMetadata: label({ kind: "layout" }),
                  },
                ],
                items: [],
              },
            ];
          if (name === "pages")
            return [{ selfId: "p1", appliedMaster: "m1", pluginMetadata: [] }];
          if (name === "stories") return [{ selfId: "Story/1" }];
          return [];
        },
        tree: async () => [
          {
            kind: "Spread",
            children: [{ kind: "Page", children: [title("s5t", "textFrame")] }],
          },
        ],
        frameChain: async () => [{ frameId: "u5t" }],
        storyContent: async () => ({
          paragraphs: [{ runs: [{ text: "Click" }] }],
        }),
        elementProperties: async () => ({
          entries: [
            { path: "characterFontSize", value: { type: "length", value: 44 } },
          ],
        }),
        elementGeometry: async (ids: { id: string }[]) =>
          ids.map((id) => ({
            id,
            itemTransform: [1, 0, 0, 1, 0, 0],
            bounds: [0, 0, 10, 10],
          })),
        mutate: async (m: { op: string; args: Record<string, unknown> }) => {
          sent.push(m);
          return { applied: true, createdId: null, pageIds: [] };
        },
      },
    } as unknown as BundleHost;
    const cmds = new Map(
      masterTypedCommands(host, {
        activePage: () => "p1",
        deckOpen: () => true,
        views: false,
      }).map((c) => [c.id, c]),
    );
    const run = (id: string, args: object) =>
      (cmds.get(id)!.handler as (ctx: unknown, a: object) => Promise<unknown>)(
        {},
        args,
      );
    const listed = (await run("media.paged.slide.layouts", {})) as {
      layouts: { kind: string }[];
    };
    expect(listed.layouts.map((l) => l.kind)).toEqual([
      "master",
      "layout",
      "layout",
    ]);
    await run("media.paged.slide.renameLayout", {
      layout: "m2",
      name: "Empty",
    });
    await run("media.paged.slide.setPreserve", {
      layout: "m2",
      preserve: true,
    });
    await run("media.paged.slide.deleteLayout", { layout: "m2" });
    await expect(
      run("media.paged.slide.deleteLayout", { layout: "m1" }),
    ).rejects.toThrow(/used by 1 slide/);
    await run("media.paged.slide.insertPlaceholder", {
      layout: "m2",
      type: "pic",
    });
    await run("media.paged.slide.setPlaceholderStyle", {
      layout: "m1",
      type: "title",
      size: 60,
    });
    await run("media.paged.slide.changeLayout", { slide: "p1", layout: "m2" });
    expect(sent.map((m) => m.op)).toEqual([
      "renameMaster",
      "onMaster",
      "deleteMaster",
      "batch",
      "batch",
      "batch",
    ]);
    const change = sent[5]!.args.ops as { op: string }[];
    expect(change[0]!.op).toBe("applyMasterToPage");
    expect(change.at(-2)!.op).toBe("setPageOverrides");
  });
});
