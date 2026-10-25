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

// Live presets and connectors on the real engine (the published
// canvas-wasm, headless) and the real slide wasm (slide ADR 717). The
// `connectors` fixture was authored through PowerPoint: slide 1 holds a
// rounded rectangle, a callout, boxes and three glued connectors; on slide
// 2 PowerPoint itself moved "Box B" and resized the rounded rectangle. The
// edits here are the editor's mutations; the bundle follows them in the
// same undo step.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  ElementId,
  ExporterContribution,
} from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { HandlesModel } from "../../src/adjust-handles";
import { slideEngine, type LiveElement } from "../../src/engine";
import { liveElements, writeMutation } from "../../src/live-presets";
import { INSERT_SHAPE_COMMAND, slideAddress } from "../../src/object-model";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));

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
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  const { paged, report } = (await slideEngine()).importPptx(bytes, name);
  await h.load(paged);
  await keepSource(host, bytes, report);
  return { h, host, exporter, report };
}

/** One part of a zip package as text (central directory, stored or
 *  deflated). */
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

/** Wait until `done` holds (the follow-up write lands after the change
 *  event), at most ~5 s. */
async function until(done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

/** The labelled elements of the first page, by the shape name a label's
 *  key points at (`#<id>`). */
async function page0(host: BundleHost) {
  const pages = await host.document.collection<{ selfId: string }>("pages");
  const first = pages[0]!.selfId;
  const byPage = await liveElements(host, new Set([first]));
  return { pageId: first, list: byPage.get(first) ?? [] };
}

const shapeId = (e: LiveElement) =>
  Number(/"shape":"[^"#]*#(?:[\d/]*\/)?(\d+)"/.exec(e.label)?.[1] ?? -1);

function polygonOf(
  list: { element: LiveElement; id: ElementId }[],
  id: number,
) {
  return list.find(
    (x) => shapeId(x.element) === id && x.element.kind === "polygon",
  )!;
}

/** A connector's end points on the page. */
function ends(e: LiveElement): [[number, number], [number, number]] {
  const t = e.transform;
  const at = (p: [number, number]): [number, number] => [
    t[0] * p[0] + t[2] * p[1] + t[4],
    t[1] * p[0] + t[3] * p[1] + t[5],
  ];
  const a = e.anchors!;
  return [at(a[0]![0]!), at(a[a.length - 1]![0]!)];
}

/** The smallest x of an outline's anchors above 0: a rounded rectangle's
 *  corner radius. */
const radius = (e: LiveElement) =>
  Math.min(...e.anchors!.map((a) => a[0]![0]!).filter((x) => x > 1e-6));

describe("[plugin-slide.live-presets] live presets and connectors", () => {
  it("a resized rounded rectangle keeps its corner radius, in the resize's undo step", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const bytes = fixture("connectors");
    const { host, exporter } = await open(bytes, "connectors");
    const { list } = await page0(host);
    const rr = polygonOf(list, 2);
    expect(radius(rr.element)).toBeCloseTo(108 * 0.3, 1);
    // The resize gesture's write: the outline's box, 4 × 1 in.
    const r = await host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: rr.id,
        path: "frameBounds",
        value: { type: "bounds", value: [0, 0, 72, 288] },
      },
    } as never);
    expect(r.applied).toBe(true);
    await until(async () => {
      const now = polygonOf((await page0(host)).list, 2).element;
      return /"box":\[288(\.0)?,72(\.0)?\]/.test(now.label);
    });
    const now = polygonOf((await page0(host)).list, 2).element;
    // 30 % of the new short side (72), not the old radius scaled.
    expect(radius(now)).toBeCloseTo(72 * 0.3, 1);
    // Export: still a preset, the box PowerPoint gave it on slide 2.
    const out = await exporter.export();
    const back = (await slideEngine()).importPptx(out!.bytes, "back");
    const it2 = back.report.slides[0]!.items.find((i) => i.shapeId === 2)!;
    const ppt = back.report.slides[1]!.items.find((i) => i.shapeId === 2)!;
    for (let k = 0; k < 4; k++)
      expect(it2.bounds[k]).toBeCloseTo(ppt.bounds[k]!, 1);
    // One undo reverts the resize and the redraw together.
    await host.document.undo();
    const undone = polygonOf((await page0(host)).list, 2).element;
    expect(undone.label).toBe(rr.element.label);
    expect(radius(undone)).toBeCloseTo(108 * 0.3, 1);
  }, 120_000);

  it("a moved shape takes its glued connectors along, as PowerPoint routes them", async () => {
    const bytes = fixture("connectors");
    const { host } = await open(bytes, "connectors");
    const { list } = await page0(host);
    const boxB = list.filter((x) => shapeId(x.element) === 7);
    const before = polygonOf(list, 9).element;
    // Move Box B (outline and text) 36 pt right, 72 down, one step.
    const ops = boxB.map((x) => {
      const t = x.element.transform;
      return {
        op: "moveFrame",
        args: {
          frameId: x.element.id,
          transform: [t[0], t[1], t[2], t[3], t[4] + 36, t[5] + 72],
        },
      };
    });
    const r = await host.document.mutate({
      op: "batch",
      args: { ops },
    } as never);
    expect(r.applied).toBe(true);
    await until(async () => {
      const c = polygonOf((await page0(host)).list, 9).element;
      return c.label !== before.label;
    });
    const now = (await page0(host)).list;
    // PowerPoint's slide-2 answer: elbow from Box A's right side to Box B's
    // left side, B now at (432, 324) 144 × 86.4.
    const [s, e] = ends(polygonOf(now, 9).element);
    expect(s[0]).toBeCloseTo(216, 1);
    expect(s[1]).toBeCloseTo(360, 1);
    expect(e[0]).toBeCloseTo(432, 1);
    expect(e[1]).toBeCloseTo(367.2, 1);
    const [cs, ce] = ends(polygonOf(now, 11).element);
    expect(cs[0]).toBeCloseTo(576, 1);
    expect(cs[1]).toBeCloseTo(367.2, 1);
    expect(ce[0]).toBeCloseTo(720, 1);
    expect(ce[1]).toBeCloseTo(396, 1);
    // One undo puts Box B and its connectors back.
    await host.document.undo();
    const undone = polygonOf((await page0(host)).list, 9).element;
    expect(undone.label).toBe(before.label);
    expect(ends(undone)).toEqual(ends(before));
  }, 120_000);

  it("an adjust handle drag changes the adjust value and the outline, one undo step", async () => {
    const bytes = fixture("connectors");
    const { host, exporter } = await open(bytes, "connectors");
    const { list } = await page0(host);
    const rr = polygonOf(list, 2);
    await host.selection.set([rr.id]);
    const model = new HandlesModel(host, slideEngine);
    await model.refresh();
    const s = model.snapshot();
    expect(s.handles.length).toBe(1);
    const h = s.handles[0]!;
    const writes = await model.drag(0, [h.pos[0] + 10, h.pos[1]]);
    expect(model.snapshot().preview).toMatch(/^M/);
    await model.commit(writes);
    const now = polygonOf((await page0(host)).list, 2).element;
    expect(now.label).toContain('"val 39259"');
    expect(radius(now)).toBeCloseTo(42.4, 1);
    const out = await exporter.export();
    const xml = zipText(out!.bytes, "ppt/slides/slide1.xml");
    expect(xml).toContain('<a:gd name="adj" fmla="val 39259"/>');
    model.dispose();
    await host.document.undo();
    expect(radius(polygonOf((await page0(host)).list, 2).element)).toBeCloseTo(
      32.4,
      1,
    );
  }, 120_000);

  it("an unedited deck exports its own bytes, and nothing follows on open", async () => {
    const bytes = fixture("connectors");
    const { host, exporter } = await open(bytes, "connectors");
    const engine = await slideEngine();
    const { list } = await page0(host);
    expect(engine.follow(list.map((x) => x.element))).toEqual([]);
    const out = await exporter.export();
    expect(Buffer.from(out!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(writeMutation([], new Map())).toBeNull();
  }, 120_000);

  it("Insert ▸ Shapes puts a live preset on the slide that exports as a preset", async () => {
    covers("command:media.paged.slide.insertShape");
    const bytes = fixture("connectors");
    const { host, exporter } = await open(bytes, "connectors");
    const pages = await host.document.collection<{ selfId: string }>("pages");
    const res = (await host.objects.invoke(INSERT_SHAPE_COMMAND, {
      prst: "star5",
      slide: slideAddress(pages[0]!.selfId),
      x: 480,
      y: 270,
      w: 100,
      h: 100,
    })) as { shape: string };
    expect(res.shape).toMatch(/polygon/);
    const { list } = await page0(host);
    const star = list.find((x) => x.element.label.includes('"prst":"star5"'))!;
    expect(star).toBeDefined();
    expect(star.element.transform[4]).toBeCloseTo(430, 1);
    const out = await exporter.export();
    const back = (await slideEngine()).importPptx(out!.bytes, "back");
    const xml = zipText(out!.bytes, "ppt/slides/slide1.xml");
    expect(xml).toContain('<a:prstGeom prst="star5">');
    expect(back.report.slides[0]!.items.length).toBe(
      (await slideEngine()).importPptx(bytes, "x").report.slides[0]!.items
        .length + 1,
    );
  }, 120_000);
});
