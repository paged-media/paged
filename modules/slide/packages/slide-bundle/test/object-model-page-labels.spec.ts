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

// Slide data on PAGE labels (plugin-sdk DESIGN.md §21.8, engine protocol 70
// `setPageMetadata`): each slide's hidden / notes / transition / layout
// lives in its own page's `x-paged:media.paged.slide` label, so no deck is
// bound by one 64 KiB document label; the document label keeps only the
// deck. A deck written in the earlier layout (every slide in the document
// label) still reads, and its first write moves the slides onto their
// pages in the same single undo step. Real engine (canvas-wasm 0.70.0) and
// real slide wasm.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";
import type { MutationInput, ObjectValue } from "@paged-media/plugin-api";

import slideBundle from "../src/index";
import { parseState } from "../src/slides-model";
import { slideEngine, type ImportReport } from "../src/engine";
import { DECK_ADDRESS, IMPORT_PPTX_COMMAND, LABEL_KEY, NEW_SLIDE_COMMAND, PLUGIN_ID, transitionRecord } from "../src/object-model";

const P = "plugin:media.paged.slide";
const FIXTURE = new URL("../../../slide-conformance/fixtures/placeholders.pptx", import.meta.url);

const v = (x: ObjectValue): unknown => (x.kind === "value" ? x.value : x);

let h: HeadlessHost;
let report: ImportReport;
let slides: string[];

/** Every engine mutation the bundle host sends, counted. */
let mutateCalls = 0;

beforeEach(async () => {
  h = await createHeadlessHost();
  h.loadBundle(slideBundle);
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  report = (await slideEngine()).importPptx(bytes, "placeholders").report;
  slides = ((await h.objects.invoke(IMPORT_PPTX_COMMAND, { bytes, name: "placeholders.pptx" })) as { slides: string[] }).slides;
  mutateCalls = 0;
  const client = h.host.editor.client as { mutate: (m: unknown) => Promise<unknown> };
  const mutate = client.mutate.bind(client);
  client.mutate = (m) => {
    mutateCalls++;
    return mutate(m);
  };
}, 60_000);

afterEach(() => h.dispose());

async function labelOf(address: string): Promise<{ v: number; data: Record<string, unknown> } | null> {
  const out = v(await h.objects.get(address, "labels")) as Record<string, string>;
  const raw = out?.[LABEL_KEY];
  return raw ? JSON.parse(raw) : null;
}

const pageOf = (pageId: string): string => `page:${pageId}`;

