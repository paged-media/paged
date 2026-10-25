// Editor ADR 291's table and record drops and the first run's sample data,
// through the data door (`data@1`) against the REAL stack: real core
// (canvas-wasm in the headless host) and the real data-js engine. A query
// dropped on a text frame becomes a table in that frame's story (no new
// frame); a record dropped on a group fills every `<<field>>` of its text
// frames with that record's values, and a refresh keeps it at that record;
// a design without a `<<field>>` is refused; the sample loads a query.
//
// Gate: skips without canvas-wasm or the built data-js wasm, EXCEPT under
// REQUIRE_REAL_CORE=1 / REQUIRE_REAL_ENGINE=1.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { existsSync } from "node:fs";

import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  dataFields,
  ENGINE_ANCHOR,
  openRealHost,
  REQUIRE_REAL_CORE,
} from "./real-core";
import {
  bootRealEngine,
  DATA_JS_WASM,
  REQUIRE_REAL_ENGINE,
} from "./real-engine";

const actualEngine = await importActual(() => import("../src/engine"));

const ready = ENGINE_ANCHOR !== null && existsSync(DATA_JS_WASM);
const required = REQUIRE_REAL_CORE || REQUIRE_REAL_ENGINE;

const CSV = "sku,name,price\nA-1,Lamp,9.50\nB-2,Chair,12.00\nC-3,Shelf,4.25\n";

const CONSUMER: PluginManifest = {
  id: "com.example.panel",
  name: "a data panel",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { data: { read: true, write: true, bind: true } },
};

async function loadBundleModule() {
  mock.module("../src/engine", () => ({
    ...actualEngine,
    bootEngine: (today: number) => bootRealEngine(today),
  }));
  return import("../src/index");
}

type Minted = { minted?: { element: { kind: string; id: string } }[] };

/** A text frame holding `text`; its raw id. */
async function textFrame(
  host: BundleHost,
  bounds: [number, number, number, number],
  text: string,
): Promise<string> {
  const r = (await host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op: "insertTextFrame", args: { pageId: "usp", bounds } },
        { op: "bindCreated", args: { handle: "f" } },
        ...(text
          ? [
              {
                op: "insertText",
                args: { storyId: "$h:f", offset: 0, text },
              },
            ]
          : []),
      ],
    },
  } as never)) as Minted;
  return r.minted![0]!.element.id;
}

/** The text of a frame's story, runs joined. */
async function frameText(host: BundleHost, frame: string): Promise<string> {
  const g = (
    await host.document.elementGeometry([
      { kind: "textFrame", id: frame } as never,
    ])
  )[0] as { storyId?: string };
  const c = await host.document.storyContent(g.storyId!);
  return (c?.paragraphs ?? [])
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("\n");
}

describe.skipIf(!ready && !required)(
  "table and record drops, sample data, over the real stack [editor-shell.data-panel]",
  () => {
    const hosts: HeadlessHost[] = [];
    afterEach(() => {
      for (const h of hosts.splice(0)) h.dispose?.();
    });

    it("a table into a text frame, a record into a group, the sample data [data.lower.merge-writer]", async () => {
      expect(
        ready,
        "real core and the data-js wasm must both be available",
      ).toBe(true);
      const mod = await loadBundleModule();
      const h = await openRealHost();
      hosts.push(h);
      let dataHost!: BundleHost;
      h.loadBundle({
        ...mod.dataBundle,
        activate: (bh: BundleHost) => {
          dataHost = bh;
          return mod.dataBundle.activate(bh);
        },
      } as typeof mod.dataBundle);
      let consumer!: BundleHost;
      h.loadBundle({
        manifest: CONSUMER,
        activate(bh: BundleHost) {
          consumer = bh;
          return { dispose() {} };
        },
      } as never);
      const s = mod.sessionFor(dataHost)!;
      await s.whenRestored();
      await s.registerCsvSource("products", CSV);
      s.addQuery(
        "q",
        "SELECT sku, name, price FROM products ORDER BY sku",
        "recordStream",
      );
      await s.refreshData();
      const data = consumer.data;

      // A table: in the dropped-on frame's own story, no frame added.
      const countFrames = async () =>
        JSON.stringify(await dataHost.document.tree()).split('"textFrame"')
          .length;
      const tf = await textFrame(dataHost, [100, 100, 300, 400], "");
      const before = await countFrames();
      const t = await data.placeTable!(`textFrame:${tf}`, "q", [
        "sku",
        "price",
      ]);
      expect(t.kind).toBe("table");
      expect(await countFrames()).toBe(before);
      expect(
        (await data.placements!()).filter((p) => p.binding === t.binding),
      ).toEqual([
        {
          binding: t.binding,
          address: `textFrame:${tf}`,
          status: expect.any(String),
        },
      ]);
      // Updated, it stays in that frame (swapped in place).
      await data.refresh!();
      expect(await countFrames()).toBe(before);
      await expect(
        data.placeTable!(`textFrame:${tf}`, "q", ["nope"]),
      ).rejects.toThrow(/no field "nope"/);
      await expect(
        data.placeTable!("rectangle:urect", "q", ["sku"]),
      ).rejects.toThrow(/into a text frame/);

      // A record: the group's <<field>>s take record 1 (B-2, Chair).
      const a = await textFrame(dataHost, [320, 100, 360, 400], "SKU: <<sku>>");
      const b = await textFrame(
        dataHost,
        [370, 100, 410, 400],
        "<<name>> costs <<price>>",
      );
      const g = (await dataHost.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "createGroup",
              args: {
                memberIds: [
                  { kind: "textFrame", id: a },
                  { kind: "textFrame", id: b },
                ],
              },
            },
            { op: "bindCreated", args: { handle: "g" } },
          ],
        },
      } as never)) as Minted;
      const group = g.minted!.find((m) => m.element.kind === "group")!.element
        .id;
      const placed = await data.placeRecord!(`group:${group}`, "q", 1);
      expect(placed.map((p) => p.kind)).toEqual([
        "variable",
        "variable",
        "variable",
      ]);
      const valueOf = async () => {
        const fields = await dataFields(dataHost as never);
        return placed.map(
          (p) => fields.find((f) => f.key === p.binding)?.value,
        );
      };
      expect(await valueOf()).toEqual(["B-2", "Chair", "12.00"]);
      expect(await frameText(dataHost, a)).not.toContain("<<sku>>");
      expect(await frameText(dataHost, b)).toContain(" costs ");
      // The data changes: the fields follow record 1, not the first.
      await data.write!("products", [
        { op: "set", row: 1, field: "name", value: "Stool" },
      ]);
      await data.refresh!();
      expect(await valueOf()).toEqual(["B-2", "Stool", "12.00"]);

      // A frame with no <<field>> is refused, and defines nothing.
      const plain = await textFrame(
        dataHost,
        [420, 100, 460, 400],
        "no fields",
      );
      const bindings = s.listBindings().length;
      await expect(
        data.placeRecord!(`textFrame:${plain}`, "q", 0),
      ).rejects.toThrow(/no <<field>>/);
      expect(s.listBindings().length).toBe(bindings);

      // The first run's sample: a source and a query with its rows.
      const name = await data.loadSample!();
      const sample = (await data.tables()).find((x) => x.name === name);
      expect(sample).toMatchObject({ kind: "query" });
      expect(sample!.rowCount).toBeGreaterThan(0);
      expect(sample!.schema.fields.map((f) => f.name)).toEqual([
        "sku",
        "name",
        "category",
        "price",
      ]);
      // Loading it again changes nothing.
      expect(await data.loadSample!()).toBe(name);
    });
  },
);
