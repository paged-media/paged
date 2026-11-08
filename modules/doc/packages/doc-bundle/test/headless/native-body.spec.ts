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
import { readdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

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

/** One entry of a ZIP, decompressed. */
function inflatedPart(bytes: Uint8Array, name: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLen),
    );
    if (entry === name) {
      const dataAt =
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true);
      const data = bytes.subarray(dataAt, dataAt + size);
      return method === 0 ? data : new Uint8Array(inflateRawSync(data));
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no ${name} in the package`);
}

type Reply = { kind: string; payload?: any };

interface Opened {
  h: HeadlessHost;
  prefilled: boolean;
  paras: Array<{ text: string; style: string | null; rects: number[][] }>;
  pages: number;
  /** The look of every anchored frame, from the exported IDML. */
  looks: string[];
  /** The endnote elements of the exported IDML, ids normalised. */
  endnotes: string[];
}

/** Every entry of a ZIP under `prefix`, decompressed, as text. */
function zipTexts(bytes: Uint8Array, prefix: string): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLen),
    );
    if (entry.startsWith(prefix)) {
      const dataAt =
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true);
      const data = bytes.subarray(dataAt, dataAt + size);
      out.push(
        new TextDecoder().decode(
          method === 0 ? data : new Uint8Array(inflateRawSync(data)),
        ),
      );
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** What an anchored frame's look is, apart from its ids and geometry. */
function lookOf(xml: string): string {
  const attrs = [
    "FillColor",
    "StrokeColor",
    "StrokeWeight",
    "StrokeType",
    "StrokeDashAndGap",
    "EndCap",
    "EndJoin",
    "MiterLimit",
    "GradientFillAngle",
    "GradientFillLength",
    "GradientFillStart",
  ]
    .map((a) => xml.match(new RegExp(`\\b${a}="[^"]*"`))?.[0] ?? "")
    .join(" ");
  const blocks = (
    xml.match(
      /<(TransparencySetting|DropShadowSetting|InnerShadowSetting|OuterGlowSetting|FeatherSetting|GradientFeatherSetting|BlendingSetting)\b[\s\S]*?(\/>|<\/\1>)/g,
    ) ?? []
  ).join("");
  const label = xml.match(/<Label>[\s\S]*?<\/Label>/)?.[0] ?? "";
  return `${attrs}|${blocks}|${label}`;
}

/** Endnote elements of every part, with their ids numbered by appearance. */
function endnoteElements(idml: Uint8Array): string[] {
  const all = [...zipTexts(idml, "Stories/"), ...zipTexts(idml, "Spreads/")];
  const found = all.flatMap(
    (xml) =>
      xml.match(/<(Endnote|EndnoteRange|EndnoteTextFrame)\b[^>]*>/g) ?? [],
  );
  const ids = new Map<string, string>();
  for (const el of found) {
    const self = el.match(/\bSelf="([^"]*)"/)?.[1];
    if (self && !ids.has(self)) ids.set(self, `#${ids.size}`);
  }
  return found.map((el) =>
    el
      // The story's id is the engine's mint on one side and ours on the other.
      .replace(/\bParentStory="[^"]*"/, 'ParentStory="story"')
      .replace(/="([^"]*)"/g, (_m, v: string) => `="${ids.get(v) ?? v}"`),
  );
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
  const idml = (await h.exportDocument("idml")).bytes;
  // Doc ADR 627 — the shapes without text are drawn by the native open only
  // (the old pour has no frame with an outline): their frames are not part of
  // the comparison, and `shapes.spec.ts` holds them.
  const looks = zipTexts(idml, "Stories/")
    .flatMap(
      (xml) => xml.match(/<(Rectangle|TextFrame)\b[\s\S]*?<\/\1>/g) ?? [],
    )
    .filter((xml) => !/\bSelf="docx_shape\d+"/.test(xml))
    .map(lookOf);
  return {
    h,
    prefilled,
    paras,
    pages: pageIds.length,
    looks,
    endnotes: endnoteElements(idml),
  };
}

describe.skipIf(!docxPresent)("doc headless — native body (ADR 625)", () => {
  const opened: HeadlessHost[] = [];
  afterEach(() => {
    for (const h of opened.splice(0)) h.dispose();
  });

  // The safety net of the prefilled open (ADR 625): EVERY .docx fixture of the
  // bundle is opened by the old pour and by the native body; wherever the
  // body is built natively, both must agree on text, pages and geometry and
  // must export alike. A regression of the builder shows here, in CI.
  const FIXTURES = readdirSync(new URL("../fixtures/", import.meta.url))
    .filter((n) => n.endsWith(".docx"))
    .sort();
  const prefilledNames: string[] = [];
  const MUST_OPEN: string[] = [
    "direct-format.docx",
    "table-body.docx",
    "picture-body.docx",
    "field-body.docx",
    "list-body.docx",
    "hyperlink-body.docx",
    "drop-cap.docx",
    "review-body.docx",
    "toc-body.docx",
    "breaks-body.docx",
    "picture-effects.docx",
    "objects-text-boxes.docx",
    "objects-languages.docx",
    "endnote-body.docx",
    "break-kept-body.docx",
    "shapes.docx",
    "embedded-fonts.docx",
  ];

  for (const name of FIXTURES) {
    it(`${name}: the native open agrees with the old pour`, async () => {
      const old = await open(name, false);
      const native = await open(name, true);
      opened.push(old.h, native.h);
      expect(old.prefilled).toBe(false);
      if (!native.prefilled) return;
      prefilledNames.push(name);
      expect(native.pages).toBe(old.pages);
      expect(native.paras.map((p) => p.text)).toEqual(
        old.paras.map((p) => p.text),
      );
      expect(native.paras.map((p) => p.rects)).toEqual(
        old.paras.map((p) => p.rects),
      );
      // Doc ADR 625 — the looks of pictures and text boxes, and the endnote
      // story, are the old pour's.
      expect(native.looks).toEqual(old.looks);
      expect(native.endnotes).toEqual(old.endnotes);
      // Where nothing keeps one, no paragraph names a style the lowering
      // invented for direct formatting.
      // (A picture's line keeps the style made for its pitch, ADR 625.)
      if (MUST_OPEN.includes(name) && name !== "picture-effects.docx") {
        expect(native.paras.some((p) => p.style?.includes("docx-auto"))).toBe(
          false,
        );
      }
      const exported = async (o: Opened): Promise<string> => {
        const exporter = o.h
          .exportersContributed()
          .find(
            (c) => c.id === "media.paged.doc.exporter.docx",
          ) as ExporterContribution;
        const out = await exporter.export();
        expect(out).not.toBeNull();
        return new TextDecoder().decode(
          inflatedPart(out!.bytes, "word/document.xml"),
        );
      };
      expect(await exported(native)).toEqual(await exported(old));
    }, 120_000);
  }

  it("the fixtures that must open natively still do", () => {
    for (const name of MUST_OPEN) {
      expect(prefilledNames).toContain(name);
    }
  });

  it("a document the builder cannot take whole opens by the old pour", async () => {
    const doc = await open("controls.docx", true);
    opened.push(doc.h);
    expect(doc.prefilled).toBe(false);
    expect(doc.paras.length).toBeGreaterThan(0);
  }, 120_000);
});
