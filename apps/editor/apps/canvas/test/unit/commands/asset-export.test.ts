/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Editor ADR 288 — Asset Export, the model, the run and the commands over
// a scripted client: what each asset × setting asks the engine for (the
// snapshot door with `only` / `clip` / `trim` and a file format, the SVG
// export, the one-page PDF), the file names, the ZIP, and what is
// refused rather than mislabelled.

import { describe, expect, test } from "bun:test";

import { createEditorScope } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  ASSET_EXPORT_MENU_ITEMS,
  PAGED_ASSET_EXPORT_COLLECT,
  PAGED_ASSET_EXPORT_COLLECT_PAGES,
  PAGED_ASSET_EXPORT_COLLECT_SINGLE,
  PAGED_ASSET_EXPORT_EXPORT_ALL,
  PAGED_FILE_ASSET_EXPORT,
  buildAssetExportCommands,
  collectApplies,
} from "../../../src/asset-export/commands";
import {
  INITIAL_ASSET_EXPORT,
  addAssets,
  addSetting,
  assetExportStoreOf,
  defaultSuffix,
  fileStem,
  patchSetting,
  planFiles,
  removeSetting,
  type Asset,
  type AssetExportState,
} from "../../../src/asset-export/model";
import {
  artboardName,
  deliverAssets,
  exportAssets,
  pageDrafts,
} from "../../../src/asset-export/run";
import { problemsOf } from "../../../src/panels/problems-store";

const RECT = { kind: "rectangle", id: "u1" };
const OVAL = { kind: "oval", id: "u2" };
const OFF = { kind: "polygon", id: "u3" };

const PAGES = [
  { selfId: "p1", index: 1, name: "1", pluginMetadata: [] },
  {
    selfId: "p2",
    index: 2,
    name: "2",
    pluginMetadata: [
      {
        key: "x-paged:paged.artboard",
        value: JSON.stringify({ v: 1, data: { name: "Cover" } }),
      },
    ],
  },
];

type Call = [string, ...unknown[]];

function fakeClient(opts: { oldEngine?: boolean } = {}) {
  const calls: Call[] = [];
  const client = {
    async requestSnapshot(
      pageId: string,
      width: number,
      dpi: number,
      options: Record<string, unknown>,
    ) {
      calls.push(["snapshot", pageId, width, dpi, options]);
      const format = opts.oldEngine ? "png" : (options.format ?? "png");
      const file = new TextEncoder().encode(`${format}@${dpi}`);
      return {
        pageId,
        widthPx: 10,
        heightPx: 10,
        layoutGeneration: 1,
        numberingGeneration: 1,
        pngBytes: format === "png" ? [...file] : [],
        ...(format === "png" ? {} : { format, bytes: [...file] }),
      };
    },
    async exportSvg(pageId: string, ids: unknown[]) {
      calls.push(["svg", pageId, ids]);
      return {
        svg: "<svg/>",
        report: { items: 1, notes: [{ message: "x", count: 1 }] },
      };
    },
    async exportPdf(options: unknown) {
      calls.push(["pdf", options]);
      return { bytes: new TextEncoder().encode("%PDF"), diagnostics: [] };
    },
    async elementGeometry(ids: Array<{ id: string }>) {
      return ids.map((id) => ({
        id,
        pageId: id.id === OFF.id ? null : "p1",
        bounds: [10, 20, 110, 220],
        itemTransform: [1, 0, 0, 1, 5, 0],
      }));
    },
    async sceneTree() {
      return [
        {
          id: null,
          kind: "spread",
          label: "Spread",
          children: [
            { id: RECT, kind: "Rectangle", label: "Logo", children: [] },
          ],
        },
      ];
    },
    async collection(name: string) {
      calls.push(["collection", name]);
      return PAGES;
    },
  };
  return { client, calls };
}

const asset = (over: Partial<Asset>): Asset => ({
  id: "a1",
  kind: "object",
  name: "Logo",
  pageId: "p1",
  elementIds: [RECT as never],
  ...over,
});

const state = (over: Partial<AssetExportState> = {}): AssetExportState => ({
  ...INITIAL_ASSET_EXPORT,
  ...over,
});

