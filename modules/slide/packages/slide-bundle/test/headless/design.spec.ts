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

// The live theme (slide ADR 713) on the real engine (canvas-wasm,
// headless) and the real slide wasm: a gallery theme applied through the
// typed command recolours the slide as drawn, is one undo step, and
// exports as the deck's theme part with every slide's bytes kept.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  ExporterContribution,
  MutationInput,
} from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { DESIGN_CMD, DESIGN_TYPED } from "../../src/design";
import { slideEngine } from "../../src/engine";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as Parameters<HeadlessHost["loadBundle"]>[0]["manifest"];

/** Keep a written deck for PowerPoint's open-check (ADR 705) when
 *  `PAGED_SLIDE_EXPORT_DIR` names a folder. */
function keep(bytes: Uint8Array, name: string) {
  const dir = process.env.PAGED_SLIDE_EXPORT_DIR;
  if (dir) writeFileSync(`${dir}/${name}.pptx`, bytes);
}

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
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  const { paged, report } = (await slideEngine()).importPptx(bytes, name);
  await h.load(paged);
  await keepSource(host, bytes, report);
  return { h, host, exporter };
}

/** The parts of a zip, by name (stored or deflated). */
function zipParts(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16);
  const n = b.readUInt16LE(eocd + 10);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    const start =
      local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function firstPage(host: BundleHost): Promise<string> {
  return (await host.document.collection<{ selfId: string }>("pages"))[0]!
    .selfId;
}

async function pixels(host: BundleHost, page: string): Promise<Uint8Array> {
  const r = await host.render.snapshot(page, { widthPx: 320, format: "rgba" });
  return r!.rgba!;
}

describe("the live theme (slide ADR 713)", () => {
  it("a gallery theme recolours the slide, undoes in one step and exports as the theme part", async () => {
    covers(
      "command:media.paged.slide.applyTheme",
      "command:media.paged.slide.themes",
    );
    covers("exporter:media.paged.slide.exporter.pptx");
    const bytes = fixture("placeholders");
    const { host, exporter } = await open(bytes, "placeholders");
    const page = await firstPage(host);
    const before = await pixels(host, page);

    expect(
      await host.objects.invoke(DESIGN_TYPED.applyTheme, {
        theme: "paper",
        variant: "Dark",
      }),
    ).toEqual({ applied: true });
    const listed = (await host.objects.invoke(DESIGN_TYPED.themes, {})) as {
      current: string;
      variant: string;
    };
    expect([listed.current, listed.variant]).toEqual(["Paper", "Dark"]);
    const [lt1] = await host.document.swatchDisplay(["Color/lt1"]);
    expect(lt1!.rgbHex.toLowerCase()).toBe("#1b1b1b");
    const themed = await pixels(host, page);
    // The slide's background is Light 1: it is drawn dark now.
    expect(Buffer.from(themed).equals(Buffer.from(before))).toBe(false);

    const out = (await exporter.export())!;
    keep(out.bytes, "design-paper-dark");
    const parts = zipParts(out.bytes);
    const orig = zipParts(bytes);
    const theme = parts.get("ppt/theme/theme1.xml")!.toString("utf8");
    expect(theme).toContain('<a:clrScheme name="Paper Dark">');
    expect(theme).toContain('<a:majorFont><a:latin typeface="Georgia"/>');
    for (const [name, b] of orig)
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name))
        expect(parts.get(name)!.equals(b), name).toBe(true);

    // One undo step puts the deck's own theme back, as it was drawn.
    await host.document.undo();
    expect(
      Buffer.from(await pixels(host, page)).equals(Buffer.from(before)),
    ).toBe(true);
    const again = (await host.objects.invoke(DESIGN_TYPED.themes, {})) as {
      current: string;
    };
    expect(again.current).toBe("Office");
  }, 120_000);

  it("a lost theme swatch is listed missing; remapped, its stand-in takes the slot's colour", async () => {
    covers("command:media.paged.slide.remapThemeReference");
    const { host } = await open(fixture("placeholders"), "placeholders");
    const out = await host.document.mutate({
      op: "deleteSwatch",
      args: { swatchId: "Color/accent6" },
    } as MutationInput);
    expect(out.applied).toBe(true);
    const missing = async () =>
      (
        (await host.objects.invoke(DESIGN_TYPED.themes, {})) as {
          missing: string[];
        }
      ).missing;
    expect(await missing()).toEqual(["Color/accent6"]);
    const standIn = "Color/accent6 lumMod75000";
    expect(
      await host.objects.invoke(DESIGN_TYPED.remapThemeReference, {
        from: "Color/accent6",
        to: standIn,
      }),
    ).toEqual({ applied: true });
    expect(await missing()).toEqual([]);
    await host.objects.invoke(DESIGN_TYPED.applyTheme, { theme: "meadow" });
    const [s] = await host.document.swatchDisplay([standIn]);
    // Meadow's accent 6.
    expect(s!.rgbHex.toLowerCase()).toBe("#3e8e7e");
  }, 120_000);

  it("Browse for Themes reads a deck's theme into the gallery and applies it", async () => {
    covers("command:media.paged.slide.command.browseThemes");
    const { host } = await open(fixture("text"), "text");
    await host.objects.invoke(DESIGN_TYPED.applyTheme, { theme: "slate" });
    const data = Buffer.from(fixture("geometry")).toString("base64");
    expect(
      await host.objects.invoke(DESIGN_CMD.browseThemes, { data }),
    ).toEqual({
      applied: true,
    });
    const listed = (await host.objects.invoke(DESIGN_TYPED.themes, {})) as {
      themes: { id: string }[];
      current: string;
    };
    expect(listed.themes.at(-1)!.id).toBe("file:1");
    expect(listed.current).toBe("Office");
  }, 120_000);
});
