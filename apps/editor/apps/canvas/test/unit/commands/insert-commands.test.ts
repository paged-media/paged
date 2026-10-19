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

// `paged.insert.*` — the object-authoring verbs, through the registry and
// the real runners (wired as the canvas app wires them), over the recording
// fake: what each inserts, where (the page the camera is on, centred),
// the graphic default the shapes wear, the selection afterwards, ONE
// mutation per insert, and the refusals: no document, inside an edit
// context, the last page, the engine's own sentence.

import { afterEach, describe, expect, test } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/client";
import {
  createCommandRegistry,
  createImporterRegistry,
} from "@paged-media/shell";
import {
  covers,
  expectNoCommit,
  expectOneCommit,
  stubGlobal,
  unstubAllGlobals,
  type ShellFakeEditor,
} from "@paged-media/test-kit";

import {
  addPage,
  buildInsertCommands,
  deleteCurrentPage,
  insertEllipse,
  insertLine,
  insertRectangle,
  insertTable,
  insertTextFrame,
  placeImage,
  psdHeaderSize,
  type InsertReport,
} from "../../../src/insert-commands";
import { appliedWith, id, refused, scriptedFake, typedClient } from "./support";

type Report = ["error" | "info", string];

const LETTER: [number, number] = [612, 792];

interface InsertHarness {
  fake: ShellFakeEditor;
  invoke: (command: string) => Promise<unknown>;
  reports: Report[];
  paged: Record<string, unknown> & {
    contentSelection: { current: unknown };
    selected: () => readonly ElementId[];
  };
}

function inserts(
  opts: {
    pages?: number;
    /** Which page the viewport centre sits on (0-based). */
    onPage?: number;
    noDocument?: boolean;
    editContext?: { type: string } | null;
    caret?: { storyId: string; start: number; end: number } | null;
    selection?: ElementId[];
    mutate?: (m: Mutation) => ReturnType<typeof appliedWith> | undefined;
    collections?: (name: string, call: number) => unknown[] | undefined;
    geometry?: (id: ElementId) => unknown;
    reply?: (m: { kind: string; payload?: unknown }) => unknown;
  } = {},
): InsertHarness {
  const pages = opts.pages ?? 1;
  const calls = new Map<string, number>();
  const fake = scriptedFake(
    { mutate: opts.mutate as never },
    {
      selection: opts.selection,
      geometry: opts.geometry as never,
      reply(message) {
        const m = message as { kind: string; payload?: { name?: string } };
        const custom = opts.reply?.(m);
        if (custom) return custom as never;
        if (m.kind === "requestCollection" && opts.collections) {
          const name = String(m.payload?.name);
          const n = (calls.get(name) ?? 0) + 1;
          calls.set(name, n);
          const items = opts.collections(name, n);
          if (items)
            return { kind: "collectionReply", payload: { name, items } };
        }
        return undefined;
      },
    },
  );
  const client = typedClient((m) => fake.editor.client.send(m));
  const pageIds = Array.from({ length: pages }, (_, i) => `p${i + 1}`);
  const handle = opts.noDocument
    ? null
    : {
        docId: "d1",
        pageCount: pages,
        pageIds,
        pageSizesPt: pageIds.map(() => LETTER),
      };
  // Viewport 1000 × 800 at scale 1: centre (500, 400) in viewport space,
  // shifted down onto the requested page (pages stack with a 24 pt gap).
  const onPage = opts.onPage ?? 0;
  const camera = { scale: 1, tx: -0, ty: -(onPage * (792 + 24)) };
  const caretRef = { current: opts.caret ?? null };
  let selected: readonly ElementId[] = [...(opts.selection ?? [])];
  const paged = {
    client,
    document: { handle },
    camera: { camera, viewportSize: [1000, 800] },
    editContext: opts.editContext ?? null,
    registries: { importers: createImporterRegistry() },
    selection: {
      get elementSelection() {
        return selected;
      },
      setElementSelection(ids: readonly ElementId[]) {
        selected = [...ids];
      },
      setElementGeometry() {},
    },
    contentSelection: {
      contentSelectionRef: caretRef,
      contentSelection: caretRef.current,
      setContentSelection(value: unknown) {
        caretRef.current = value as never;
      },
    },
    overlaySignals: { setToolPreview() {} },
  };
  const reports: Report[] = [];
  const report: InsertReport = (s, m) => void reports.push([s, m]);
  const registry = createCommandRegistry(() => paged);
  for (const c of buildInsertCommands({
    textFrame: (p) => insertTextFrame(p, report),
    rectangle: (p) => insertRectangle(p, report),
    ellipse: (p) => insertEllipse(p, report),
    line: (p) => insertLine(p, report),
    table: (p) => insertTable(p, report),
    deletePage: (p) => deleteCurrentPage(p, report),
    placeImage: (p) => placeImage(p, report),
    newPage: (p) => addPage(p, report),
  }))
    registry.register(c);
  return {
    fake,
    invoke: async (command) => {
      const r = await registry.invoke(command);
      await fake.settle();
      return r;
    },
    reports,
    paged: Object.assign(paged, {
      contentSelection: Object.assign(paged.contentSelection, {
        current: caretRef,
      }),
      selected: () => selected,
    }) as never,
  };
}

