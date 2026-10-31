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

// Slide ADR 720: the typed commands of File ▸ Export, custom shows and
// sections hand their arguments to the output service and answer its
// results in their schemas' shape; the palette commands and menu entries
// register on a host with the command door.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  contributeOutputCommands,
  OUTPUT_CMD,
  OUTPUT_MENU,
  OUTPUT_TYPED,
  outputTypedCommands,
} from "../src/output/commands";
import type { Output } from "../src/output/output";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as {
  contributes: {
    commands: string[];
    objectModel: { commands: { id: string }[] };
  };
};

/** A fake output that records what it was asked. */
function fakeOutput() {
  const calls: [string, unknown[]][] = [];
  const rec =
    <R>(name: string, r: R) =>
    async (...a: unknown[]) => {
      calls.push([name, a]);
      return r;
    };
  const bytes = new Uint8Array([1, 2, 3]);
  const o = {
    pdf: rec("pdf", {
      bytes,
      fileName: "d.pdf",
      pages: 2,
      replaced: 0,
      mimeType: "application/pdf",
    }),
    outline: rec("outline", {
      bytes,
      fileName: "d.rtf",
      mimeType: "application/rtf",
    }),
    template: rec("template", { bytes, fileName: "d.potx", diagnostics: [] }),
    video: rec("video", {
      bytes,
      fileName: "d.mp4",
      codecString: "avc1.64001f",
      codec: "avc",
      width: 1280,
      height: 720,
      fps: 24,
      frames: 72,
      durationMs: 3000,
      gpu: false,
    }),
    customShows: rec("customShows", [{ id: 0, name: "A", slides: [2, 1] }]),
    setCustomShow: rec("setCustomShow", 4),
    deleteCustomShow: rec("deleteCustomShow", undefined),
    playCustomShow: rec("playCustomShow", true),
    sections: rec("sections", [{ id: "{S}", name: "S", slides: [1] }]),
    addSection: rec("addSection", "{N}"),
    renameSection: rec("renameSection", undefined),
    moveSection: rec("moveSection", undefined),
    deleteSection: rec("deleteSection", undefined),
    save: rec("save", true),
  };
  return { output: o as unknown as Output, calls };
}

