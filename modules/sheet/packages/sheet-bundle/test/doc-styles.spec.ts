// Sheet ADR 524 — Excel named styles mapped to document styles, on the real
// engine and a real document: the placed table carries the mapped
// paragraph style, switching off removes it, "Create document styles from
// workbook" makes the styles and maps them, and a new workbook takes the
// document's styles from the start.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { createWorkbookSession, type WorkbookSession } from "../src";
import {
  defaultDocStyleEntries,
  missingDocReferences,
} from "../src/doc-styles";

import {
  ENGINE_BUILT,
  WASM,
  authorWorkbook,
  blankPageIdml,
  exportedIdmlParts,
  openHost,
  settle,
  sheetHost,
  withSceneChannel,
} from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("document styles (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

/** `row:col` → the paragraph style each table cell's text sits in. */
async function cellParagraphStyles(
  h: HeadlessHost,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [name, xml] of await exportedIdmlParts(h)) {
    if (!name.startsWith("Stories/")) continue;
    for (const c of xml.matchAll(
      /<Cell\b[^>]*\bName="(\d+):(\d+)"[^>]*>([\s\S]*?)<\/Cell>/g,
    )) {
      const p =
        /<ParagraphStyleRange\b[^>]*AppliedParagraphStyle="([^"]*)"/.exec(c[3]);
      out.set(`${c[2]}:${c[1]}`, p?.[1] ?? "");
    }
  }
  return out;
}

describe("document styles — pure helpers [sheet.format.doc-style-map]", () => {
  const lists = {
    paragraph: [
      {
        id: "ParagraphStyle/$ID/NormalParagraphStyle",
        name: "[Basic Paragraph]",
      },
      { id: "ParagraphStyle/H1", name: "heading 1" },
    ],
    character: [],
    cell: [],
    swatches: ["Color/Black"],
  };
  const usage = [
    { name: "Normal", cells: 3, bold: false, italic: false },
    { name: "Heading 1", cells: 1, bold: true, italic: false },
    { name: "Good", cells: 1, bold: false, italic: false },
  ];

  it("pre-fills by name and maps Normal to the basic paragraph style", () => {
    expect(
      defaultDocStyleEntries(usage, lists, { enabled: false, entries: {} }),
    ).toEqual({
      Normal: { para: "ParagraphStyle/$ID/NormalParagraphStyle" },
      "Heading 1": { para: "ParagraphStyle/H1" },
    });
    // An existing entry is kept.
    expect(
      defaultDocStyleEntries(usage, lists, {
        enabled: true,
        entries: { "heading 1": { para: "ParagraphStyle/Mine" } },
      })["Heading 1"],
    ).toBeUndefined();
  });

  it("reports what the document lacks", () => {
    expect(
      missingDocReferences(
        {
          paraStyles: { "ParagraphStyle/H1": 0, "ParagraphStyle/Gone": 2 },
          charStyles: {},
          cellStyles: { "CellStyle/X": 0 },
          swatches: { "Color/Black": 1, "Color/Old": 1 },
        },
        lists,
      ),
    ).toEqual([
      { kind: "paragraph", id: "ParagraphStyle/Gone", cells: 2 },
      { kind: "cell", id: "CellStyle/X", cells: 0 },
      { kind: "swatch", id: "Color/Old", cells: 1 },
    ]);
  });
});