describe("Asset Export model [editor-shell.panels.asset-export]", () => {
  test("a scale suggests its suffix; a changed scale moves a default suffix only", () => {
    expect(defaultSuffix(1)).toBe("");
    expect(defaultSuffix(2)).toBe("@2x");
    expect(defaultSuffix(0.5)).toBe("@0.5x");
    let s = addSetting(state());
    expect(s.settings.map((x) => [x.scale, x.suffix])).toEqual([
      [1, ""],
      [1.5, "@1.5x"],
    ]);
    const id = s.settings[1]!.id;
    s = patchSetting(s, id, { scale: 3 });
    expect(s.settings[1]!.suffix).toBe("@3x");
    s = patchSetting(s, id, { suffix: "-big" });
    s = patchSetting(s, id, { scale: 4 });
    expect(s.settings[1]!.suffix).toBe("-big");
    s = removeSetting(s, id);
    expect(removeSetting(s, s.settings[0]!.id).settings).toHaveLength(1);
  });

  test("file names: reserved characters go, clashes count up, vector rows ignore the scale", () => {
    expect(fileStem('a/b:c*"d')).toBe("a-b-c--d");
    expect(fileStem("  ..  ")).toBe("asset");
    const settings = [
      { id: "s1", scale: 1, suffix: "", format: "png" as const },
      { id: "s2", scale: 2, suffix: "@2x", format: "png" as const },
      { id: "s3", scale: 1, suffix: "", format: "svg" as const },
      { id: "s4", scale: 3, suffix: "", format: "svg" as const },
    ];
    const names = planFiles(
      [asset({}), asset({ id: "a2", elementIds: [OVAL as never] })],
      settings,
    ).map((f) => f.fileName);
    expect(names).toEqual([
      "Logo.png",
      "Logo@2x.png",
      "Logo.svg",
      "Logo 2.png",
      "Logo 2@2x.png",
      "Logo 2.svg",
    ]);
  });

  test("an asset is collected once", () => {
    const draft = {
      kind: "page" as const,
      name: "P",
      pageId: "p1",
      elementIds: [],
    };
    const first = addAssets(state(), [draft, draft]);
    expect(first.added).toHaveLength(1);
    expect(addAssets(first.state, [draft]).added).toEqual([]);
  });

  test("a page with an artboard name is an artboard", () => {
    expect(artboardName(PAGES[1]!)).toBe("Cover");
    expect(artboardName(PAGES[0]!)).toBe(null);
    const drafts = pageDrafts(PAGES, null, {
      page: (l) => `Page ${l}`,
      object: (n) => `Asset ${n}`,
    });
    expect(drafts.map((d) => [d.kind, d.name])).toEqual([
      ["page", "Page 1"],
      ["artboard", "Cover"],
    ]);
  });
});