describe("[plugin-slide.output] typed commands", () => {
  it("are all declared in the manifest, with the palette's twins", () => {
    const { output } = fakeOutput();
    const ids = outputTypedCommands(
      () => output,
      () => null,
    ).map((c) => c.id);
    const typed = new Set(
      MANIFEST.contributes.objectModel.commands.map((c) => c.id),
    );
    for (const id of ids) expect(typed.has(id)).toBe(true);
    for (const id of Object.values(OUTPUT_CMD))
      expect(MANIFEST.contributes.commands).toContain(id);
  });

  it("run the output service and answer in their schemas' shape", async () => {
    covers(
      "command:media.paged.slide.command.export",
      "command:media.paged.slide.command.saveAsTemplate",
      "command:media.paged.slide.command.customShows",
      "command:media.paged.slide.command.addSection",
      "command:media.paged.slide.exportPdf",
      "command:media.paged.slide.exportOutline",
      "command:media.paged.slide.exportVideo",
      "command:media.paged.slide.setCustomShow",
      "command:media.paged.slide.deleteCustomShow",
      "command:media.paged.slide.playCustomShow",
      "command:media.paged.slide.sections",
      "command:media.paged.slide.renameSection",
      "command:media.paged.slide.moveSection",
      "command:media.paged.slide.deleteSection",
    );
    const { output, calls } = fakeOutput();
    let opened = 0;
    let panels = 0;
    const cmds = new Map(
      outputTypedCommands(
        () => output,
        () => ({
          openExport: () => {
            opened++;
            return true;
          },
          openCustomShows: () => {
            panels++;
          },
        }),
      ).map((c) => [c.id, c]),
    );
    const run = (id: string, args: unknown = {}) =>
      cmds.get(id)!.handler({ objects: {} as never }, args) as Promise<
        Record<string, unknown>
      >;

    expect(await run(OUTPUT_CMD.export)).toEqual({ presented: true });
    expect(opened).toBe(1);
    expect((await run(OUTPUT_CMD.saveAsTemplate)).fileName).toBe("d.potx");
    expect(await run(OUTPUT_CMD.customShows)).toEqual({
      shows: [{ id: 0, name: "A", slides: [2, 1] }],
    });
    expect(panels).toBe(1);
    expect(await run(OUTPUT_CMD.addSection, { name: "N", slide: 2 })).toEqual({
      id: "{N}",
    });
    expect(
      await run(OUTPUT_TYPED.exportPdf, { layout: "handouts", perPage: 3 }),
    ).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "d.pdf",
      pages: 2,
      replaced: 0,
    });
    expect(
      (await run(OUTPUT_TYPED.exportOutline, { format: "rtf" })).fileName,
    ).toBe("d.rtf");
    await expect(
      run(OUTPUT_TYPED.exportOutline, { format: "doc" }),
    ).rejects.toThrow(/invalid/);
    const v = await run(OUTPUT_TYPED.exportVideo, { height: 720, fps: 24 });
    expect(v.codec).toBe("avc1.64001f");
    expect(v.durationMs).toBe(3000);
    expect(
      await run(OUTPUT_TYPED.setCustomShow, { name: "B", slides: [3] }),
    ).toEqual({ id: 4 });
    expect(await run(OUTPUT_TYPED.deleteCustomShow, { name: "B" })).toEqual({});
    expect(await run(OUTPUT_TYPED.playCustomShow, { name: "A" })).toEqual({
      presented: true,
    });
    expect(await run(OUTPUT_TYPED.sections)).toEqual({
      sections: [{ id: "{S}", name: "S", slides: [1] }],
    });
    expect(
      await run(OUTPUT_TYPED.renameSection, { name: "S", to: "T" }),
    ).toEqual({});
    expect(
      await run(OUTPUT_TYPED.moveSection, { name: "T", by: "up" }),
    ).toEqual({});
    expect(
      await run(OUTPUT_TYPED.deleteSection, { name: "T", withSlides: true }),
    ).toEqual({});
    expect(calls.map(([n, a]) => [n, a])).toContainEqual([
      "pdf",
      [{ layout: "handouts", perPage: 3 }],
    ]);
    expect(calls).toContainEqual(["addSection", ["N", 2]]);
    expect(calls).toContainEqual(["deleteSection", ["T", true]]);
    expect(calls).toContainEqual(["setCustomShow", ["B", [3]]]);
  });

  it("say why when the deck's outputs are not ready", async () => {
    const [cmd] = outputTypedCommands(
      () => null,
      () => null,
    ).filter((c) => c.id === OUTPUT_TYPED.exportPdf);
    await expect(
      Promise.resolve(
        cmd!.handler({ objects: {} as never }, { layout: "slides" }),
      ),
    ).rejects.toThrow(/unavailable/);
  });
});

describe("[plugin-slide.output] palette commands", () => {
  it("register with a menu entry each, offered in a deck", async () => {
    const commands = new Map<
      string,
      { when?: () => boolean; handler: () => unknown }
    >();
    const menus: { path: string; command: string }[] = [];
    const host = {
      contribute: {
        command: (c: {
          id: string;
          when?: () => boolean;
          handler: () => unknown;
        }) => {
          commands.set(c.id, c);
          return { dispose: () => commands.delete(c.id) };
        },
        menu: (m: { path: string; command: string }) => {
          menus.push(m);
          return { dispose: () => menus.splice(menus.indexOf(m), 1) };
        },
      },
      log: { warn() {}, info() {} },
    } as unknown as BundleHost;
    const { output, calls } = fakeOutput();
    let deck = false;
    let opened = 0;
    const h = contributeOutputCommands(
      host,
      output,
      { openExport: () => (opened++, true), openCustomShows() {} },
      () => deck,
    );
    expect([...commands.keys()].sort()).toEqual(
      Object.values(OUTPUT_CMD).sort(),
    );
    expect(menus.map((m) => m.path)).toEqual(OUTPUT_MENU.map(([p]) => p));
    expect(commands.get(OUTPUT_CMD.export)!.when!()).toBe(false);
    deck = true;
    expect(commands.get(OUTPUT_CMD.export)!.when!()).toBe(true);
    await commands.get(OUTPUT_CMD.export)!.handler();
    expect(opened).toBe(1);
    await commands.get(OUTPUT_CMD.saveAsTemplate)!.handler();
    expect(calls.map(([n]) => n)).toEqual(["template", "save"]);
    h.dispose();
    expect(commands.size).toBe(0);
    expect(menus).toEqual([]);
  });
});
