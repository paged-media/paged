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

// Edit → export → re-import on the real engine (the published canvas-wasm,
// headless) and the real slide wasm (ADR 704, ADR 711): the document is
// edited with the editor's mutations, exported through the exporter (which
// hands the engine the document's `.paged` serialization), and the written
// deck is imported again into a second headless host; what it holds is
// what the edited document held.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost, ExporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { slideEngine } from "../../src/engine";
import {
  layouts,
  newSlide,
  parseState,
  type PluginMetadataEntry,
  type Slide,
} from "../../src/slides-model";

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

/** A host with `bytes` open as the importer opens it. */
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

/** What the exporter reported (its result carries the diagnostics beside
 *  the contract's bytes and file name). */
function diagnostics(out: unknown): string[] {
  return (out as { diagnostics?: string[] } | null)?.diagnostics ?? [];
}

type TreeNode = {
  id?: { kind: string; id: string } | null;
  kind: string;
  children?: TreeNode[];
};

/** Each page's text, story by story in the page's order. */
async function pageTexts(host: BundleHost): Promise<string[][]> {
  const doc = host.document;
  const tree = (await doc.tree()) as TreeNode[];
  const storyOf = new Map<string, string>();
  for (const s of await doc.collection<{ selfId: string }>("stories")) {
    for (const link of await doc.frameChain(s.selfId))
      storyOf.set(link.frameId, s.selfId);
  }
  const out: string[][] = [];
  for (const spread of tree) {
    const texts: string[] = [];
    const walk = async (nodes: TreeNode[]) => {
      for (const n of nodes) {
        const story = n.id ? storyOf.get(n.id.id) : undefined;
        if (story) {
          const c = await doc.storyContent(story);
          const t = (c?.paragraphs ?? [])
            .map((p) => p.runs.map((r) => r.text).join(""))
            .join("\n");
          if (t.trim()) texts.push(t);
        }
        if (n.children?.length) await walk(n.children);
      }
    };
    await walk(spread.children?.[0]?.children ?? []);
    out.push(texts);
  }
  return out;
}

async function slidesOf(host: BundleHost): Promise<Slide[]> {
  const pages = await host.document.collection<{
    selfId: string;
    pluginMetadata?: PluginMetadataEntry[];
  }>("pages");
  return pages.map((p, i) => ({
    pageId: p.selfId,
    number: i + 1,
    sizePt: [960, 540],
    state: parseState(p.pluginMetadata),
  }));
}

/** The first story of page `page` and its text frame. */
async function firstStory(host: BundleHost, page: number) {
  const doc = host.document;
  const tree = (await doc.tree()) as TreeNode[];
  const ids = new Set<string>();
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.id) ids.add(n.id.id);
      if (n.children) walk(n.children);
    }
  };
  walk(tree[page]!.children?.[0]?.children ?? []);
  for (const s of await doc.collection<{ selfId: string }>("stories")) {
    for (const link of await doc.frameChain(s.selfId))
      if (ids.has(link.frameId))
        return { story: s.selfId, frame: link.frameId };
  }
  throw new Error(`page ${page} has no story`);
}

describe("[plugin-slide.export] edit, export, import again", () => {
  it("an edited title's text comes back; the other slides are their bytes", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const bytes = fixture("text");
    const { host, exporter } = await open(bytes, "text");
    const { story } = await firstStory(host, 0);
    const ins = await host.document.mutate({
      op: "insertText",
      args: { storyId: story, offset: 0, text: "Edited: " },
    } as never);
    expect(ins.applied).toBe(true);
    const want = await pageTexts(host);
    const out = await exporter.export();
    expect(out).not.toBeNull();
    expect(diagnostics(out)).toEqual([]);
    const back = await open(out!.bytes, "back");
    expect(await pageTexts(back.host)).toEqual(want);
    expect(want[0]![0]!.startsWith("Edited: ")).toBe(true);
  }, 120_000);

  it("a moved and a deleted item come back moved and gone", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const bytes = fixture("geometry");
    const { host, exporter, report } = await open(bytes, "geometry");
    const items = report.slides[1]!.items;
    // Shapes drawn as one item (an outline with text is two: deleting one
    // of them leaves the other, and the shape stays).
    const single = items.filter((i) => !/p$/.test(i.id));
    expect(single.length).toBeGreaterThan(2);
    const moved = single[0]!;
    const gone = single[1]!;
    const before = moved.bounds;
    const geo = (await host.document.elementGeometry([
      { kind: moved.kind, id: moved.id },
    ] as never)) as { itemTransform?: number[] | null }[];
    const t = geo[0]?.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const r1 = await host.document.mutate({
      op: "moveFrame",
      args: {
        frameId: moved.id,
        transform: [t[0], t[1], t[2], t[3], t[4]! + 24, t[5]! + 12],
      },
    } as never);
    expect(r1.applied).toBe(true);
    const r2 = await host.document.mutate({
      op: "deleteFrame",
      args: { frameId: gone.id },
    } as never);
    expect(r2.applied).toBe(true);
    const out = await exporter.export();
    expect(diagnostics(out)).toEqual([]);
    const again = (await slideEngine()).importPptx(out!.bytes, "back").report;
    const items2 = again.slides[1]!.items;
    expect(items2.length).toBe(items.length - 1);
    expect(items2.some((i) => i.shapeId === gone.shapeId)).toBe(false);
    const m = items2.find((i) => i.shapeId === moved.shapeId)!;
    expect(m.bounds[0]).toBeCloseTo(before[0] + 24, 1);
    expect(m.bounds[1]).toBeCloseTo(before[1] + 12, 1);
    // The other slides' items are where they were.
    for (const i of [0, 2]) {
      expect(again.slides[i]!.items.map((x) => x.bounds)).toEqual(
        report.slides[i]!.items.map((x) => x.bounds),
      );
    }
  }, 120_000);

  it("a slide made in the editor comes back on its layout with its text", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const bytes = fixture("text");
    const { host, exporter, report } = await open(bytes, "text");
    const slides = await slidesOf(host);
    const ls = await layouts(host, slides);
    expect(ls.length).toBeGreaterThan(0);
    const page = await newSlide(host, ls[0]!, slides[0]!.pageId);
    expect(page).not.toBeNull();
    const now = await slidesOf(host);
    const idx = now.findIndex((s) => s.pageId === page);
    const { story } = await firstStory(host, idx);
    await host.document.mutate({
      op: "insertText",
      args: { storyId: story, offset: 0, text: "A new slide" },
    } as never);
    const want = await pageTexts(host);
    const out = await exporter.export();
    expect(diagnostics(out)).toEqual([]);
    const back = await open(out!.bytes, "back");
    expect(back.report.slides.length).toBe(report.slides.length + 1);
    expect(await pageTexts(back.host)).toEqual(want);
    expect(want[idx]).toContain("A new slide");
  }, 120_000);
});