describe("Asset Export run [editor-shell.panels.asset-export]", () => {
  test("an object asks for itself alone, clipped and trimmed, at 72 ppi × scale, encoded by the engine", async () => {
    const { client, calls } = fakeClient();
    const result = await exportAssets(
      { client: client as never, pageIds: ["p1", "p2"] },
      state({
        quality: 70,
        settings: [
          { id: "s1", scale: 2, suffix: "@2x", format: "jpeg" },
          { id: "s2", scale: 1, suffix: "", format: "webp" },
          { id: "s3", scale: 1, suffix: "", format: "tiff" },
        ],
      }),
      [asset({})],
    );
    expect(result.problems).toEqual([]);
    expect(result.files.map((f) => [f.fileName, f.mimeType])).toEqual([
      ["Logo@2x.jpg", "image/jpeg"],
      ["Logo.webp", "image/webp"],
      ["Logo.tif", "image/tiff"],
    ]);
    expect(new TextDecoder().decode(result.files[0]!.bytes)).toBe("jpeg@144");
    const [, page, width, dpi, options] = calls[0]!;
    expect([page, width, dpi]).toEqual(["p1", 0, 144]);
    expect(options).toEqual({
      format: "jpeg",
      quality: 70,
      only: [RECT],
      // The item's box through its transform, 72 pt around it.
      clip: { x: 25 - 72, y: 10 - 72, width: 200 + 144, height: 100 + 144 },
      background: "transparent",
      trim: true,
    });
    expect((calls[1]![4] as { quality?: number }).quality).toBe(undefined);
  });

  test("GIF, BMP, TGA and JPEG XL are engine encodings too (engine ADR 1038), each with its extension", async () => {
    const { client, calls } = fakeClient();
    const result = await exportAssets(
      { client: client as never, pageIds: ["p1"] },
      state({
        settings: [
          { id: "g", scale: 1, suffix: "", format: "gif" },
          { id: "b", scale: 1, suffix: "-b", format: "bmp" },
          { id: "t", scale: 1, suffix: "-t", format: "tga" },
          { id: "j", scale: 1, suffix: "-j", format: "jxl" },
        ],
      }),
      [asset({})],
    );
    expect(result.problems).toEqual([]);
    expect(result.files.map((f) => [f.fileName, f.mimeType])).toEqual([
      ["Logo.gif", "image/gif"],
      ["Logo-b.bmp", "image/bmp"],
      ["Logo-t.tga", "image/x-tga"],
      ["Logo-j.jxl", "image/jxl"],
    ]);
    expect(calls.map((c) => (c[4] as { format: string }).format)).toEqual([
      "gif",
      "bmp",
      "tga",
      "jxl",
    ]);
  });

  test("a page is drawn on paper unless asked for a transparent ground; PNG reads pngBytes", async () => {
    const { client, calls } = fakeClient();
    const page = asset({ kind: "page", name: "Page 1", elementIds: [] });
    const paper = await exportAssets(
      { client: client as never, pageIds: ["p1"] },
      state(),
      [page],
    );
    expect(new TextDecoder().decode(paper.files[0]!.bytes)).toBe("png@72");
    expect(calls[0]![4]).toEqual({ format: "png", background: "paper" });
    await exportAssets(
      { client: client as never, pageIds: ["p1"] },
      state({ transparentPages: true }),
      [page],
    );
    expect(calls[1]![4]).toEqual({ format: "png", background: "transparent" });
  });

  test("SVG is the engine's paged-svg export; PDF is the page's own; an object's PDF is refused", async () => {
    const { client, calls } = fakeClient();
    const result = await exportAssets(
      { client: client as never, pageIds: ["p1", "p2"] },
      state({
        settings: [
          { id: "s1", scale: 1, suffix: "", format: "svg" },
          { id: "s2", scale: 1, suffix: "", format: "pdf" },
        ],
      }),
      [
        asset({}),
        asset({
          id: "a2",
          kind: "artboard",
          name: "Cover",
          pageId: "p2",
          elementIds: [],
        }),
      ],
    );
    expect(calls).toEqual([
      ["svg", "p1", [RECT]],
      ["svg", "p2", []],
      ["pdf", { pageFrom: 1, pageTo: 1, title: "Cover" }],
    ]);
    expect(result.files.map((f) => f.fileName)).toEqual([
      "Logo.svg",
      "Cover.svg",
      "Cover.pdf",
    ]);
    expect(result.problems).toEqual([
      { fileName: "Logo.pdf", reason: "pdfObject" },
    ]);
    expect(result.svgNotes).toBe(2);
  });

  test("an engine that answers a PNG for a JPEG is refused, never mislabelled", async () => {
    const { client } = fakeClient({ oldEngine: true });
    const result = await exportAssets(
      { client: client as never, pageIds: ["p1"] },
      state({ settings: [{ id: "s1", scale: 1, suffix: "", format: "jpeg" }] }),
      [asset({})],
    );
    expect(result.files).toEqual([]);
    expect(result.problems).toEqual([
      { fileName: "Logo.jpg", reason: "unsupported" },
    ]);
  });

  test("several files go out as one ZIP through the shared writer, else one download each", () => {
    const files = [
      {
        fileName: "a.png",
        bytes: new Uint8Array([1, 2]),
        mimeType: "image/png",
      },
      {
        fileName: "b.svg",
        bytes: new TextEncoder().encode("<svg/>"),
        mimeType: "image/svg+xml",
      },
    ];
    const saved: Array<[string, string, Uint8Array]> = [];
    const save = (b: Uint8Array, n: string, m: string) => saved.push([n, m, b]);
    expect(
      deliverAssets(files, { zipped: true, archiveName: "x-assets.zip" }, save),
    ).toBe(1);
    expect(saved[0]![0]).toBe("x-assets.zip");
    expect(saved[0]![1]).toBe("application/zip");
    const zipBytes = saved[0]![2];
    expect([...zipBytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(zipBytes)).toContain("b.svg");
    saved.length = 0;
    expect(
      deliverAssets(files, { zipped: false, archiveName: "x.zip" }, save),
    ).toBe(2);
    expect(saved.map(([n, m]) => [n, m])).toEqual([
      ["a.png", "image/png"],
      ["b.svg", "image/svg+xml"],
    ]);
  });
});

function editor(selection: unknown[]) {
  const { client, calls } = fakeClient();
  const scope = createEditorScope();
  const opened: string[] = [];
  return {
    calls,
    scope,
    opened,
    paged: {
      scope,
      client,
      document: {
        handle: { pageCount: 2, pageIds: ["p1", "p2"], pageSizesPt: [] },
        sourceName: "Poster.idml",
      },
      selection: { elementSelection: selection },
    },
  };
}

describe("Asset Export commands [editor-shell.panels.asset-export]", () => {
  const saved: Array<[string, string]> = [];
  const commands = buildAssetExportCommands({
    save: (_b, name, mime) => saved.push([name, mime]),
  });
  const run = (id: string, paged: unknown) =>
    commands.find((c) => c.id === id)!.handler(paged as never, undefined);

  test("Collect for Export: one asset per item, named from the layers; a pasteboard item is reported", async () => {
    covers("command:paged.assetExport.collectMultiple");
    const h = editor([RECT, OVAL, OFF]);
    await run(PAGED_ASSET_EXPORT_COLLECT, h.paged);
    const s = assetExportStoreOf(h.scope).get();
    expect(s.assets.map((a) => [a.kind, a.name, a.elementIds])).toEqual([
      ["object", "Logo", [RECT]],
      ["object", "Asset 2", [OVAL]],
    ]);
    expect(s.selected).toEqual(s.assets.map((a) => a.id));
    const lines = problemsOf(h.scope)
      .snapshot()
      .map((p) => `${p.severity}:${p.message}`);
    expect(lines).toEqual([
      "warning:1 item is on the pasteboard and belongs to no page: not collected.",
    ]);
  });

  test("Collect for Export as one asset: every item in one", async () => {
    covers("command:paged.assetExport.collectSingle");
    const h = editor([RECT, OVAL]);
    await run(PAGED_ASSET_EXPORT_COLLECT_SINGLE, h.paged);
    const s = assetExportStoreOf(h.scope).get();
    expect(s.assets.map((a) => [a.name, a.elementIds])).toEqual([
      ["Asset 1", [RECT, OVAL]],
    ]);
  });

  test("Collect all artboards and pages, then Export All writes one ZIP", async () => {
    covers("command:paged.assetExport.collectPages");
    covers("command:paged.assetExport.exportAll");
    const h = editor([]);
    await run(PAGED_ASSET_EXPORT_COLLECT_PAGES, h.paged);
    expect(
      assetExportStoreOf(h.scope)
        .get()
        .assets.map((a) => [a.kind, a.name]),
    ).toEqual([
      ["page", "Page 1"],
      ["artboard", "Cover"],
    ]);
    saved.length = 0;
    await run(PAGED_ASSET_EXPORT_EXPORT_ALL, h.paged);
    expect(saved).toEqual([["Poster-assets.zip", "application/zip"]]);
    expect(
      problemsOf(h.scope)
        .snapshot()
        .map((p) => p.message),
    ).toEqual(["Exported 2 files as one ZIP."]);
  });

  test("Asset Export… and the menu rows; Collect applies only to selected page items", () => {
    covers("command:paged.file.assetExport");
    expect(ASSET_EXPORT_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["File/Export/Asset Export…", PAGED_FILE_ASSET_EXPORT],
      [
        "Object/Collect for Export/As Multiple Assets",
        PAGED_ASSET_EXPORT_COLLECT,
      ],
      [
        "Object/Collect for Export/As Single Asset",
        PAGED_ASSET_EXPORT_COLLECT_SINGLE,
      ],
    ]);
    const doc = { document: { handle: { pageCount: 1 } } };
    expect(
      collectApplies({ ...doc, selection: { elementSelection: [RECT] } }),
    ).toBe(true);
    expect(
      collectApplies({ ...doc, selection: { elementSelection: [] } }),
    ).toBe(false);
    expect(collectApplies({ selection: { elementSelection: [RECT] } })).toBe(
      false,
    );
  });
});