/** The graphic default a palette shape wears (no fill, 1 pt black). */
const paint = (kind: string) => [
  {
    op: "setElementProperty",
    args: {
      elementId: { kind, id: "$created" },
      path: "frameStrokeColor",
      value: { type: "colorRef", value: "Color/Black" },
    },
  },
  {
    op: "setElementProperty",
    args: {
      elementId: { kind, id: "$created" },
      path: "frameStrokeWeight",
      value: { type: "length", value: 1 },
    },
  },
];

afterEach(() => unstubAllGlobals());

describe("the shape inserts land centred on the page in view, and are selected", () => {
  test("Insert text frame: 240 × 120 pt centred, one insertTextFrame", async () => {
    covers("command:paged.insert.textFrame");
    const h = inserts();
    const outcome = await h.invoke("paged.insert.textFrame");
    expect(h.fake.mutations()).toEqual([
      {
        op: "insertTextFrame",
        args: { pageId: "p1", bounds: [336, 186, 456, 426] },
      },
    ]);
    expectOneCommit(h.fake);
    expect(outcome).toEqual({
      applied: true,
      createdId: { kind: "textFrame", id: "fake-1" },
    });
    expect(h.paged.selected()).toEqual([{ kind: "textFrame", id: "fake-1" }]);
  });

  test("Insert rectangle / ellipse: 160 pt square centred, painted in the same batch", async () => {
    covers("command:paged.insert.rectangle", "command:paged.insert.ellipse");
    for (const [command, op, kind] of [
      ["paged.insert.rectangle", "insertFrame", "rectangle"],
      ["paged.insert.ellipse", "insertOval", "oval"],
    ] as const) {
      const h = inserts();
      await h.invoke(command);
      expect(h.fake.mutations()).toEqual([
        {
          op: "batch",
          args: {
            ops: [
              { op, args: { pageId: "p1", bounds: [316, 226, 476, 386] } },
              ...paint(kind),
            ],
          },
        },
      ]);
      expectOneCommit(h.fake);
      expect(h.paged.selected()).toEqual([{ kind, id: "fake-1" }]);
    }
  });

  test("Insert line: a 200 pt horizontal line through the page centre, stroked, never filled", async () => {
    covers("command:paged.insert.line");
    const h = inserts();
    await h.invoke("paged.insert.line");
    expect(h.fake.mutations()).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "insertLine",
              args: { pageId: "p1", start: [206, 396], end: [406, 396] },
            },
            ...paint("graphicLine"),
          ],
        },
      },
    ]);
    expectOneCommit(h.fake);
  });

  test("a document with defaults of its own: the engine paints, no paint ops are added", async () => {
    covers("command:paged.insert.rectangle");
    const h = inserts({
      reply: (m) =>
        m.kind === "requestDocumentMeta"
          ? {
              kind: "documentMetaReply",
              payload: {
                meta: {
                  pageCount: 1,
                  defaultFillColor: "Color/Paper",
                  defaultStrokeColor: null,
                  defaultStrokeWeight: null,
                },
              },
            }
          : undefined,
    });
    await h.invoke("paged.insert.rectangle");
    expect(h.fake.mutations()).toEqual([
      {
        op: "insertFrame",
        args: { pageId: "p1", bounds: [316, 226, 476, 386] },
      },
    ]);
  });

  test("the target is the page the camera is on", async () => {
    covers("command:paged.insert.textFrame");
    const h = inserts({ pages: 3, onPage: 1 });
    await h.invoke("paged.insert.textFrame");
    expect(
      (h.fake.mutations()[0] as { args: { pageId: string } }).args.pageId,
    ).toBe("p2");
  });

  test("the engine's refusal is reported in words, nothing is selected", async () => {
    covers("command:paged.insert.ellipse");
    const h = inserts({ mutate: () => refused("page is locked") });
    await h.invoke("paged.insert.ellipse");
    expect(h.reports).toEqual([
      ["error", "Insert ellipse refused: page is locked"],
    ]);
    expect(h.paged.selected()).toEqual([]);
  });
});

