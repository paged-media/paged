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

// Video and audio on the real engine (the canvas-wasm, headless) and the
// real slide wasm (slide ADR 718, engine ADR 1027, extensions ADR 345, amendment 1): the
// `media` fixture opens with a movie and a sound frame whose media are
// parts of the document, the media door reads them, the show finds when
// each starts, Insert ▸ Video places one in one undo step, and the export
// writes it as PowerPoint holds one.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  ElementId,
  ExporterContribution,
} from "@paged-media/plugin-api";
import { bytesToBase64 } from "@paged-media/helpers";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { pageShapes } from "../../src/anim/shapes";
import { CONTENT_CMD } from "../../src/content-commands";
import { slideEngine } from "../../src/engine";
import { pageMedia } from "../../src/media";
import { slideAddress } from "../../src/object-model";
import { attachMedia } from "../../src/show/contribute";
import type { ShowSlide } from "../../src/show/show-model";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as Parameters<HeadlessHost["loadBundle"]>[0]["manifest"];

function keep(bytes: Uint8Array, name: string) {
  const dir = process.env.PAGED_SLIDE_EXPORT_DIR;
  if (dir) writeFileSync(`${dir}/${name}.pptx`, bytes);
}

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

const FIXTURE = new Uint8Array(
  readFileSync(
    new URL(
      "../../../../slide-conformance/fixtures/media.pptx",
      import.meta.url,
    ),
  ),
);

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

const CLIP = zipParts(FIXTURE).get("ppt/media/media1.mp4")!;

async function open() {
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
  const { paged, report } = (await slideEngine()).importPptx(FIXTURE, "media");
  await h.load(paged);
  await keepSource(host, FIXTURE, report);
  const pages = await host.document.collection<{
    selfId: string;
    sizePt?: [number, number];
  }>("pages");
  return { h, host, exporter, pages };
}

const slide = (pageId: string, number: number): ShowSlide => ({
  pageId,
  number,
  hidden: false,
  advanceAfterMs: null,
  transition: null,
  notes: "",
  sizePt: [960, 540],
});

describe("video and audio (slide ADR 718)", () => {
  it("a deck's video and audio open as movie and sound frames the media door reads", async () => {
    const { host, pages } = await open();
    expect(host.supports("document.media@1")).toBe(true);
    const found = await pageMedia(host, await pageShapes(host));
    const video = found.get(pages[0]!.selfId)!;
    expect(video).toHaveLength(1);
    const m = video[0]!.media;
    expect(m.kind).toBe("movie");
    expect(m.play).toBe("auto");
    expect(m.volume).toBeCloseTo(0.4);
    expect(m.loop).toBe(true);
    expect(m.hideWhileNotPlaying).toBe(true);
    expect([m.trimStartMs, m.trimEndMs]).toEqual([250, 500]);
    const read = await host.media.read(video[0]!.item.id);
    expect(read?.url).toBeNull();
    expect(Buffer.from(read!.bytes!).equals(CLIP)).toBe(true);

    const sound = found.get(pages[1]!.selfId)!;
    expect(sound[0]!.media.kind).toBe("sound");
    expect(sound[0]!.media.play).toBe("onClick");
  });

  it("the show knows when each starts and what it hides", async () => {
    const { host, pages } = await open();
    const slides = [slide(pages[0]!.selfId, 1), slide(pages[1]!.selfId, 2)];
    await attachMedia(host, slides);
    expect(slides[0]!.media?.[0]?.step).toBe(0);
    expect(slides[0]!.hide).toHaveLength(1);
    // Without the slide's effects attached, the sound plays when clicked.
    expect(slides[1]!.media?.[0]?.step).toBeNull();
    expect(slides[1]!.hide).toEqual([]);
  });

  it("Insert ▸ Video places a movie in one undo step, and the export writes it", async () => {
    covers("command:media.paged.slide.command.insertVideo");
    const { host, exporter, pages } = await open();
    const res = (await host.objects.invoke(CONTENT_CMD.insertVideo, {
      data: bytesToBase64(new Uint8Array(CLIP)),
      name: "clip.mp4",
      slide: slideAddress(pages[1]!.selfId),
      x: 300,
      y: 200,
      w: 160,
      h: 90,
    })) as { media: string };
    expect(res.media).toMatch(/rectangle/);
    const found = await pageMedia(host, await pageShapes(host));
    const placed = found
      .get(pages[1]!.selfId)!
      .find((x) => x.media.kind === "movie")!;
    expect(placed.media.source.type).toBe("part");
    const path = (placed.media.source as { path: string }).path;
    expect(path).toMatch(/^paged\/core\/media\/[0-9a-f]{32}\.mp4$/);
    const read = await host.media.read(placed.item.id as ElementId);
    expect(Buffer.from(read!.bytes!).equals(CLIP)).toBe(true);

    const out = await exporter.export();
    keep(out!.bytes, "media-inserted");
    const parts = zipParts(out!.bytes);
    const xml = parts.get("ppt/slides/slide2.xml")!.toString("utf8");
    expect(xml).toContain('action="ppaction://media"');
    expect(xml).toContain("<a:videoFile ");
    // The same clip as slide 1's: one part, byte for byte.
    const media = [...parts.keys()].filter((k) =>
      k.startsWith("ppt/media/media"),
    );
    for (const k of media)
      if (k.endsWith(".mp4"))
        expect(Buffer.from(parts.get(k)!).equals(CLIP)).toBe(true);

    await host.document.undo();
    const after = await pageMedia(host, await pageShapes(host));
    expect(
      after.get(pages[1]!.selfId)!.some((x) => x.media.kind === "movie"),
    ).toBe(false);
  });
});
