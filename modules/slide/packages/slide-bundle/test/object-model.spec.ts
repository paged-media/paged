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

// The slide object model through `host.objects`, on the real engine (the
// published canvas-wasm, headless) and the real slide wasm: the typed import
// command opens a PowerPoint-authored deck the way the Node CLI would, then
// every kind is listed, read, written and undone through the one registry
// the CLI, Boa bridge and panels share. The headless host has no container
// parts, so every read here comes from the LABELS — the persistence the
// model claims (the report part is only a cache) — and a save-and-reopen
// proves they travel in the document.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHeadlessHost, validateValue, type HeadlessHost } from "@paged-media/plugin-sdk";
import type { ObjectValue, ValueType } from "@paged-media/plugin-api";

import slideBundle from "../src/index";
import { slideEngine, type ImportReport } from "../src/engine";
import {
  DECK_ADDRESS,
  IMPORT_PPTX_COMMAND,
  NEW_SLIDE_COMMAND,
  SLIDE_SCHEMA,
  PLACEHOLDER_SCHEMA,
  DECK_SCHEMA,
  LAYOUT_SCHEMA,
  slideAddress,
} from "../src/object-model";
import { SLIDE_PANEL_FIELDS } from "../src/panel-fields";

const P = "plugin:media.paged.slide";
const FIXTURE = new URL("../../../slide-conformance/fixtures/placeholders.pptx", import.meta.url);

const v = (x: ObjectValue): unknown => (x.kind === "value" ? x.value : x);

let h: HeadlessHost;
let report: ImportReport;
let slides: string[];

async function open(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  report = (await slideEngine()).importPptx(bytes, "placeholders").report;
  const out = (await h.objects.invoke(IMPORT_PPTX_COMMAND, { bytes, name: "placeholders.pptx" })) as {
    slides: string[];
  };
  slides = out.slides;
}

beforeEach(async () => {
  h = await createHeadlessHost();
  h.loadBundle(slideBundle);
  await open();
}, 60_000);

afterEach(() => h.dispose());

