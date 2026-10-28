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

// The format painter and the SmartArt text pane (slide W4) on the real
// engine (canvas-wasm, headless) and the real slide wasm.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  ElementId,
  ExporterContribution,
  MutationInput,
} from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  fromElementId,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { CONTENT_CMD, CONTENT_TYPED } from "../../src/content-commands";
import { slideEngine } from "../../src/engine";
import { storiesOf } from "../../src/format-painter";
import type { SmartArtPoint } from "../../src/smartart";

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

function zipText(bytes: Uint8Array, name: string): string {
  const b = Buffer.from(bytes);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16);
  const n = b.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    if (b.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const start =
        local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`no ${name}`);
}

const el = (kind: string, id: string) => ({ kind, id }) as ElementId;

async function prop(host: BundleHost, id: ElementId, path: string) {
  const p = await host.document.elementProperties(id);
  return p?.entries.find((e) => e.path === path)?.value?.value;
}

async function fontSize(host: BundleHost, frame: ElementId): Promise<number[]> {
  const st = (await storiesOf(host, [frame])).get(String(frame.id))!;
  const c = await host.document.storyContent(st.story);
  return c!.paragraphs.flatMap((p) => p.runs.map((r) => r.pointSize as number));
}

describe("the format painter (slide W4)", () => {
  it("copies a shape's fill, line and text format onto another, one undo step", async () => {
    covers("command:media.paged.slide.command.copyFormat");
    covers("command:media.paged.slide.command.pasteFormat");
    const { host } = await open(fixture("geometry"), "geometry");
    // The source: a rectangle with text, given a line and a text size of
    // its own; the target: another such shape.
    const [srcOutline, srcText] = [
      el("polygon", "u3p"),
      el("textFrame", "u3t"),
    ];
    const [dstOutline, dstText] = [
      el("polygon", "u5p"),
      el("textFrame", "u5t"),
    ];
    const swatches = await host.document.collection<{ selfId: string }>(
      "swatches",
    );
    const other = swatches
      .map((s) => s.selfId)
      .find((s) => /Color\/(accent2|accent4|Black)/.test(s))!;
    const st = (await storiesOf(host, [srcText])).get("u3t")!;
    await host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "setElementProperty",
            args: {
              elementId: srcOutline,
              path: "frameFillColor",
              value: { type: "colorRef", value: other },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: srcOutline,
              path: "frameStrokeWeight",
              value: { type: "length", value: 4 },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: {
                kind: "storyRange",
                id: { story_id: st.story, start: 0, end: st.length },
              },
              path: "characterFontSize",
              value: { type: "length", value: 30 },
            },
          },
        ],
      },
    } as MutationInput);
    const fillBefore = await prop(host, dstOutline, "frameFillColor");
    const boundsBefore = await prop(host, dstOutline, "frameBounds");
    const sizeBefore = await fontSize(host, dstText);
    expect(sizeBefore.every((s) => s !== 30)).toBe(true);

    expect(
      await host.objects.invoke(CONTENT_CMD.copyFormat, {
        element: fromElementId(srcOutline),
      }),
    ).toEqual({ applied: true });
    expect(
      await host.objects.invoke(CONTENT_CMD.pasteFormat, {
        element: fromElementId(dstText),
      }),
    ).toEqual({ applied: true });
    // Selecting the shape's text frame paints its outline too: they are one shape.
    expect(await prop(host, dstOutline, "frameFillColor")).toBe(other);
    expect(await prop(host, dstOutline, "frameStrokeWeight")).toBe(4);
    expect((await fontSize(host, dstText)).every((s) => s === 30)).toBe(true);
    // The geometry stays the target's.
    expect(await prop(host, dstOutline, "frameBounds")).toEqual(boundsBefore);

    await host.document.undo();
    expect(await prop(host, dstOutline, "frameFillColor")).toBe(fillBefore);
    expect(await fontSize(host, dstText)).toEqual(sizeBefore);
  }, 120_000);

  it("paste without a copy is refused, and the palette's copy follows the selection", async () => {
    const { host } = await open(fixture("geometry"), "geometry");
    await expect(
      host.objects.invoke(CONTENT_CMD.pasteFormat, {
        element: fromElementId(el("polygon", "u5p")),
      }),
    ).rejects.toThrow(/no formatting was copied/);
    await host.selection.set([el("polygon", "u3p")]);
    expect(await host.objects.invoke(CONTENT_CMD.copyFormat, {})).toEqual({
      applied: true,
    });
    await host.selection.set([el("polygon", "u5p")]);
    expect(await host.objects.invoke(CONTENT_CMD.pasteFormat, {})).toEqual({
      applied: true,
    });
  }, 120_000);
});

