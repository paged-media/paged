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

// Slide ADR 720 on the real engine (canvas-wasm, headless) and the real
// slide wasm, through the typed commands a script runs: Save as template,
// custom shows and sections written to the document, exported and read
// back from the written deck; the outline; a PDF of handouts and notes
// pages with the expected page count.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { slideEngine } from "../../src/engine";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const P = "media.paged.slide";

const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as Parameters<HeadlessHost["loadBundle"]>[0]["manifest"];

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(
      new URL(
        `../../../../slide-conformance/fixtures/${name}.pptx`,
        import.meta.url,
      ),
    ),
  );
}

async function open(bytes: Uint8Array, name: string) {
  const h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR });
  hosts.push(h);
  let host!: BundleHost;
  h.loadBundle({
    manifest,
    activate(x) {
      host = x;
      return activate(x);
    },
  });
  const { paged, report } = (await slideEngine()).importPptx(bytes, name);
  await h.load(paged);
  await keepSource(host, bytes, report);
  // The slides store reads the pages after the open.
  await new Promise((r) => setTimeout(r, 50));
  return { h, host, report };
}

type Ir = {
  slides: { part: string }[];
  sections: { name: string; id: string; slide_ids: number[] }[];
  custom_shows: { name: string; id: number; slides: string[] }[];
};

async function readBack(bytes: Uint8Array): Promise<Ir> {
  const mod = (await slideEngine()).module() as unknown as {
    readPptx(b: Uint8Array): string;
  };
  return JSON.parse(mod.readPptx(bytes)) as Ir;
}

const unzipText = (bytes: Uint8Array) =>
  new TextDecoder("latin1").decode(bytes);

/** One entry of a zip, read from its local header (stored or deflated). */
function entry(zip: Uint8Array, name: string): string {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let at = 0; at + 30 < zip.length;) {
    if (dv.getUint32(at, true) !== 0x04034b50) break;
    const method = dv.getUint16(at + 8, true);
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extra = dv.getUint16(at + 28, true);
    const n = new TextDecoder().decode(
      zip.subarray(at + 30, at + 30 + nameLen),
    );
    const data = zip.subarray(
      at + 30 + nameLen + extra,
      at + 30 + nameLen + extra + size,
    );
    if (n === name)
      return new TextDecoder().decode(
        method === 8 ? inflateRawSync(data) : data,
      );
    at += 30 + nameLen + extra + size;
  }
  throw new Error(`no ${name} in the package`);
}