describe("Insert table", () => {
  test("with a caret: one insertTable at the caret's story, even columns over the hosting frame, caret into A1", async () => {
    covers("command:paged.insert.table");
    const table = {
      kind: "table",
      id: { story_id: "uS", table_id: "uTbl" },
    } as unknown as ElementId;
    const h = inserts({
      caret: { storyId: "uS", start: 3, end: 3 },
      mutate: (m) => (m.op === "insertTable" ? appliedWith(table) : undefined),
      reply: (m) =>
        m.kind === "requestFrameChain"
          ? {
              kind: "frameChainResult",
              payload: { links: [{ frameId: "uF" }] },
            }
          : undefined,
      geometry: (e) =>
        e.kind === "textFrame"
          ? {
              id: e,
              pageId: "p1",
              bounds: [0, 0, 100, 300],
              itemTransform: null,
            }
          : null,
    });
    await h.invoke("paged.insert.table");
    expect(h.fake.mutations()).toEqual([
      {
        op: "insertTable",
        args: {
          storyId: "uS",
          rows: 4,
          cols: 3,
          rowHeights: [20, 20, 20, 20],
          columnWidths: [100, 100, 100],
        },
      },
    ]);
    expectOneCommit(h.fake);
    expect(h.paged.contentSelection.current).toEqual({
      current: {
        storyId: "uS",
        start: 0,
        end: 0,
        affinity: false,
        cell: { tableId: "uTbl", row: 0, col: 0 },
      },
    });
  });

  test("without a caret: a text frame, then the table in the story it minted", async () => {
    covers("command:paged.insert.table");
    const h = inserts({
      collections: (name, call) =>
        name === "stories"
          ? call === 1
            ? []
            : [{ selfId: "uNew" }]
          : undefined,
    });
    await h.invoke("paged.insert.table");
    const third = 320 / 3;
    expect(h.fake.mutations()).toEqual([
      {
        op: "insertTextFrame",
        args: { pageId: "p1", bounds: [306, 146, 486, 466] },
      },
      {
        op: "insertTable",
        args: {
          storyId: "uNew",
          rows: 4,
          cols: 3,
          columnWidths: [third, third, third],
          rowHeights: [20, 20, 20, 20],
        },
      },
    ]);
  });

  test("a refused table half rolls the frame back (undo), so nothing is stranded", async () => {
    covers("command:paged.insert.table");
    const h = inserts({
      collections: (name, call) =>
        name === "stories"
          ? call === 1
            ? []
            : [{ selfId: "uNew" }]
          : undefined,
      mutate: (m) =>
        m.op === "insertTable" ? refused("no table here") : undefined,
    });
    await h.invoke("paged.insert.table");
    expect(h.reports).toEqual([
      ["error", "Insert table refused: no table here"],
    ]);
    expect(h.fake.ofChannel("history").map((e) => e.action)).toEqual(["undo"]);
    expect(h.fake.undoDepth()).toBe(0);
  });

  // Finding SH-202 (documented engine limitation, insert-commands.ts fact
  // 3): with no caret, Insert table is TWO mutations — two undo records —
  // so one Cmd+Z after it leaves an empty text frame on the page.
  test.failing(
    "SH-202: Insert table with no caret is ONE undo step",
    async () => {
      covers("command:paged.insert.table");
      const h = inserts({
        collections: (name, call) =>
          name === "stories"
            ? call === 1
              ? []
              : [{ selfId: "uNew" }]
            : undefined,
      });
      await h.invoke("paged.insert.table");
      expectOneCommit(h.fake, 0, "Insert table");
    },
  );
});

