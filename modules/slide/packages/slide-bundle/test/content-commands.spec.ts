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

// Slide W4's content commands without an engine: what is registered (the
// palette commands, their menu entries, the format painter's keys), what
// their typed twins answer, and the writes Paste formatting makes.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import {
  CONTENT_CMD,
  CONTENT_MENU,
  CONTENT_TYPED,
  contentTypedCommands,
  contributeContentCommands,
  FormatClipboard,
  FORMAT_KEYS,
  type ContentDeps,
} from "../src/content-commands";
import type { SlideEngine } from "../src/engine";
import { isShapeFormatPath, pasteOps } from "../src/format-painter";

type Cmd = { id: string; when?: () => boolean; handler: () => Promise<void> };

function fakeHost(opts: { selection?: ElementId[] } = {}) {
  const commands = new Map<string, Cmd>();
  const menus: { path: string; command: string }[] = [];
  const keys: {
    key: string;
    command: string;
    scope?: unknown;
    when?: () => boolean;
  }[] = [];
  const mutations: unknown[] = [];
  const host = {
    supports: () => true,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    selection: { get: () => opts.selection ?? [] },
    text: { selection: () => null },
    contribute: {
      command: (c: Cmd) => {
        commands.set(c.id, c);
        return { dispose: () => commands.delete(c.id) };
      },
      menu: (m: { path: string; command: string }) => {
        menus.push(m);
        return { dispose: () => menus.splice(menus.indexOf(m), 1) };
      },
      keybinding: (k: (typeof keys)[number]) => {
        keys.push(k);
        return { dispose: () => keys.splice(keys.indexOf(k), 1) };
      },
    },
    media: {
      store: async (_b: Uint8Array, o: { mime: string }) => ({
        type: "part",
        path: `paged/core/media/abc.${o.mime.startsWith("audio") ? "m4a" : "mp4"}`,
      }),
    },
    document: {
      collection: async () => [{ selfId: "p1", sizePt: [960, 540] }],
      mutateWithBytes: async (m: unknown) => {
        mutations.push(m);
        return {
          applied: true,
          createdId: null,
          pageIds: [],
          minted: [
            {
              handle: "pic",
              element: { kind: "rectangle", id: "r1" },
              storyId: null,
            },
          ],
        };
      },
    },
  } as unknown as BundleHost;
  return { host, commands, menus, keys, mutations };
}

const engine = {
  picture: (b: Uint8Array) =>
    b[0] === 0x3c
      ? {
          format: "svg",
          mime: "image/svg+xml",
          inDeck: false,
          width: 64,
          height: 32,
        }
      : b[0] === 0x89
        ? {
            format: "png",
            mime: "image/png",
            inDeck: true,
            width: 400,
            height: 200,
          }
        : null,
} as unknown as SlideEngine;

const deps = (over: Partial<ContentDeps> = {}): ContentDeps => ({
  engine: async () => engine,
  activePage: () => "p1",
  openTextPane: () => true,
  ...over,
});