describe("[plugin-slide.output] files and output (slide ADR 720), headless", () => {
  it("Save as template writes a .potx with the template content type", async () => {
    covers("command:media.paged.slide.command.saveAsTemplate");
    const { host } = await open(fixture("placeholders"), "placeholders");
    const out = (await host.objects.invoke(
      `${P}.command.saveAsTemplate`,
      {},
    )) as {
      bytes: Uint8Array;
      fileName: string;
    };
    expect(out.fileName.endsWith(".potx")).toBe(true);
    expect(entry(out.bytes, "[Content_Types].xml")).toContain(
      "presentationml.template.main+xml",
    );
    // The template opens as the same deck.
    const ir = await readBack(out.bytes);
    expect(ir.slides.length).toBeGreaterThan(0);
  });

  it("custom shows: set, exported, read back; played from the typed command's list", async () => {
    covers(
      "command:media.paged.slide.setCustomShow",
      "command:media.paged.slide.deleteCustomShow",
      "command:media.paged.slide.command.customShows",
    );
    const { host } = await open(fixture("placeholders"), "placeholders");
    const id = (await host.objects.invoke(`${P}.setCustomShow`, {
      name: "Kurz",
      slides: [3, 1],
    })) as { id: number };
    expect(typeof id.id).toBe("number");
    await host.objects.invoke(`${P}.setCustomShow`, {
      name: "Gone",
      slides: [2],
    });
    await host.objects.invoke(`${P}.deleteCustomShow`, { name: "Gone" });
    const listed = (await host.objects.invoke(
      `${P}.command.customShows`,
      {},
    )) as {
      shows: { name: string; slides: number[] }[];
    };
    expect(listed.shows).toEqual([{ id: id.id, name: "Kurz", slides: [3, 1] }]);
    const deck = (await host.objects.invoke(`${P}.exportPptx`, {})) as {
      bytes: Uint8Array;
    };
    const ir = await readBack(deck.bytes);
    expect(ir.custom_shows.map((c) => c.name)).toEqual(["Kurz"]);
    expect(ir.custom_shows[0]!.slides).toEqual([
      ir.slides[2]!.part,
      ir.slides[0]!.part,
    ]);
    // The written deck opens with the show on its document label.
    const again = await open(deck.bytes, "again");
    const back = (await again.host.objects.invoke(
      `${P}.command.customShows`,
      {},
    )) as {
      shows: { name: string; slides: number[] }[];
    };
    expect(back.shows.map((s) => [s.name, s.slides])).toEqual([
      ["Kurz", [3, 1]],
    ]);
  });

  it("sections: added, renamed, moved, exported as p14:sectionLst and read back", async () => {
    covers(
      "command:media.paged.slide.command.addSection",
      "command:media.paged.slide.renameSection",
      "command:media.paged.slide.moveSection",
      "command:media.paged.slide.deleteSection",
      "command:media.paged.slide.sections",
    );
    const { host, report } = await open(
      fixture("placeholders"),
      "placeholders",
    );
    const n = report.slides.length;
    await host.objects.invoke(`${P}.command.addSection`, {
      name: "Intro",
      slide: 1,
    });
    await host.objects.invoke(`${P}.command.addSection`, {
      name: "Body",
      slide: 3,
    });
    await host.objects.invoke(`${P}.command.addSection`, {
      name: "Spare",
      slide: 2,
    });
    await host.objects.invoke(`${P}.deleteSection`, { name: "Spare" });
    await host.objects.invoke(`${P}.renameSection`, {
      name: "Body",
      to: "Hauptteil",
    });
    await new Promise((r) => setTimeout(r, 50));
    const listed = (await host.objects.invoke(`${P}.sections`, {})) as {
      sections: { name: string; slides: number[] }[];
    };
    expect(listed.sections.map((s) => [s.name, s.slides.length])).toEqual([
      ["Intro", 2],
      ["Hauptteil", n - 2],
    ]);
    // Moving Hauptteil up puts its slides first.
    await host.objects.invoke(`${P}.moveSection`, {
      name: "Hauptteil",
      by: "up",
    });
    await new Promise((r) => setTimeout(r, 50));
    const moved = (await host.objects.invoke(`${P}.sections`, {})) as {
      sections: { name: string; slides: number[] }[];
    };
    expect(moved.sections.map((s) => s.name)).toEqual(["Hauptteil", "Intro"]);
    const deck = (await host.objects.invoke(`${P}.exportPptx`, {})) as {
      bytes: Uint8Array;
    };
    const ir = await readBack(deck.bytes);
    expect(ir.sections.map((s) => [s.name, s.slide_ids.length])).toEqual([
      ["Hauptteil", n - 2],
      ["Intro", 2],
    ]);
    expect(ir.slides.length).toBe(n);
  });

  it("the outline carries every slide's title, as RTF and text", async () => {
    covers("command:media.paged.slide.exportOutline");
    const { host } = await open(fixture("placeholders"), "placeholders");
    const txt = (await host.objects.invoke(`${P}.exportOutline`, {
      format: "txt",
    })) as {
      bytes: Uint8Array;
      fileName: string;
    };
    const rtf = (await host.objects.invoke(`${P}.exportOutline`, {
      format: "rtf",
    })) as {
      bytes: Uint8Array;
    };
    const text = new TextDecoder().decode(txt.bytes);
    expect(txt.fileName.endsWith(".txt")).toBe(true);
    expect(text.trim().length).toBeGreaterThan(0);
    const r = new TextDecoder().decode(rtf.bytes);
    expect(r.startsWith("{\\rtf1")).toBe(true);
    // Every title line of the text is a level-0 heading of the RTF.
    const titles = text
      .split("\n\n")
      .map((b) => b.split("\n")[0]!)
      .filter(Boolean);
    expect(r.split("\\outlinelevel0").length - 1).toBe(
      text.split("\n\n").length,
    );
    for (const title of titles.filter((x) => /^[\x20-\x7e]+$/.test(x)))
      expect(r).toContain(title.replace(/[\\{}]/g, (c) => `\\${c}`));
  });

  it("PDF handouts and notes pages have the pages their layout asks for", async () => {
    covers("command:media.paged.slide.exportPdf");
    const { host, report } = await open(
      fixture("placeholders"),
      "placeholders",
    );
    const n = report.slides.filter((s) => !s.hidden).length;
    const count = (b: Uint8Array) =>
      (unzipText(b).match(/\/Type \/Page\b/g) ?? []).length;
    for (const per of [3, 6]) {
      const out = (await host.objects.invoke(`${P}.exportPdf`, {
        layout: "handouts",
        perPage: per,
        dpi: 36,
      })) as { bytes: Uint8Array; pages: number };
      expect(out.pages).toBe(Math.ceil(n / per));
      expect(count(out.bytes)).toBe(out.pages);
      expect(unzipText(out.bytes).startsWith("%PDF-1.4")).toBe(true);
    }
    const notes = (await host.objects.invoke(`${P}.exportPdf`, {
      layout: "notes",
      dpi: 36,
      slides: [1, 2],
    })) as { pages: number };
    expect(notes.pages).toBeGreaterThanOrEqual(2);
    await expect(
      host.objects.invoke(`${P}.exportPdf`, { layout: "handouts", perPage: 5 }),
    ).rejects.toThrow();
  });
});