describe("Place image", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  /** The picker the app uses (`<input type=file>`), answered with `files`. */
  const pick = (
    files: Array<{ name: string; bytes: Uint8Array; type: string }>,
  ) => {
    stubGlobal("document", {
      createElement: () => {
        const input: Record<string, unknown> = {
          click: () => {
            input.files = files.map(
              (f) => new File([f.bytes.slice()], f.name, { type: f.type }),
            );
            void (input.onchange as () => Promise<void>)();
          },
        };
        return input;
      },
      querySelector: () => null,
    });
  };

  test("with one empty graphic frame selected, the picture goes INTO it: one replaceImageBytes", async () => {
    covers("command:paged.insert.placeImage");
    pick([{ name: "photo.png", bytes: PNG, type: "image/png" }]);
    stubGlobal("createImageBitmap", async () => ({
      width: 400,
      height: 300,
      close() {},
    }));
    const frame = id("rectangle", "uR");
    const h = inserts({
      selection: [frame],
      geometry: (e) => ({
        id: e,
        pageId: "p1",
        bounds: [0, 0, 10, 10],
        itemTransform: null,
        hasImage: false,
      }),
    });
    const outcome = await h.invoke("paged.insert.placeImage");
    expect(h.fake.mutations()).toEqual([
      {
        op: "replaceImageBytes",
        args: { elementId: "uR", bytes: Array.from(PNG) },
      },
    ]);
    expectOneCommit(h.fake);
    expect(outcome).toEqual({ applied: true, createdId: frame });
  });

  test("a cancelled picker places nothing and says nothing", async () => {
    covers("command:paged.insert.placeImage");
    pick([]);
    const h = inserts();
    await h.invoke("paged.insert.placeImage");
    expectNoCommit(h.fake);
    expect(h.reports).toEqual([]);
  });

  test("a file the browser cannot decode is reported", async () => {
    covers("command:paged.insert.placeImage");
    pick([{ name: "broken.png", bytes: PNG, type: "image/png" }]);
    stubGlobal("createImageBitmap", async () => {
      throw new Error("decode");
    });
    const h = inserts();
    await h.invoke("paged.insert.placeImage");
    expect(h.fake.mutations()).toEqual([]);
    expect(h.reports).toEqual([
      ["error", 'Place image: could not decode "broken.png" as an image.'],
    ]);
  });

  test("a PSD with no plugin to read it is reported by name", async () => {
    covers("command:paged.insert.placeImage");
    const psd = new Uint8Array(26);
    psd.set([0x38, 0x42, 0x50, 0x53]);
    new DataView(psd.buffer).setUint32(14, 50);
    new DataView(psd.buffer).setUint32(18, 80);
    expect(psdHeaderSize(psd)).toEqual({ width: 80, height: 50 });
    pick([
      { name: "layers.psd", bytes: psd, type: "image/vnd.adobe.photoshop" },
    ]);
    stubGlobal("createImageBitmap", async () => {
      throw new Error("decode");
    });
    const h = inserts();
    await h.invoke("paged.insert.placeImage");
    expect(h.reports).toEqual([
      [
        "error",
        'Place image: "layers.psd" is a Photoshop file, and no loaded plugin reads one.',
      ],
    ]);
  });
});