describe("slide W4 content commands", () => {
  it("registers the palette commands, their menu entries and the painter's keys", () => {
    covers(
      "keybinding:cmd+shift+c→media.paged.slide.command.copyFormat",
      "keybinding:ctrl+shift+c→media.paged.slide.command.copyFormat",
      "keybinding:cmd+shift+v→media.paged.slide.command.pasteFormat",
      "keybinding:ctrl+shift+v→media.paged.slide.command.pasteFormat",
    );
    const f = fakeHost({
      selection: [{ kind: "polygon", id: "a" } as ElementId],
    });
    const clip = new FormatClipboard();
    const h = contributeContentCommands(f.host, deps(), clip, {
      deckOpen: () => true,
      scopedKeys: true,
      deckContext: "slideDeck",
    });
    expect([...f.commands.keys()].sort()).toEqual(
      Object.values(CONTENT_CMD).sort(),
    );
    expect(f.menus.map((m) => m.path)).toEqual(CONTENT_MENU.map(([p]) => p));
    expect(f.keys.map((k) => `${k.key}→${k.command}`)).toEqual(
      FORMAT_KEYS.map(([k, c]) => `${k}→${c}`),
    );
    // The keys live in the deck's context; paste waits for a copy.
    expect(
      f.keys.every(
        (k) => (k.scope as { editContext: string }).editContext === "slideDeck",
      ),
    ).toBe(true);
    expect(f.commands.get(CONTENT_CMD.copyFormat)!.when!()).toBe(true);
    expect(f.commands.get(CONTENT_CMD.pasteFormat)!.when!()).toBe(false);
    clip.copied = { shape: [], text: [] };
    expect(f.commands.get(CONTENT_CMD.pasteFormat)!.when!()).toBe(true);
    h.dispose();
    expect(f.commands.size + f.menus.length + f.keys.length).toBe(0);
  });

  it("the typed twins insert a video and a sound: the medium stored, poster and medium in one batch", async () => {
    covers(
      "command:media.paged.slide.command.insertVideo",
      "command:media.paged.slide.command.insertAudio",
    );
    const f = fakeHost();
    const cmds = new Map(
      contentTypedCommands(f.host, deps(), new FormatClipboard()).map((c) => [
        c.id,
        c,
      ]),
    );
    const run = (id: string, a: unknown) =>
      (cmds.get(id)!.handler as (c: unknown, a: unknown) => Promise<unknown>)(
        null,
        a,
      );
    const data = Buffer.from([0, 0, 0, 0x18]).toString("base64");
    expect(
      await run(CONTENT_CMD.insertVideo, { data, name: "clip.mp4", play: "auto" }),
    ).toEqual({ media: expect.stringContaining("r1") });
    const batch = f.mutations[0] as {
      args: { ops: { op: string; args: Record<string, unknown> }[] };
    };
    expect(batch.args.ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "bindCreated",
      "replaceImageBytes",
      "setElementProperty",
    ]);
    const set = batch.args.ops[3]!.args as {
      path: string;
      value: { type: string; value: Record<string, unknown> };
    };
    expect(set.path).toBe("frameMedia");
    expect(set.value.value).toMatchObject({
      kind: "movie",
      mime: "video/mp4",
      play: "auto",
      source: { type: "part", path: "paged/core/media/abc.mp4" },
    });
    expect(await run(CONTENT_CMD.insertAudio, { data, name: "tone.m4a" })).toHaveProperty(
      "media",
    );
    const sound = (
      f.mutations[1] as {
        args: { ops: { args: { value?: { value: { kind: string } } } }[] };
      }
    ).args.ops[3]!.args.value!.value;
    expect(sound.kind).toBe("sound");
    await expect(
      run(CONTENT_CMD.insertVideo, { data, name: "notes.txt" }),
    ).rejects.toThrow(/could not be inserted/);
  });

  it("the typed twins insert a picture, refuse a raster icon and answer the pane", async () => {
    covers(
      "command:media.paged.slide.command.insertPicture",
      "command:media.paged.slide.command.insertIcon",
      "command:media.paged.slide.command.smartArtText",
      "command:media.paged.slide.command.copyFormat",
      "command:media.paged.slide.command.pasteFormat",
      "command:media.paged.slide.smartArtPoints",
      "command:media.paged.slide.setSmartArtText",
    );
    const f = fakeHost();
    const cmds = new Map(
      contentTypedCommands(f.host, deps(), new FormatClipboard()).map((c) => [
        c.id,
        c,
      ]),
    );
    expect([...cmds.keys()].sort()).toEqual(
      [...Object.values(CONTENT_CMD), ...Object.values(CONTENT_TYPED)].sort(),
    );
    const run = (id: string, a: unknown) =>
      (cmds.get(id)!.handler as (c: unknown, a: unknown) => Promise<unknown>)(
        null,
        a,
      );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    expect(await run(CONTENT_CMD.insertPicture, { data: png })).toEqual({
      picture: expect.stringContaining("r1"),
    });
    // 400 × 200 px at 96 dpi: 300 × 150 pt, centred on the slide.
    const batch = f.mutations[0] as {
      args: { ops: { op: string; args: { bounds?: number[] } }[] };
    };
    expect(batch.args.ops[0]!.args.bounds).toEqual([195, 330, 345, 630]);
    expect(batch.args.ops.map((o) => o.op)).toEqual([
      "insertFrame",
      "bindCreated",
      "replaceImageBytes",
    ]);
    await expect(run(CONTENT_CMD.insertIcon, { data: png })).rejects.toThrow(
      /an icon is an SVG/,
    );
    const svg = Buffer.from("<svg/>").toString("base64");
    expect(await run(CONTENT_CMD.insertIcon, { data: svg })).toHaveProperty(
      "picture",
    );
    await expect(
      run(CONTENT_CMD.insertPicture, { data: "AAAA" }),
    ).rejects.toThrow(/not a picture/);
    expect(await run(CONTENT_CMD.smartArtText, {})).toEqual({
      presented: true,
    });
    await expect(run(CONTENT_CMD.pasteFormat, {})).rejects.toThrow(
      /no formatting was copied/,
    );
    await expect(
      run(CONTENT_TYPED.smartArtPoints, { diagram: "nonsense" }),
    ).rejects.toThrow();
    await expect(
      run(CONTENT_TYPED.setSmartArtText, {
        diagram: "nonsense",
        point: "x",
        text: "y",
      }),
    ).rejects.toThrow();
  });

  it("paste formatting writes the shape's look to the outline and the text over the whole story", () => {
    expect(isShapeFormatPath("frameFillColor")).toBe(true);
    expect(isShapeFormatPath("frameOuterGlowSize")).toBe(true);
    expect(isShapeFormatPath("frameFillRule")).toBe(false);
    expect(isShapeFormatPath("frameBounds")).toBe(false);
    const fill = {
      path: "frameFillColor",
      value: { type: "colorRef", value: "Color/x" },
    } as const;
    const size = {
      path: "characterFontSize",
      value: { type: "length", value: 30 },
    } as const;
    const ops = pasteOps(
      { shape: [fill], text: [size] },
      {
        outlines: [{ kind: "polygon", id: "p" } as ElementId],
        frames: [{ kind: "textFrame", id: "t" } as ElementId],
      },
      new Map([["t", { story: "s", length: 12 }]]),
    ) as { args: { elementId: unknown; path: string } }[];
    expect(ops.map((o) => [o.args.elementId, o.args.path])).toEqual([
      [{ kind: "polygon", id: "p" }, "frameFillColor"],
      [
        { kind: "storyRange", id: { story_id: "s", start: 0, end: 12 } },
        "characterFontSize",
      ],
    ]);
    // A text box with no outline takes the look on its frame.
    const box = pasteOps(
      { shape: [fill], text: [] },
      { outlines: [], frames: [{ kind: "textFrame", id: "t" } as ElementId] },
      new Map(),
    ) as { args: { elementId: { id: string } } }[];
    expect(box.map((o) => o.args.elementId.id)).toEqual(["t"]);
  });
});