describe("[plugin-slide.object-model] slides, layouts, placeholders through host.objects", () => {
  it("declares four kinds and two typed commands", async () => {
    const kinds = (await h.objects.kinds()).filter((k) => k.owner === "media.paged.slide").map((k) => k.kind);
    expect(kinds.sort()).toEqual([`${P}/deck`, `${P}/layout`, `${P}/placeholder`, `${P}/slide`]);
    const commands = (await h.objects.commands()).map((c) => c.id).sort();
    expect(commands).toEqual([IMPORT_PPTX_COMMAND, NEW_SLIDE_COMMAND]);
  });

  it("the import command opens a slide per page; the deck answers from its label", async () => {
    expect(slides).toEqual(report.slides.map((s) => slideAddress(s.pageId)));
    expect(await h.objects.query(`${P}/slide`)).toEqual(slides);
    expect(v(await h.objects.get(DECK_ADDRESS, "slideCount"))).toBe(report.slides.length);
    expect(v(await h.objects.get(DECK_ADDRESS, "slideWidth"))).toBe(report.width);
    expect(v(await h.objects.get(DECK_ADDRESS, "name"))).toBe("placeholders");
  });

  it("reads each slide's imported notes, hidden flag and transition from the label", async () => {
    for (const [i, s] of report.slides.entries()) {
      const all = await h.objects.getAll(slides[i]!);
      expect(v(all.index!)).toBe(i + 1);
      expect(v(all.hidden!)).toBe(s.hidden);
      expect(v(all.notes!)).toBe(s.notes);
      expect(v(all.transitionKind!)).toBe(s.transition?.kind ?? "none");
      expect(v(all.page!)).toBe(`page:${s.pageId}`);
    }
  });

  it("set notes: one undo step, read back equal, undo restores", async () => {
    const before = v(await h.objects.get(slides[0]!, "notes"));
    const out = await h.objects.set(slides[0]!, "notes", "Say hello.\nThen the agenda — ü");
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(v(await h.objects.get(slides[0]!, "notes"))).toBe("Say hello.\nThen the agenda — ü");
    await h.host.document.undo();
    expect(v(await h.objects.get(slides[0]!, "notes"))).toBe(before);
  });

  it("a batch across slides and a placeholder is ONE undo step", async () => {
    const textPh = [];
    for (const a of await h.objects.query(`${P}/placeholder`)) {
      if ((await h.objects.get(a, "content")).kind === "value") textPh.push(a);
    }
    expect(textPh.length).toBeGreaterThan(0);
    const oldText = v(await h.objects.get(textPh[0]!, "content"));
    const out = await h.objects.batch([
      { op: "set", address: slides[0]!, path: "hidden", value: true },
      { op: "set", address: slides[1]!, path: "transitionKind", value: "fade" },
      { op: "set", address: slides[1]!, path: "transitionDuration", value: 700 },
      { op: "set", address: textPh[0]!, path: "content", value: "Quarterly review" },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(v(await h.objects.get(slides[0]!, "hidden"))).toBe(true);
    expect(v(await h.objects.get(slides[1]!, "transitionKind"))).toBe("fade");
    expect(v(await h.objects.get(slides[1]!, "transitionDuration"))).toBe(700);
    expect(v(await h.objects.get(textPh[0]!, "content"))).toBe("Quarterly review");
    await h.host.document.undo();
    expect(v(await h.objects.get(slides[0]!, "hidden"))).toBe(report.slides[0]!.hidden);
    expect(v(await h.objects.get(slides[1]!, "transitionKind"))).toBe(report.slides[1]!.transition?.kind ?? "none");
    expect(v(await h.objects.get(textPh[0]!, "content"))).toBe(oldText);
  });

  it("placeholders carry PowerPoint's type and index and point at their frame and slide", async () => {
    const all = await h.objects.query(`${P}/placeholder`);
    const expected = report.slides.flatMap((s) => s.items.filter((i) => i.placeholder));
    expect(all.length).toBe(expected.length);
    for (const it of expected) {
      const a = `${P}/placeholder/${it.id}`;
      expect(v(await h.objects.get(a, "type"))).toBe(it.placeholder![0]);
      expect(v(await h.objects.get(a, "index"))).toBe(it.placeholder![1]);
      expect(v(await h.objects.get(a, "target"))).toBe(`${it.kind}:${it.id}`);
      const owner = report.slides.find((s) => s.items.includes(it))!;
      expect(v(await h.objects.get(a, "slide"))).toBe(slideAddress(owner.pageId));
    }
    // A selector over a schema path: the registry post-filters by `get`.
    const titles = await h.objects.query(`${P}/placeholder[type=title]`);
    expect(titles.length).toBe(expected.filter((i) => i.placeholder![0] === "title").length);
  });

  it("layouts are the deck's masters; setting a slide's layout applies the master in one step", async () => {
    const layouts = await h.objects.query(`${P}/layout`);
    expect(layouts.length).toBeGreaterThan(0);
    const name = v(await h.objects.get(layouts[0]!, "name"));
    expect(typeof name).toBe("string");
    const out = await h.objects.set(slides[0]!, "layout", layouts.at(-1)!);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(v(await h.objects.get(slides[0]!, "layout"))).toBe(layouts.at(-1));
    expect(await h.objects.set(slides[0]!, "layout", `${P}/layout/nope`)).toMatchObject({ applied: false });
  });

  it("refuses a value outside the schema, a read-only path and a create — never coerces", async () => {
    expect(await h.objects.set(slides[0]!, "transitionKind", "spin")).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.set(slides[0]!, "hidden", "yes")).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.set(slides[0]!, "index", 4)).toMatchObject({ applied: false });
    expect(await h.objects.batch([{ op: "create", kind: `${P}/slide` }])).toMatchObject({ applied: false });
  });

  it("newSlide and delete change the deck, each one undo step", async () => {
    const n = slides.length;
    const out = (await h.objects.invoke(NEW_SLIDE_COMMAND, { after: slides[0]!, layout: "" })) as { slide: string };
    expect(validateValue({ kind: "struct", fields: { slide: { kind: "ref", to: "slide" } } }, out)).toBeNull();
    const now = await h.objects.query(`${P}/slide`);
    expect(now.length).toBe(n + 1);
    expect(now[1]).toBe(out.slide);
    expect(v(await h.objects.get(out.slide, "notes"))).toBeNull();
    expect(await h.objects.batch([{ op: "delete", address: out.slide }])).toMatchObject({ applied: true, undoSteps: 1 });
    expect((await h.objects.query(`${P}/slide`)).length).toBe(n);
    await expect(h.objects.invoke(NEW_SLIDE_COMMAND, { after: "x" })).rejects.toThrow(/invalidValue/);
  });

  it("labels are the persistence: a saved and reopened deck keeps its slide data", async () => {
    await h.objects.set(slides[2]!, "notes", "kept through save");
    // The harness side of the save (the bundle declares no export door).
    const reply = await h.host.editor.client.send({ kind: "exportPaged", payload: {} });
    expect(reply.kind).toBe("pagedExported");
    const saved = Uint8Array.from((reply as { payload: { bytes: number[] } }).payload.bytes);
    await h.load(saved);
    expect(v(await h.objects.get(slides[2]!, "notes"))).toBe("kept through save");
    expect(v(await h.objects.get(DECK_ADDRESS, "slideCount"))).toBe(report.slides.length);
    expect((await h.objects.query(`${P}/placeholder`)).length).toBeGreaterThan(0);
  });
});

describe("[plugin-slide.object-model] schemas and panel field lists", () => {
  const byKind: Record<string, readonly { path: string; type: ValueType }[]> = {
    [`${P}/slide`]: SLIDE_SCHEMA,
    [`${P}/placeholder`]: PLACEHOLDER_SCHEMA,
    [`${P}/deck`]: DECK_SCHEMA,
    [`${P}/layout`]: LAYOUT_SCHEMA,
  };

  it("every panel field is a schema path of its kind", () => {
    for (const list of SLIDE_PANEL_FIELDS) {
      const paths = new Set(byKind[list.kind]!.map((r) => r.path));
      for (const f of list.fields) expect(paths.has(f), `${list.panel}: ${f}`).toBe(true);
    }
  });

  it("the registry serves the schema rows the manifest declares", async () => {
    const rows = await h.objects.schema(`${P}/slide`);
    expect(rows.map((r) => r.path)).toEqual(SLIDE_SCHEMA.map((r) => r.path));
  });
});
