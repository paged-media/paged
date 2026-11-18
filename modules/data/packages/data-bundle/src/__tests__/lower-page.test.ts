// Lowered content lands where its frame is, whatever page is active (data ADR
// 551, amendment of 2026-11-18). A `lowerAll` pass re-lowers every binding:
// each barcode is drawn on its bound frame's own page, and a table whose frame
// a re-lower replaces keeps that frame's page. Before, both read the ACTIVE
// page: a pass run from page 1 drew page 2's symbol at its frame's coordinates
// on page 1 (the showcase's catalog chapter found one on the cover).

import { describe, expect, it, mock } from "bun:test";
import { importActual } from "@paged-media/test-kit";
import { storeDouble } from "./store-double";

import type { BundleHost, Mutation } from "@paged-media/plugin-api";

import { BINDING_KEY, makeEnvelope } from "../../../data-host-model/src";
import type { DataEngineLike } from "../engine";

import { silentConsole as silent } from "@paged-media/plugin-sdk";
// bun:test hoists no vi.mock: the real exports are taken once, before anything
// is mocked, and mock.module patches the loaded module in place.
const actualEngine = await importActual(() => import("../engine"));
const actualStore = await importActual(() => import("../query/store"));

/** The document's frames: the page each sits on and its page-local bounds
 *  (`[top, left, bottom, right]`, identity transform). */
const FRAMES: Record<string, { pageId: string; bounds: number[] }> = {
  "rect-p2": { pageId: "p2", bounds: [200, 60, 260, 200] },
  "rect-p3": { pageId: "p3", bounds: [400, 300, 496, 396] },
  "table-p2": { pageId: "p2", bounds: [120, 48, 300, 400] },
};

function fakeHost(tree: unknown[] = []) {
  const batches: Mutation[][] = [];
  const host = {
    manifest: { id: "media.paged.data", version: "0.0.1" },
    log: silent,
    supports: () => true,
    selection: { get: () => [], set: async () => [] },
    network: {
      consentedOrigins: () => [],
      requestConsent: async () => ({ granted: [], denied: [] }),
    },
    document: {
      onWillSave: () => ({ dispose() {} }),
      onDidChange: () => ({ dispose() {} }),
      mutate: async (m: Mutation) => {
        const ops =
          m.op === "batch" ? (m.args as { ops: Mutation[] }).ops : [m];
        batches.push(ops);
        const minted = ops
          .filter((o) => o.op === "insertTextFrame")
          .map(() => ({
            handle: "frame",
            element: { kind: "textFrame", id: "t-new" },
            storyId: "Story/new",
          }));
        return { applied: true, pageIds: [], minted };
      },
      elementGeometry: async (ids: { kind: string; id: string }[]) =>
        ids.flatMap((i) =>
          FRAMES[i.id]
            ? [{ id: i, itemTransform: [1, 0, 0, 1, 0, 0], ...FRAMES[i.id] }]
            : [],
        ),
      tree: async () => tree,
      placeholders: async () => [],
      frameChain: async () => [],
      hitTest: async () => null,
      // The user is on page 1 throughout.
      meta: async () => ({ activePage: "p1" }),
      collection: async () => [
        { selfId: "p1" },
        { selfId: "p2" },
        { selfId: "p3" },
      ],
    },
  } as unknown as BundleHost;
  return { host, batches };
}

function fakeEngine(over?: Partial<DataEngineLike>): DataEngineLike {
  return {
    define_source() {},
    define_query() {},
    define_binding() {},
    define_placeholder() {},
    set_param() {},
    set_locale() {},
    ingest_result() {},
    resolve_lowered: () => null,
    publish_provider: () => ({}),
    governed_catalog: () => ({}),
    plan_batch: () => ({}),
    run_record_flow_batch: () => [],
    evaluate_rule: () => ({
      scope: "x",
      fires: [],
      apply: { action: "tableStyle", name: "s" },
      total: 0,
    }),
    lower_record_flow: () => ({
      frames: [],
      overflow: false,
      placed: 0,
      total: 0,
    }),
    sync_state: () => ({}),
    pin() {},
    mark_overridden() {},
    relink() {},
    sync_report: () => ({}),
    source_manifest: () => ({}),
    authorize_report: () => ({}),
    payload: () => ({}),
    metadata: () => ({}),
    free() {},
    ...over,
  } as DataEngineLike;
}

