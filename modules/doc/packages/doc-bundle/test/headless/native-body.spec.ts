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

// Doc ADR 625, slice 2 — the body built natively by the engine's model
// (docx-skeleton `skeleton_prefilled`) against the old pour, on the REAL
// engine: the same document opened both ways must hold the same text, lay
// out the same (every paragraph's selection rectangles), name no
// synthesized style on a paragraph, and export unedited as the source.

import { afterEach, describe, expect, it } from "bun:test";

import type { ExporterContribution } from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import { DocEngine } from "../../src/engine";
import { finishStandalone } from "../../src/open";
import {
  ENGINE_ANCHOR,
  docxPresent,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — native body");

type Reply = { kind: string; payload?: any };

interface Opened {
  h: HeadlessHost;
  prefilled: boolean;
  paras: Array<{ text: string; style: string | null; rects: number[][] }>;
  pages: number;
}

async function open(name: string, native: boolean): Promise<Opened> {
  const bytes = fixture(name);
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silent,
  });
  const engine = await DocEngine.boot();
  let prefilled = false;
  try {
    engine.loadDocx(bytes);
    const ir = engine.lowered();
    const pre = native ? engine.skeletonPagedPrefilled(name) : null;
    prefilled = pre !== null;
    await h.load(pre ?? engine.skeletonPaged(name));
    h.loadBundle(docBundle);
    await finishStandalone(
      h.host,
      engine,
      ir,
      bytes,
      name,
      (paged) => h.load(paged),
      prefilled,
    );
  } finally {
    engine.dispose();
  }
  const send = (m: unknown) =>
    h.host.editor.client.send(m as never) as Promise<Reply>;
  const script = async (s: string) => {
    const r = await send({ kind: "executeScript", payload: { source: s } });
    return JSON.parse(r.payload?.output?.[0] ?? "[]");
  };
  let last = -1;
  let pageIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const ps = (await script("paged.pages()")) as Array<{ selfId: string }>;
    for (const p of ps) {
      await send({
        kind: "requestPage",
        payload: { pageId: p.selfId, lod: "live" },
      });
    }
    pageIds = ps.map((p) => p.selfId);
    if (ps.length === last) break;
    last = ps.length;
  }
  const paras: Opened["paras"] = [];
  const stories = (await script("paged.stories()")) as Array<{
    selfId: string;
  }>;
  for (const { selfId } of stories) {
    if (!selfId.startsWith("docx_s")) continue;
    const r = await send({
      kind: "requestStoryContent",
      payload: { storyId: selfId },
    });
    const content: Array<{
      paragraphStyle?: string;
      runs: Array<{ text: string }>;
    }> = r.payload?.content?.paragraphs ?? [];
    let off = 0;
    for (const p of content) {
      const b = (
        await send({
          kind: "requestParagraphBounds",
          payload: { storyId: selfId, offset: off },
        })
      ).payload?.bounds as { start: number; end: number } | null;
      if (!b) break;
      const g = await send({
        kind: "requestSelectionGeometry",
        payload: {
          selection: {
            storyId: selfId,
            start: b.start,
            end: Math.max(b.end, b.start),
          },
        },
      });
      const rects: Array<{
        pageId: string;
        topPt: number;
        leftPt: number;
        widthPt: number;
        heightPt: number;
      }> = g.payload?.rects ?? [];
      paras.push({
        text: p.runs.map((x) => x.text).join(""),
        style: p.paragraphStyle ?? null,
        rects: rects.map((x) =>
          [
            pageIds.indexOf(x.pageId),
            x.topPt,
            x.leftPt,
            x.widthPt,
            x.heightPt,
          ].map((v) => Math.round(v * 10) / 10),
        ),
      });
      if (b.end + 1 <= off) break;
      off = b.end + 1;
    }
  }
  return { h, prefilled, paras, pages: pageIds.length };
}

describe.skipIf(!docxPresent)("doc headless — native body (ADR 625)", () => {
  const opened: HeadlessHost[] = [];
  afterEach(() => {
    for (const h of opened.splice(0)) h.dispose();
  });

  it("direct-format.docx opens natively, as the old pour lays it out", async () => {
    const old = await open("direct-format.docx", false);
    const native = await open("direct-format.docx", true);
    opened.push(old.h, native.h);
    expect(old.prefilled).toBe(false);
    expect(native.prefilled).toBe(true);
    expect(native.pages).toBe(old.pages);
    expect(native.paras.map((p) => p.text)).toEqual(
      old.paras.map((p) => p.text),
    );
    expect(native.paras.map((p) => p.rects)).toEqual(
      old.paras.map((p) => p.rects),
    );
    // No paragraph names a style the lowering invented for direct formatting.
    expect(native.paras.some((p) => p.style?.includes("docx-auto"))).toBe(
      false,
    );
    expect(old.paras.some((p) => p.style?.includes("docx-auto"))).toBe(true);
  }, 120_000);

  it("a document the builder cannot take whole opens by the old pour", async () => {
    const doc = await open("structure.docx", true);
    opened.push(doc.h);
    expect(doc.prefilled).toBe(false);
    expect(doc.paras.length).toBeGreaterThan(0);
  }, 120_000);

  it("a natively opened document exports unedited as its source", async () => {
    const native = await open("direct-format.docx", true);
    opened.push(native.h);
    const exporter = native.h
      .exportersContributed()
      .find(
        (c) => c.id === "media.paged.doc.exporter.docx",
      ) as ExporterContribution;
    const out = await exporter.export();
    expect(out).not.toBeNull();
    expect(
      Buffer.from(out!.bytes).equals(
        Buffer.from(fixture("direct-format.docx")),
      ),
    ).toBe(true);
  }, 120_000);
});
