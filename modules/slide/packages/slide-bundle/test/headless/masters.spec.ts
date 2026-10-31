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

// Slide masters and layouts on the real engine (slide ADR 712, engine ADR
// 1026): the importer's two-level masters, the Slide Master view's verbs
// (rename, preserve, insert and delete placeholders, delete an unused
// layout), a placeholder's text style that the slides follow, Change
// Layout and Reset Slide, and the layouts written back on export.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { BundleHost, ExporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { slideEngine } from "../../src/engine";
import {
  deleteLayoutMutation,
  insertPlaceholderMutation,
  placeholderStyleMutation,
  preserveMutation,
  readMasters,
  renameMutation,
  slidePlaceholders,
} from "../../src/masters-model";
import { changeLayout, resetSlide } from "../../src/masters-commands";
import { slideAddress } from "../../src/object-model";

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

async function mutate(host: BundleHost, m: unknown) {
  const out = await host.document.mutate(m as never);
  expect(out.applied, JSON.stringify(out)).toBe(true);
  return out;
}

const pageIds = async (host: BundleHost) =>
  (await host.document.collection<{ selfId: string }>("pages")).map(
    (p) => p.selfId,
  );

describe("slide masters and layouts", () => {
  it("imports each slide master and every layout based on it", async () => {
    const { host, report } = await open(
      fixture("placeholders"),
      "placeholders",
    );
    const masters = await readMasters(host);
    const tops = masters.filter((m) => m.kind === "master");
    const layouts = masters.filter((m) => m.kind === "layout");
    expect(tops.length).toBeGreaterThan(0);
    expect(layouts.length).toBeGreaterThan(1);
    for (const l of layouts) {
      expect(tops.some((t) => t.masterId === l.basedOn)).toBe(true);
      expect(l.part).toMatch(/slideLayouts\/slideLayout\d+\.xml$/);
    }
    // Layouts no slide uses are there too.
    expect(layouts.some((l) => l.slides === 0)).toBe(true);
    expect(layouts.reduce((n, l) => n + l.slides, 0)).toBe(
      report.slides.length,
    );
    // A layout's placeholders are its items; the title layout has a title.
    expect(
      layouts.some((l) => l.placeholders.some((p) => p.type === "title")),
    ).toBe(true);
    // A master page draws as a page (the view's thumbnails).
    const shot = await host.render.snapshot(layouts[0]!.pageId, {
      widthPx: 64,
    });
    expect(shot?.png.length ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("renames, preserves, inserts and deletes placeholders, deletes an unused layout", async () => {
    const { host } = await open(fixture("placeholders"), "placeholders");
    let masters = await readMasters(host);
    const unused = masters.find((m) => m.kind === "layout" && m.slides === 0)!;
    await mutate(host, renameMutation(unused.masterId, "My layout"));
    await mutate(host, preserveMutation(unused, true));
    masters = await readMasters(host);
    let l = masters.find((m) => m.masterId === unused.masterId)!;
    expect(l.name).toBe("My layout");
    expect(l.preserve).toBe(true);

    const before = l.placeholders.length;
    await mutate(host, insertPlaceholderMutation(l, "pic"));
    l = (await readMasters(host)).find((m) => m.masterId === l.masterId)!;
    expect(l.placeholders.length).toBe(before + 1);
    expect(l.placeholders.some((p) => p.type === "pic")).toBe(true);

    const used = masters.find((m) => m.kind === "layout" && m.slides > 0)!;
    expect(typeof deleteLayoutMutation(used, masters)).toBe("string");
    const del = deleteLayoutMutation(l, masters);
    expect(typeof del).not.toBe("string");
    await mutate(host, del);
    expect(
      (await readMasters(host)).some((m) => m.masterId === l.masterId),
    ).toBe(false);
    await host.document.undo();
    expect(
      (await readMasters(host)).some((m) => m.masterId === l.masterId),
    ).toBe(true);
  }, 120_000);

  it("a layout's title style reaches the slides that keep it", async () => {
    const { host } = await open(fixture("placeholders"), "placeholders");
    const masters = await readMasters(host);
    const layout = masters.find(
      (m) =>
        m.kind === "layout" &&
        m.slides > 0 &&
        m.placeholders.some((p) => p.type === "title"),
    )!;
    const ph = layout.placeholders.find((p) => p.type === "title")!;
    const op = await placeholderStyleMutation(host, layout, ph, { size: 61 });
    expect(op).not.toBeNull();
    await mutate(host, op);
    // A slide of the layout: its title is 61 pt now.
    const pages = await host.document.collection<{
      selfId: string;
      appliedMaster?: string | null;
    }>("pages");
    const slide = pages.find((p) => p.appliedMaster === layout.masterId)!;
    const title = (await slidePlaceholders(host, slide.selfId)).find(
      (p) => p.type === "title",
    );
    expect(title, "the slide has a title placeholder").toBeDefined();
    const frame = title!.elements.find((e) => e.kind === "textFrame")!;
    const [g] = (await host.document.elementGeometry([frame] as never)) as {
      storyId?: string;
    }[];
    const content = await host.document.storyContent(g!.storyId!);
    const sizes = content!.paragraphs.flatMap((p) =>
      p.runs.map((r) => r.pointSize),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(
      sizes.every((s) => s === 61),
      JSON.stringify(sizes),
    ).toBe(true);
    // One step: undo puts the layout and the slide back.
    await host.document.undo();
    const again = await host.document.storyContent(g!.storyId!);
    expect(again!.paragraphs[0]!.runs[0]!.pointSize).not.toBe(61);
  }, 120_000);

  it("changes a slide's layout and resets it, each one step", async () => {
    const { host } = await open(fixture("placeholders"), "placeholders");
    const masters = await readMasters(host);
    const [first] = await pageIds(host);
    const target = masters.find(
      (m) =>
        m.kind === "layout" &&
        m.placeholders.some((p) => p.type === "title") &&
        m.slides === 0,
    )!;
    expect(await changeLayout(host, first!, target.masterId)).toBe(true);
    const page = (
      await host.document.collection<{
        selfId: string;
        appliedMaster?: string | null;
        overrideList?: string[];
      }>("pages")
    ).find((p) => p.selfId === first)!;
    expect(page.appliedMaster).toBe(target.masterId);
    expect(page.overrideList!.length).toBeGreaterThan(0);
    await resetSlide(host, first!);
    await host.document.undo();
    await host.document.undo();
    const back = (
      await host.document.collection<{
        selfId: string;
        appliedMaster?: string | null;
      }>("pages")
    ).find((p) => p.selfId === first)!;
    expect(back.appliedMaster).not.toBe(target.masterId);
  }, 120_000);

  it("writes a renamed layout and a placeholder's text style back", async () => {
    covers("exporter:media.paged.slide.exporter.pptx");
    const { host, exporter } = await open(
      fixture("placeholders"),
      "placeholders",
    );
    const masters = await readMasters(host);
    const layout = masters.find(
      (m) =>
        m.kind === "layout" &&
        m.slides > 0 &&
        m.placeholders.some((p) => p.type === "title"),
    )!;
    await mutate(host, renameMutation(layout.masterId, "Renamed layout"));
    const ph = layout.placeholders.find((p) => p.type === "title")!;
    await mutate(
      host,
      await placeholderStyleMutation(host, layout, ph, { size: 61 }),
    );
    const out = await exporter.export();
    expect(out).not.toBeNull();
    // The deck PowerPoint's open check reads (slide ADR 705), when asked.
    if (process.env.SLIDE_KEEP_DIR)
      writeFileSync(
        `${process.env.SLIDE_KEEP_DIR}/masters-title-style.pptx`,
        out!.bytes,
      );
    const back = await open(out!.bytes, "back");
    const again = await readMasters(back.host);
    const l = again.find((m) => m.name === "Renamed layout");
    expect(l, "the renamed layout comes back").toBeDefined();
    // Unedited layouts keep their names.
    expect(again.length).toBe(masters.length);
  }, 120_000);

  it("runs every master and layout verb as a typed command", async () => {
    const { h, host } = await open(fixture("placeholders"), "placeholders");
    const run = (id: string, args: object = {}) => h.objects.invoke(id, args);
    covers("command:media.paged.slide.layouts");
    const listed = (await run("media.paged.slide.layouts")) as {
      layouts: { layout: string; kind: string; slides: number; name: string }[];
    };
    expect(listed.layouts.some((l) => l.kind === "master")).toBe(true);
    const unused = listed.layouts.find(
      (l) => l.kind === "layout" && l.slides === 0,
    )!;
    const used = listed.layouts.find(
      (l) => l.kind === "layout" && l.slides > 0,
    )!;

    covers("command:media.paged.slide.renameLayout");
    expect(
      await run("media.paged.slide.renameLayout", {
        layout: unused.layout,
        name: "Typed",
      }),
    ).toEqual({ applied: true });
    covers("command:media.paged.slide.setPreserve");
    expect(
      await run("media.paged.slide.setPreserve", {
        layout: unused.layout,
        preserve: true,
      }),
    ).toEqual({ applied: true });
    covers("command:media.paged.slide.insertPlaceholder");
    expect(
      await run("media.paged.slide.insertPlaceholder", {
        layout: unused.layout,
        type: "body",
      }),
    ).toEqual({ applied: true });
    covers("command:media.paged.slide.setPlaceholderStyle");
    expect(
      await run("media.paged.slide.setPlaceholderStyle", {
        layout: unused.layout,
        type: "body",
        size: 30,
      }),
    ).toEqual({ applied: true });
    const [first] = await pageIds(host);
    covers("command:media.paged.slide.changeLayout");
    expect(
      await run("media.paged.slide.changeLayout", {
        slide: slideAddress(first!),
        layout: unused.layout,
      }),
    ).toEqual({ applied: true });
    covers("command:media.paged.slide.command.resetSlide");
    await run("media.paged.slide.command.resetSlide", {
      slide: slideAddress(first!),
    });
    await host.document.undo();
    await host.document.undo();
    covers("command:media.paged.slide.deleteLayout");
    expect(used.layout).not.toBe(unused.layout);
    expect(
      await run("media.paged.slide.deleteLayout", { layout: unused.layout }),
    ).toEqual({ applied: true });
    covers("command:media.paged.slide.command.slideMaster");
    const shown = (await run("media.paged.slide.command.slideMaster")) as {
      presented: boolean;
    };
    expect(typeof shown.presented).toBe("boolean");
  }, 120_000);
});