describe.skipIf(!ENGINE_BUILT)(
  "document styles in the placed table [sheet.format.doc-style-map]",
  () => {
    setDefaultTimeout(60_000);
    let h: HeadlessHost;
    let host: BundleHost;
    let s: WorkbookSession | null = null;

    beforeEach(async () => {
      h = await openHost();
      await h.load(blankPageIdml());
      host = withSceneChannel(sheetHost(h)).host;
    });
    afterEach(() => {
      s?.dispose();
      s = null;
      h?.dispose();
    });

    async function workbook(): Promise<WorkbookSession> {
      const session = createWorkbookSession(host);
      s = session;
      await session.import(
        await authorWorkbook(3, 2, (r, c) => `r${r}c${c}`),
        "w.xlsx",
      );
      session.setRange("A1:B1");
      expect(session.setStyle({ namedStyle: "Heading 1" }).ok).toBe(true);
      session.setRange("A1:B3");
      return session;
    }

    it("an imported workbook starts off; the switch maps by name and the table carries it", async () => {
      const made = await host.document.mutate({
        op: "createParagraphStyle",
        args: { selfId: "ParagraphStyle/Heading 1", name: "Heading 1" },
      });
      expect(made.applied).toBe(true);
      const session = await workbook();
      expect(session.docStyles()?.enabled).toBe(false);
      const usage = session.docStyles()!.usage;
      expect(usage.find((u) => u.name === "Heading 1")?.cells).toBe(2);

      expect((await session.setDocStylesEnabled(true)).ok).toBe(true);
      const info = session.docStyles()!;
      expect(info.enabled).toBe(true);
      expect(info.entries["Heading 1"]?.para).toBe("ParagraphStyle/Heading 1");

      expect(await session.lowerSelection()).not.toBeNull();
      await settle();
      const styles = await cellParagraphStyles(h);
      expect(styles.get("0:0")).toBe("ParagraphStyle/Heading 1");
      expect(styles.get("0:1")).toBe("ParagraphStyle/Heading 1");
      expect(styles.get("1:0")).not.toBe("ParagraphStyle/Heading 1");

      // Off: the placed table loses the mapped style.
      expect((await session.setDocStylesEnabled(false)).ok).toBe(true);
      await session.refreshPlacements();
      await settle();
      expect((await cellParagraphStyles(h)).get("0:0")).not.toBe(
        "ParagraphStyle/Heading 1",
      );
      // The table is kept and one undo turns it back on.
      expect(session.docStyles()?.entries["Heading 1"]).toBeDefined();
      expect(session.undoCellEdit()).toBe(true);
      expect(session.docStyles()?.enabled).toBe(true);
    });

    it("create document styles from workbook makes the styles and maps them", async () => {
      const session = await workbook();
      const r = await session.createDocStylesFromWorkbook();
      expect(r.ok).toBe(true);
      expect(r.ok && r.created).toBeGreaterThanOrEqual(1);
      const info = session.docStyles()!;
      expect(info.enabled).toBe(true);
      const id = info.entries["Heading 1"]?.para;
      expect(id).toBeDefined();
      const rows = await host.document.collection<{
        selfId: string;
        name: string;
      }>("paragraphStyles");
      expect(rows.some((p) => p.selfId === id && p.name === "Heading 1")).toBe(
        true,
      );
      const props = await host.document.styleProperties("paragraph", id!);
      const size = props?.entries.find((e) => e.path === "characterFontSize");
      expect(JSON.stringify(size?.value)).toContain("15");
      // Running it again creates nothing new.
      const again = await session.createDocStylesFromWorkbook();
      expect(again.ok && again.created).toBe(0);

      expect(await session.lowerSelection()).not.toBeNull();
      await settle();
      expect((await cellParagraphStyles(h)).get("0:0")).toBe(id);
    });

    it("a mapped style the document lacks is reported and remapped", async () => {
      const session = await workbook();
      expect(
        session.setDocStyleMapping("Heading 1", { para: "ParagraphStyle/Gone" })
          .ok,
      ).toBe(true);
      expect((await session.setDocStylesEnabled(true)).ok).toBe(true);
      const read = await session.documentStyleLists();
      expect(read?.missing.map((m) => m.id)).toContain("ParagraphStyle/Gone");
      const basic = read!.lists.paragraph[0].id;
      expect(
        (await session.remapDocReference("ParagraphStyle/Gone", basic)).ok,
      ).toBe(true);
      expect(session.docStyles()?.entries["Heading 1"]?.para).toBe(basic);
      expect((await session.documentStyleLists())?.missing).toEqual([]);
    });

    it("a new workbook uses the document's styles", async () => {
      const session = createWorkbookSession(host);
      s = session;
      await session.newWorkbook();
      const info = session.docStyles();
      expect(info?.enabled).toBe(true);
      expect(info?.entries.Normal?.para).toMatch(/^ParagraphStyle\//);
    });
  },
);
