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

// The lift of the earlier live-preset labels (slide ADR 717, amendment of
// 2026-11-11) on the real engine and the real slide wasm: a deck whose
// presets are labels and not the engine's is lifted in one batch, and the
// engine then routes a glued connector when its shape moves.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";

import type {
  BundleHost,
  ElementId,
  ExporterContribution,
  MutationInput,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { slideEngine } from "../../src/engine";
import { LABEL_KEY } from "../../src/object-model";
import {
  hasOldLabels,
  isOldLabel,
  liftOldLabels,
} from "../../src/preset-migration";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as Parameters<HeadlessHost["loadBundle"]>[0]["manifest"];

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../../../slide-conformance/fixtures/${name}.pptx`,
        import.meta.url,
      ),
    ),
  );

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
  return { host, exporter };
}

/** One part of a zip package. */
function zipPart(bytes: Uint8Array, want: string): string {
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
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === want) {
      const start =
        local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`no ${want}`);
}

/** Every element with a slide label, and the label. */
async function labelled(host: BundleHost) {
  const out: { id: ElementId; label: string }[] = [];
  const walk = (nodes: readonly SceneTreeNode[] | undefined) => {
    for (const n of nodes ?? []) {
      const label = n.pluginMetadata?.find((m) => m.key === LABEL_KEY)?.value;
      if (n.id && label) out.push({ id: n.id, label });
      walk(n.children);
    }
  };
  walk(await host.document.tree());
  return out;
}

const S1 = "ppt/slides/slide1.xml";
const shapeOf = (label: string) =>
  (JSON.parse(label) as { data: { shape?: string } }).data.shape;

describe("[plugin-slide.live-presets] the earlier preset labels", () => {
  it("are lifted onto the engine's presets, which then route a moved shape's connectors", async () => {
    const bytes = fixture("connectors");
    const { host, exporter } = await open(bytes, "connectors");
    const engine = await slideEngine();
    expect(await hasOldLabels(host)).toBe(false);
    // The document as the earlier version saved it: the engine's presets
    // ended (Expand Shape keeps the paths), the preset and its box in the
    // label, the elbow connector's glue as `cNvPr` ids.
    const els = await labelled(host);
    const paths = els.filter((e) => e.id.kind === "polygon");
    const geometry: Record<
      string,
      { name: string; adj: string[][]; box: number[] }
    > = {
      [`${S1}#2`]: {
        name: "roundRect",
        adj: [["adj", "val 30000"]],
        box: [180, 108],
      },
      [`${S1}#6`]: { name: "rect", adj: [], box: [0, 0] },
      [`${S1}#7`]: { name: "ellipse", adj: [], box: [0, 0] },
    };
    const ops: MutationInput[] = [];
    const geo = await host.document.elementGeometry(paths.map((p) => p.id));
    for (const p of paths) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId: p.id,
          path: "frameShapePreset",
          value: { type: "text", value: "" },
        },
      } as MutationInput);
      const key = shapeOf(p.label)!;
      const g = geo.find((x) => JSON.stringify(x.id) === JSON.stringify(p.id));
      const [t, l, b, r] = g!.bounds as number[];
      const data: Record<string, unknown> = { shape: key };
      const known = geometry[key];
      if (known) {
        data.preset = { prst: known.name, adj: known.adj };
        data.box = key.endsWith("#2") ? known.box : [r! - l!, b! - t!];
      }
      if (key === `${S1}#9`) {
        data.preset = { prst: "bentConnector3", adj: [] };
        data.box = [r! - l!, b! - t!];
        data.connector = {
          st: { id: 6, idx: 3, at: [0, 0] },
          end: { id: 7, idx: 2, at: [0, 0] },
        };
      }
      ops.push({
        op: "setPluginMetadata",
        args: {
          elementId: p.id,
          key: LABEL_KEY,
          value: JSON.stringify({ v: 1, data }),
        },
      } as MutationInput);
    }
    // The rounded rectangle's text frame: no preset key, the old label.
    const rrText = els.find(
      (e) => e.id.kind === "textFrame" && shapeOf(e.label) === `${S1}#2`,
    )!;
    ops.push(
      {
        op: "setElementProperty",
        args: {
          elementId: rrText.id,
          path: "frameShapePresetText",
          value: { type: "text", value: "" },
        },
      } as MutationInput,
      {
        op: "setPluginMetadata",
        args: {
          elementId: rrText.id,
          key: LABEL_KEY,
          value: JSON.stringify({
            v: 1,
            data: {
              shape: `${S1}#2`,
              preset: { prst: "roundRect", adj: [["adj", "val 30000"]] },
              box: [180, 108],
            },
          }),
        },
      } as MutationInput,
    );
    const old = await host.document.mutate({
      op: "batch",
      args: { ops },
    } as MutationInput);
    expect(old.applied).toBe(true);
    expect(await hasOldLabels(host)).toBe(true);
    expect(
      engine.migrate(await host.documents.exportPaged()).length,
    ).toBeGreaterThan(0);

    // The lift: one batch, and nothing old is left.
    expect(await liftOldLabels(host, slideEngine)).toBeGreaterThan(0);
    expect((await labelled(host)).some((e) => isOldLabel(e.label))).toBe(false);
    expect(engine.migrate(await host.documents.exportPaged())).toEqual([]);

    // The rounded rectangle doubles its width: the engine refits it and its
    // text frame, which took the preset key in the lift, follows.
    const rr = (await labelled(host)).find(
      (e) => e.id.kind === "polygon" && shapeOf(e.label) === `${S1}#2`,
    )!;
    const [rg, tg] = await host.document.elementGeometry([rr.id, rrText.id]);
    const width = (g: { bounds: number[]; itemTransform?: number[] | null }) =>
      (g.bounds[3]! - g.bounds[1]!) * (g.itemTransform?.[0] ?? 1);
    const textBefore = width(tg as never);
    const rt = [...((rg!.itemTransform ?? [1, 0, 0, 1, 0, 0]) as number[])];
    rt[0]! *= 2;
    const grown = await host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: rr.id,
        path: "frameTransform",
        value: { type: "transform", value: rt },
      },
    } as MutationInput);
    expect(grown.applied).toBe(true);
    const [tg2] = await host.document.elementGeometry([rrText.id]);
    expect(width(tg2 as never)).toBeCloseTo(textBefore * 2, 1);

    // Box B (`cNvPr` 7) moves right 36 pt and down 72: the engine routes the
    // elbow connector glued to it, so its exported box changes.
    const before = zipPart((await exporter.export())!.bytes, S1);
    const box = (await labelled(host)).find(
      (e) => e.id.kind === "polygon" && shapeOf(e.label) === `${S1}#7`,
    )!;
    const [g] = await host.document.elementGeometry([box.id]);
    const m = [...((g!.itemTransform ?? [1, 0, 0, 1, 0, 0]) as number[])];
    m[4]! += 36;
    m[5]! += 72;
    const moved = await host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: box.id,
        path: "frameTransform",
        value: { type: "transform", value: m },
      },
    } as MutationInput);
    expect(moved.applied).toBe(true);
    const after = zipPart((await exporter.export())!.bytes, S1);
    const elbow = (x: string) => {
      const at = x.indexOf('name="Elbow Connector 8"');
      const s = x.lastIndexOf("<p:cxnSp>", at);
      return x.slice(s, x.indexOf("</p:cxnSp>", at));
    };
    expect(elbow(after)).not.toBe(elbow(before));
    expect(elbow(after)).toContain('<a:prstGeom prst="bentConnector3">');
    expect(elbow(after)).toContain('<a:stCxn id="6" idx="3"/>');
  }, 120_000);
});