async function sessionWith(host: BundleHost, engine: DataEngineLike) {
  mock.module("../engine", () => ({
    ...actualEngine,
    bootEngine: async () => engine,
  }));
  mock.module("../query/store", () => ({
    ...actualStore,
    storeHandle: (e: DataEngineLike) => storeDouble(e),
  }));
  const { createSession: make } = await import("../session");
  return make(host, 20613);
}

const symbol = (target: string) => ({
  target,
  symbology: "code128",
  modules: [
    { xPt: 0, yPt: 0, wPt: 2, hPt: 40 },
    { xPt: 6, yPt: 0, wPt: 2, hPt: 40 },
  ],
  text: "",
});

type PathArgs = { pageId: string; anchors: { anchor: [number, number] }[] };

/** Every `insertPath` the pass sent, with the binding batch it rode in. */
const pathsOf = (batches: Mutation[][]) =>
  batches.flatMap((ops, batch) =>
    ops
      .filter((o) => o.op === "insertPath")
      .map((o) => ({ batch, ...(o.args as unknown as PathArgs) })),
  );

const inside = (p: PathArgs, frame: number[]) =>
  p.anchors.every(
    ({ anchor: [x, y] }) =>
      x >= frame[1]! && x <= frame[3]! && y >= frame[0]! && y <= frame[2]!,
  );

describe("lowerAll lands every binding on its frame's page [data.barcode.symbology]", () => {
  it("draws a barcode bound on page 2 inside its frame on page 2 while page 1 is active", async () => {
    const fake = fakeHost();
    const s = await sessionWith(
      fake.host,
      fakeEngine({
        lower_barcode: (id: string) =>
          symbol(id === "bc2" ? "rect-p2" : "rect-p3"),
      } as Partial<DataEngineLike>),
    );
    s.addBarcodeBinding("bc2", "rect-p2", "q_all", "code128", "sku", {
      missing: "skip",
    });
    s.addBarcodeBinding("bc3", "rect-p3", "q_all", "code128", "sku", {
      missing: "skip",
    });
    await s.lowerAll();

    const paths = pathsOf(fake.batches);
    expect(paths.length).toBe(4);
    const [first, second] = [...new Set(paths.map((p) => p.batch))];
    const ofBatch = (b: number | undefined) =>
      paths.filter((p) => p.batch === b);
    expect(ofBatch(first).map((p) => p.pageId)).toEqual(["p2", "p2"]);
    expect(ofBatch(second).map((p) => p.pageId)).toEqual(["p3", "p3"]);
    for (const p of ofBatch(first))
      expect(inside(p, FRAMES["rect-p2"]!.bounds)).toBe(true);
    for (const p of ofBatch(second))
      expect(inside(p, FRAMES["rect-p3"]!.bounds)).toBe(true);
  });

  it("re-lowers a table whose frame it cannot address in place onto that frame's page and corner", async () => {
    // The table this binding lowered before a reload: a labelled frame on
    // page 2. The session no longer knows its table id, so the frame goes and
    // a fresh one takes its place — on page 2, where it stood.
    const tree = [
      {
        kind: "Spread",
        children: [{ kind: "Page", children: [] }],
      },
      {
        kind: "Spread",
        children: [
          {
            kind: "Page",
            children: [
              {
                kind: "TextFrame",
                id: { kind: "textFrame", id: "table-p2" },
                pluginMetadata: [
                  {
                    key: BINDING_KEY,
                    value: makeEnvelope({ kind: "table", binding: "t1" }),
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const fake = fakeHost(tree);
    const s = await sessionWith(
      fake.host,
      fakeEngine({
        resolve_lowered: () => ({
          kind: "table",
          region: "region",
          columns: [{ index: 0, header: "SKU", xPt: 0, widthPt: 50 }],
          rows: [{ cells: ["SKU"], yPt: 0, heightPt: 12, header: true }],
          rules: [],
          text: "SKU",
          bounds: { widthPt: 50, heightPt: 12 },
        }),
      }),
    );
    s.addTableBinding("t1", "region", "q_all", [
      { header: "SKU", expr: "sku" },
    ]);
    await s.lowerAll();

    const ops = fake.batches.find((b) =>
      b.some((o) => o.op === "insertTextFrame"),
    )!;
    expect(ops).toContainEqual({
      op: "deleteFrame",
      args: { frameId: "table-p2", withStory: true },
    });
    expect(ops.find((o) => o.op === "insertTextFrame")!.args).toEqual({
      pageId: "p2",
      bounds: [120, 48, 132, 98],
    });
  });
});