describe("[plugin-slide.object-model] slide data on page labels (protocol 70)", () => {
  it("the import writes each slide to its own page label and only the deck to the document label", async () => {
    for (const s of report.slides) {
      const label = await labelOf(pageOf(s.pageId));
      expect(label?.v).toBe(1);
      // The importer's flat shape, the one the Slides and Notes panels read.
      expect(label?.data["slide"]).toBeUndefined();
      expect(label?.data["part"]).toBe(s.part);
      expect(label?.data["notes"]).toBe(s.notes && s.notes.trim() !== "" ? s.notes : undefined);
      expect(label?.data["hidden"]).toBe(s.hidden ? true : undefined);
      expect(v(await h.objects.get(slides[report.slides.indexOf(s)]!, "notes"))).toBe(s.notes && s.notes.trim() !== "" ? s.notes : null);
    }
    const doc = await labelOf("doc");
    expect(doc?.data["deck"]).toMatchObject({ name: "placeholders", width: report.width });
    expect(doc?.data["slides"]).toBeUndefined();
    // The page label selects its pages.
    expect((await h.objects.query(`page[label.${LABEL_KEY}^={]`)).length).toBe(report.slides.length);
  });

  it("a slide is hosted by its page: a page scope selects it", async () => {
    expect(await h.objects.query(`page:#2 > ${P}/slide`)).toEqual([slides[1]]);
  });

  it("set notes rewrites that page's label only — one engine mutation, one undo step", async () => {
    const docBefore = await labelOf("doc");
    const otherBefore = await labelOf(pageOf(report.slides[1]!.pageId));
    const out = await h.objects.set(slides[0]!, "notes", "Page-hosted — ü");
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(mutateCalls).toBe(1);
    const own = await labelOf(pageOf(report.slides[0]!.pageId));
    expect(own?.data).toMatchObject({ notes: "Page-hosted — ü", part: report.slides[0]!.part });
    expect(parseState([{ key: LABEL_KEY, value: JSON.stringify(own) }]).notes).toBe("Page-hosted — ü");
    expect(await labelOf("doc")).toEqual(docBefore);
    expect(await labelOf(pageOf(report.slides[1]!.pageId))).toEqual(otherBefore);
    await h.host.document.undo();
    expect(v(await h.objects.get(slides[0]!, "notes"))).toBe(report.slides[0]!.notes);
  });

  it("a model write keeps what it does not own: the source part, and the deck's transition element while it still describes it", async () => {
    const m = await createHeadlessHost();
    try {
      m.loadBundle(slideBundle);
      const bytes = new Uint8Array(readFileSync(new URL("../../../slide-conformance/fixtures/motion.pptx", import.meta.url)));
      const motion = (await slideEngine()).importPptx(bytes, "motion").report;
      const ms = ((await m.objects.invoke(IMPORT_PPTX_COMMAND, { bytes, name: "motion.pptx" })) as { slides: string[] }).slides;
      const i = motion.slides.findIndex((s) => s.transition);
      expect(i).toBeGreaterThanOrEqual(0);
      const label = async () => {
        const raw = (v(await m.objects.get(pageOf(motion.slides[i]!.pageId), "labels")) as Record<string, string>)[LABEL_KEY];
        return JSON.parse(raw!) as { data: Record<string, unknown> };
      };
      const xml = ((await label()).data["transition"] as { xml?: string }).xml;
      expect(xml).toBeTruthy();
      expect(await m.objects.set(ms[i]!, "hidden", true)).toMatchObject({ applied: true });
      let now = await label();
      expect(now.data).toMatchObject({ part: motion.slides[i]!.part, hidden: true });
      expect((now.data["transition"] as { xml?: string }).xml).toBe(xml);
      const other = motion.slides[i]!.transition!.kind === "push" ? "wipe" : "push";
      expect(await m.objects.set(ms[i]!, "transitionKind", other)).toMatchObject({ applied: true });
      now = await label();
      expect(now.data["transition"]).toMatchObject({ kind: other });
      expect((now.data["transition"] as { xml?: string }).xml).toBeUndefined();
      expect(now.data["part"]).toBe(motion.slides[i]!.part);
    } finally {
      m.dispose();
    }
  }, 60_000);

  it("a long note per slide is no longer bound by one shared document label", async () => {
    const long = "x".repeat(40_000);
    const out = await h.objects.batch([
      { op: "set", address: slides[0]!, path: "notes", value: long },
      { op: "set", address: slides[1]!, path: "notes", value: long },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(mutateCalls).toBe(1);
    expect(v(await h.objects.get(slides[1]!, "notes"))).toBe(long);
    // One slide's own label is still capped.
    expect(await h.objects.set(slides[0]!, "notes", "y".repeat(70_000))).toMatchObject({ applied: false });
  });

  it("newSlide takes partial args: {} appends after the last slide", async () => {
    const n = slides.length;
    const out = (await h.objects.invoke(NEW_SLIDE_COMMAND, {})) as { slide: string };
    const now = await h.objects.query(`${P}/slide`);
    expect(now.length).toBe(n + 1);
    expect(now.at(-1)).toBe(out.slide);
    const second = (await h.objects.invoke(NEW_SLIDE_COMMAND, { after: slides[0]! })) as { slide: string };
    expect((await h.objects.query(`${P}/slide`))[1]).toBe(second.slide);
  });
});

describe("[plugin-slide.object-model] the earlier document-label layout still reads, and migrates on write", () => {
  /** Rewrite the document into the pre-0.2.43 layout: every slide in the
   *  document label (slide 2 keyed by a STALE id, found by its ordinal),
   *  no page labels. */
  async function toLegacyLayout(): Promise<void> {
    const slidesRec: Record<string, unknown> = {};
    report.slides.forEach((s, i) => {
      const id = i === 1 ? "u-stale-renumbered" : s.pageId;
      slidesRec[id] = {
        ord: i + 1,
        hidden: i === 1 ? true : s.hidden,
        notes: i === 0 ? "legacy notes" : s.notes,
        transition: transitionRecord(s.transition),
      };
    });
    const ops: MutationInput[] = [
      {
        op: "setDocumentMetadata",
        args: {
          key: LABEL_KEY,
          value: JSON.stringify({ v: 1, data: { deck: { name: "legacy", width: report.width, height: report.height, fonts: report.fonts }, slides: slidesRec } }),
          caller: PLUGIN_ID,
        },
      } as MutationInput,
      ...report.slides.map(
        (s) => ({ op: "setPageMetadata", args: { page: s.pageId, key: LABEL_KEY, value: null, caller: PLUGIN_ID } }) as MutationInput,
      ),
    ];
    const r = await h.host.document.mutate({ op: "batch", args: { ops } } as MutationInput);
    expect(r.applied).toBe(true);
    for (const s of report.slides) expect(await labelOf(pageOf(s.pageId))).toBeNull();
  }

  it("reads the legacy layout (by page id, and by ordinal for a renumbered page)", async () => {
    await toLegacyLayout();
    expect(v(await h.objects.get(slides[0]!, "notes"))).toBe("legacy notes");
    expect(v(await h.objects.get(slides[1]!, "hidden"))).toBe(true);
    expect(v(await h.objects.get(DECK_ADDRESS, "name"))).toBe("legacy");
  });

  it("the first write moves every slide onto its page and trims the document label — one undo step", async () => {
    await toLegacyLayout();
    mutateCalls = 0;
    const out = await h.objects.set(slides[2]!, "notes", "after migration");
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(mutateCalls).toBe(1);
    const doc = await labelOf("doc");
    expect(doc?.data["slides"]).toBeUndefined();
    expect(doc?.data["deck"]).toMatchObject({ name: "legacy" });
    expect((await labelOf(pageOf(report.slides[0]!.pageId)))?.data).toMatchObject({ notes: "legacy notes" });
    expect((await labelOf(pageOf(report.slides[1]!.pageId)))?.data).toMatchObject({ hidden: true });
    expect((await labelOf(pageOf(report.slides[2]!.pageId)))?.data).toMatchObject({ notes: "after migration" });
    // Reads are unchanged by the move.
    expect(v(await h.objects.get(slides[0]!, "notes"))).toBe("legacy notes");
    expect(v(await h.objects.get(slides[1]!, "hidden"))).toBe(true);
    // Undo restores the legacy layout whole.
    await h.host.document.undo();
    expect(Object.keys(((await labelOf("doc"))?.data["slides"] ?? {}) as object).length).toBe(report.slides.length);
    for (const s of report.slides) expect(await labelOf(pageOf(s.pageId))).toBeNull();
    expect(v(await h.objects.get(slides[2]!, "notes"))).toBe(report.slides[2]!.notes);
  });
});