describe("pages: Add page, Delete page", () => {
  test("Add page inserts after the page in view, no master", async () => {
    covers("command:paged.insert.newPage");
    const h = inserts({ pages: 2, onPage: 1 });
    await h.invoke("paged.insert.newPage");
    expect(h.fake.mutations()).toEqual([
      { op: "insertPage", args: { afterPageId: "p2", masterId: null } },
    ]);
    expectOneCommit(h.fake);
  });

  test("Delete page deletes the page in view", async () => {
    covers("command:paged.insert.deletePage");
    const h = inserts({ pages: 3, onPage: 2 });
    await h.invoke("paged.insert.deletePage");
    expect(h.fake.mutations()).toEqual([
      { op: "deletePage", args: { pageId: "p3" } },
    ]);
    expectOneCommit(h.fake);
  });

  test("Delete page refuses the only page, in words", async () => {
    covers("command:paged.insert.deletePage");
    const h = inserts({ pages: 1 });
    await h.invoke("paged.insert.deletePage");
    expect(h.fake.mutations()).toEqual([]);
    expect(h.reports[0]?.[1]).toMatch(
      /^Delete page refused: this is the document's only page/,
    );
  });

  test("the engine's refusal of a page op is reported", async () => {
    covers("command:paged.insert.newPage", "command:paged.insert.deletePage");
    const add = inserts({ pages: 2, mutate: () => refused("spread is full") });
    await add.invoke("paged.insert.newPage");
    expect(add.reports).toEqual([
      ["error", "Add page refused: spread is full"],
    ]);
    const del = inserts({ pages: 2, mutate: () => refused("page is locked") });
    await del.invoke("paged.insert.deletePage");
    expect(del.reports).toEqual([
      ["error", "Delete page refused: page is locked"],
    ]);
  });
});

describe("enablement: a document is open and the user is at the document root", () => {
  const ALL = [
    "paged.insert.textFrame",
    "paged.insert.rectangle",
    "paged.insert.ellipse",
    "paged.insert.line",
    "paged.insert.table",
    "paged.insert.deletePage",
    "paged.insert.placeImage",
    "paged.insert.newPage",
  ];

  test("with no document every insert refuses silently through the registry", async () => {
    covers(
      "command:paged.insert.textFrame",
      "command:paged.insert.rectangle",
      "command:paged.insert.ellipse",
      "command:paged.insert.line",
      "command:paged.insert.table",
      "command:paged.insert.deletePage",
      "command:paged.insert.placeImage",
      "command:paged.insert.newPage",
    );
    for (const command of ALL) {
      const h = inserts({ noDocument: true });
      expect(await h.invoke(command)).toBeUndefined();
      expect(h.fake.mutations()).toEqual([]);
      expect(h.reports).toEqual([]);
    }
  });

  test("inside an edit context every insert refuses silently through the registry", async () => {
    covers(
      "command:paged.insert.textFrame",
      "command:paged.insert.rectangle",
      "command:paged.insert.ellipse",
      "command:paged.insert.line",
      "command:paged.insert.table",
      "command:paged.insert.deletePage",
      "command:paged.insert.placeImage",
      "command:paged.insert.newPage",
    );
    for (const command of ALL) {
      const h = inserts({ pages: 2, editContext: { type: "sheet" } });
      expect(await h.invoke(command)).toBeUndefined();
      expect(h.fake.mutations()).toEqual([]);
    }
  });

  test("a runner reached past the gate (a shortcut) explains itself", async () => {
    covers("command:paged.insert.rectangle", "command:paged.insert.newPage");
    const none = inserts({ noDocument: true });
    const report: Report[] = [];
    expect(
      await insertRectangle(
        none.paged as never,
        (s, m) => void report.push([s, m]),
      ),
    ).toEqual({ applied: false, createdId: null });
    expect(report).toEqual([
      [
        "info",
        "Insert rectangle needs an open document. Open or create one first.",
      ],
    ]);
    const inside = inserts({ editContext: { type: "webFrame" } });
    const report2: Report[] = [];
    await addPage(inside.paged as never, (s, m) => void report2.push([s, m]));
    expect(report2[0]?.[1]).toBe(
      "Add page inserts page items, and you are editing inside a webFrame. Leave the frame (Esc) to insert into the document.",
    );
  });
});