describe("the SmartArt text pane (slide W4)", () => {
  it("lists the points, edits one in its shape, one undo step, and exports it", async () => {
    covers("command:media.paged.slide.smartArtPoints");
    covers("command:media.paged.slide.setSmartArtText");
    const bytes = fixture("smartart");
    const { host, exporter } = await open(bytes, "smartart");
    const diagram = fromElementId(el("group", "u7"));
    const read = async () =>
      (
        (await host.objects.invoke(CONTENT_TYPED.smartArtPoints, {
          diagram,
        })) as {
          points: SmartArtPoint[];
        }
      ).points;
    const points = await read();
    expect(points.map((p) => p.text)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
    expect(points.every((p) => p.shown && p.depth === 0)).toBe(true);
    // A member shape's address names the diagram too.
    const viaMember = (await host.objects.invoke(CONTENT_TYPED.smartArtPoints, {
      diagram: fromElementId(el("textFrame", "u4t")),
    })) as { points: SmartArtPoint[] };
    expect(viaMember.points.length).toBe(5);

    expect(
      await host.objects.invoke(CONTENT_TYPED.setSmartArtText, {
        diagram,
        point: points[2]!.id,
        text: "Omega",
      }),
    ).toEqual({ applied: true });
    expect((await read()).map((p) => p.text)).toEqual([
      "Alpha",
      "Beta",
      "Omega",
      "Delta",
      "Epsilon",
    ]);
    // The new text keeps the size PowerPoint drew the old one at.
    const sizes = await fontSize(host, el("textFrame", "u4t"));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s === 55)).toBe(true);

    const out = await exporter.export();
    keep(out!.bytes, "smartart-pane");
    const rels = zipText(out!.bytes, "ppt/slides/_rels/slide1.xml.rels");
    const data = /Target="\.\.\/diagrams\/(data\d+\.xml)"/.exec(rels)![1]!;
    const drawing = /Target="\.\.\/diagrams\/(drawing\d+\.xml)"/.exec(
      rels,
    )![1]!;
    expect(data).not.toBe("data1.xml");
    expect(zipText(out!.bytes, `ppt/diagrams/${data}`)).toContain(
      "<a:t>Omega</a:t>",
    );
    expect(zipText(out!.bytes, `ppt/diagrams/${drawing}`)).toContain(
      "<a:t>Omega</a:t>",
    );
    expect((out as { notExported?: string[] }).notExported ?? []).toEqual([]);

    await host.document.undo();
    expect((await read())[2]!.text).toBe("Gamma");
  }, 120_000);

  it("a shape of several points keeps each point's paragraphs", async () => {
    const { host } = await open(fixture("smartart"), "smartart");
    const pages = await host.document.collection<{ selfId: string }>("pages");
    // Slide 4's diagram: one shape shows five points.
    const tree = (await host.document.tree()) as {
      children?: { children?: { id?: ElementId; kind: string }[] }[];
    }[];
    const group = tree[3]!.children![0]!.children!.find(
      (n) => n.kind === "Group",
    )!.id!;
    expect(pages.length).toBeGreaterThan(3);
    const diagram = fromElementId(group);
    const before = (
      (await host.objects.invoke(CONTENT_TYPED.smartArtPoints, {
        diagram,
      })) as {
        points: SmartArtPoint[];
      }
    ).points;
    const fonts = before.find((p) => p.text === "Fonts")!;
    await host.objects.invoke(CONTENT_TYPED.setSmartArtText, {
      diagram,
      point: fonts.id,
      text: "Type\nfaces",
    });
    const after = (
      (await host.objects.invoke(CONTENT_TYPED.smartArtPoints, {
        diagram,
      })) as {
        points: SmartArtPoint[];
      }
    ).points;
    expect(after.find((p) => p.id === fonts.id)!.text).toBe("Type faces");
    expect(after.filter((p) => p.id !== fonts.id).map((p) => p.text)).toEqual(
      before.filter((p) => p.id !== fonts.id).map((p) => p.text),
    );
  }, 120_000);

  it("the palette's twin raises the text pane where the host has panels", async () => {
    covers("command:media.paged.slide.command.smartArtText");
    const { host } = await open(fixture("smartart"), "smartart");
    const out = (await host.objects.invoke(CONTENT_CMD.smartArtText, {})) as {
      presented: boolean;
    };
    expect(out.presented).toBe(host.supports("shell.openPanel@1"));
  }, 120_000);

  it("a page item that is no diagram is refused", async () => {
    const { host } = await open(fixture("geometry"), "geometry");
    await expect(
      host.objects.invoke(CONTENT_TYPED.smartArtPoints, {
        diagram: fromElementId(el("polygon", "u3p")),
      }),
    ).rejects.toThrow(/no SmartArt diagram/);
  }, 120_000);
});
