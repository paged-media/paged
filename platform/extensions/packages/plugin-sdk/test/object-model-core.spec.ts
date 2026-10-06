/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @feat: plugin-platform.object-model
//
// ADR 323 — the CORE seam (core-objects.ts) on the real engine: the virtual
// paths that map onto dedicated v69 ops (story content, swatch colour,
// styles, page reads), the schema table's totality against the vendored
// catalog, and the harness hosting SEVERAL bundles that meet through the
// shared registries (objects, data providers).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CORE_PATH_ALIASES, CORE_PATHS } from "../src/core-schema";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { minimalIdml } from "./fixtures/minimal-idml";
import { makeNotesBundle, NOTES_ID } from "./fixtures/notes-bundle";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const value = (v: unknown) => ({ kind: "value", value: v });

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("core seam — virtual paths over today's ops", () => {
  it("story content: set replaces the text in one undo step; ranges read a slice", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    const out = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertTextFrame", args: { pageId: pageId!, bounds: [10, 10, 100, 200] } },
          { op: "bindCreated", args: { handle: "t" } },
          { op: "insertText", args: { storyId: "$h:t", offset: 0, text: "hello" } },
        ],
      },
    });
    const storyId = out.applied ? out.minted?.[0]?.storyId : null;
    expect(storyId).toBeTruthy();
    const [story] = await h.objects.query("story");
    expect(story).toBe(`story:${storyId!}`);
    expect(await h.objects.get(story!, "content")).toEqual(value("hello"));
    expect(await h.objects.get(story!, "characterCount")).toEqual(value(5));

    expect(await h.objects.set(story!, "content", "Price: 12 €")).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(story!, "content")).toEqual(value("Price: 12 €"));
    expect(await h.objects.get(`storyRange:${storyId!}@0..5`, "content")).toEqual(value("Price"));

    expect(await h.objects.set(`storyRange:${storyId!}@0..5`, "characterFontSize", 18)).toMatchObject({ applied: true });
    expect(await h.objects.get(`storyRange:${storyId!}@0..5`, "characterFontSize")).toEqual(value(18));

    await h.host.document.undo();
    await h.host.document.undo();
    expect(await h.objects.get(story!, "content")).toEqual(value("hello"));
  });

  it("swatch colour (editSwatch), page reads, doc reads", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    expect(await h.objects.get("swatch:Black", "name")).toEqual(value("Black"));
    const before = await h.objects.get("swatch:Color/Black", "value");
    expect(before).toEqual(value([0, 0, 0, 100]));
    expect(await h.objects.set("swatch:Color/Black", "value", [0, 0, 0, 90])).toMatchObject({ applied: true });
    expect(await h.objects.get("swatch:Color/Black", "value")).toEqual(value([0, 0, 0, 90]));
    expect(await h.objects.set("swatch:Color/Black", "space", "Pantone")).toMatchObject({ code: "invalidValue" });

    expect(await h.objects.get("page:#1", "pageBounds")).toEqual(value([0, 0, 792, 612]));
    expect(await h.objects.get("page:#1", "index")).toEqual(value(1));
    expect(await h.objects.get("page:#9", "index")).toMatchObject({ kind: "refused", code: "unknownAddress" });
    // Protocol 71 addresses a cell without its story; core answers.
    expect(await h.objects.get("cell:t1/0,0", "cellFillColor")).toMatchObject({ kind: "refused", code: "unknownAddress" });
  });

  it("paragraph style properties through setStyleProperty", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const [style] = await h.objects.query("style:paragraph");
    expect(style).toMatch(/^style:paragraph\//);
    expect(await h.objects.set(style!, "characterFontSize", 14)).toMatchObject({ applied: true });
    expect(await h.objects.get(style!, "characterFontSize")).toEqual(value(14));
  });
});

describe("the seam schema table is total", () => {
  it("every settable path the vendored catalog advertises is classified", () => {
    const catalog = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../plugin-api/src/catalog.json", import.meta.url)), "utf8"),
    ) as { settablePaths: string[]; pathAliases: { name: string; wire: string }[] };
    const aliases = new Map(catalog.pathAliases.map((a) => [a.name, a.wire]));
    const missing = catalog.settablePaths.filter((p) => !((aliases.get(p) ?? p) in CORE_PATHS));
    expect(Object.fromEntries(aliases)).toEqual(CORE_PATH_ALIASES);
    expect(missing).toEqual([]);
  });
});

describe("headless host — several bundles meet through the shared registries", () => {
  it("a second bundle reads and writes the first bundle's objects via host.objects", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    const made = await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [0, 0, 50, 50] } });
    const rect = made.applied ? `${made.createdId!.kind}:${made.createdId!.id}` : "";
    h.loadBundle(makeNotesBundle());
    await h.objects.invoke("acme.notes.attach", { frame: rect, count: 1 });

    let reader: import("@paged-media/plugin-api").BundleHost | null = null;
    h.loadBundle({
      manifest: {
        id: "acme.reader",
        name: "reader",
        version: "0.0.0",
        apiVersion: "^0.2.0",
        capabilities: { document: { read: "broad", write: "broad" }, dataProviders: { publish: ["rows"] } },
      },
      activate(host) {
        reader = host;
        return { dispose() {} };
      },
    });
    const note = `plugin:${NOTES_ID}/note/n1`;
    expect(await reader!.objects.get(note, "text")).toEqual(value("hello"));
    expect(await reader!.objects.set(note, "text", "from reader")).toMatchObject({ applied: true });
    expect(await h.objects.get(note, "text")).toEqual(value("from reader"));
    expect(reader!.supports("objects.shared@1")).toBe(true);
    // D-09 — the harness now injects the shared data-provider registry.
    expect(reader!.supports("dataProviders@1")).toBe(true);
    reader!.dataProviders.register({
      id: "acme.reader.rows",
      category: "rows",
      schema: { fields: [{ name: "a", ty: "utf8" }] },
      revision: "1",
      getSnapshot: () => ({ schema: { fields: [{ name: "a", ty: "utf8" }] }, columns: [["x"]], rowCount: 1 }),
    });
    expect(h.dataProviders.discover("rows").map((p) => p.id)).toEqual(["acme.reader.rows"]);
  });
});
