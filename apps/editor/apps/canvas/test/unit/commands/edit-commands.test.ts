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

// The Edit menu's verbs and the two typed Object verbs the canvas app adds:
// Select all (page items on the spread in view, or the whole story with a
// caret) and Align / Distribute (ADR 323: declared args, one batch = one
// undo step). And finding SH-201
// (UX audit F-28): no Cut, Copy, Paste or Duplicate for page items.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { createCommandRegistry } from "@paged-media/shell";
import { covers, expectNoCommit } from "@paged-media/test-kit";

import {
  ALIGN_ARGS,
  ALIGN_COMMAND,
  planAlign,
  runAlign,
} from "../../../src/align-plan";
import {
  APP_KEYBINDINGS,
  APP_MENU_ITEMS,
  buildAppCommands,
} from "../../../src/app-commands";
import {
  buildCoreCommandEntries,
  CORE_COMMAND_MENU_ITEMS,
} from "../../../src/core-command-entries";
import {
  buildInsertCommands,
  INSERT_KEYBINDINGS,
  INSERT_MENU_ITEMS,
} from "../../../src/insert-commands";
import {
  buildObjectCommands,
  OBJECT_KEYBINDINGS,
  OBJECT_MENU_ITEMS,
} from "../../../src/object-commands";
import { GLOBAL_LIGHT_COMMANDS } from "../../../src/panels/global-light-dialog";
import {
  SELECT_ALL_COMMAND,
  SELECT_ALL_KEYBINDINGS,
  SELECT_ALL_MENU_ITEM,
  spreadItems,
} from "../../../src/select-all";
import {
  group,
  id,
  leaf,
  page,
  scriptedFake,
  spread,
  typedClient,
} from "./support";

// ── Select all ──────────────────────────────────────────────────────

function selectAllHarness(opts: {
  pages?: number;
  caret?: { storyId: string; start: number; end: number } | null;
  editContext?: { type: string } | null;
  noDocument?: boolean;
  tree?: ReturnType<typeof spread>[];
  paragraphEnd?: number | null;
}) {
  const fake = scriptedFake(
    { tree: opts.tree },
    {
      reply: (m) =>
        m.kind === "requestParagraphBounds"
          ? {
              kind: "paragraphBoundsResult",
              payload: {
                bounds:
                  opts.paragraphEnd == null
                    ? null
                    : { start: 0, end: opts.paragraphEnd },
              },
            }
          : undefined,
    },
  );
  const client = typedClient((m) => fake.editor.client.send(m));
  const pages = opts.pages ?? 1;
  const pageIds = Array.from({ length: pages }, (_, i) => `p${i + 1}`);
  let selected: ElementId[] = [];
  let activeTool = "text";
  const caretRef = { current: opts.caret ?? null };
  const paged = {
    client,
    editContext: opts.editContext ?? null,
    document: {
      handle: opts.noDocument
        ? null
        : {
            pageCount: pages,
            pageIds,
            pageSizesPt: pageIds.map(() => [612, 792]),
          },
    },
    camera: { camera: { scale: 0, tx: 0, ty: 0 }, viewportSize: [0, 0] },
    contentSelection: {
      contentSelectionRef: caretRef,
      setContentSelection: (v: unknown) => void (caretRef.current = v as never),
    },
    selection: {
      get activeTool() {
        return activeTool;
      },
      setActiveTool: (t: string) => void (activeTool = t),
      setElementSelection: (ids: ElementId[]) => void (selected = ids),
      setElementGeometry: () => {},
    },
  };
  const registry = createCommandRegistry(() => paged);
  registry.register(SELECT_ALL_COMMAND);
  return {
    fake,
    invoke: async () => {
      await registry.invoke("paged.edit.selectAll");
      await fake.settle();
    },
    selected: () => selected,
    tool: () => activeTool,
    caret: () => caretRef.current,
  };
}

describe("Select all", () => {
  const tree = [
    spread(
      page(leaf("rectangle", "uA"), group("uG", leaf("oval", "uC"))),
      page(leaf("textFrame", "uT")),
    ),
    spread(page(leaf("rectangle", "uOther"))),
  ];

  test("selects every top-level page item of the spread in view, never a mutation", async () => {
    covers("command:paged.edit.selectAll");
    const h = selectAllHarness({ pages: 3, tree });
    await h.invoke();
    expect(h.selected()).toEqual([
      id("rectangle", "uA"),
      id("group", "uG"),
      id("textFrame", "uT"),
    ]);
    // A text tool in hand yields to Selection once objects are selected.
    expect(h.tool()).toBe("select");
    expectNoCommit(h.fake);
  });

  test("spreadItems resolves the spread holding a page index", () => {
    covers("command:paged.edit.selectAll");
    expect(spreadItems(tree, 2)).toEqual([id("rectangle", "uOther")]);
    expect(spreadItems(tree, 9)).toEqual([]);
  });

  test("with a caret it selects the whole story instead", async () => {
    covers("command:paged.edit.selectAll");
    const h = selectAllHarness({
      tree,
      caret: { storyId: "uS", start: 4, end: 4 },
      paragraphEnd: 57,
    });
    await h.invoke();
    expect(h.caret()).toEqual({
      storyId: "uS",
      start: 0,
      end: 57,
      affinity: false,
    });
    expect(h.selected()).toEqual([]);
  });

  test("no document, or inside an edit context: the command does not apply", async () => {
    covers("command:paged.edit.selectAll");
    for (const opts of [
      { noDocument: true },
      { editContext: { type: "sheet" } },
    ]) {
      const h = selectAllHarness({ tree, ...opts });
      await h.invoke();
      expect(h.selected()).toEqual([]);
      expect(h.fake.ofChannel("send")).toEqual([]);
    }
    // The menu item and both keys carry the same gate.
    expect(SELECT_ALL_MENU_ITEM.when).toBe(SELECT_ALL_COMMAND.when);
    expect(SELECT_ALL_KEYBINDINGS.map((k) => k.key)).toEqual([
      "cmd+a",
      "ctrl+a",
    ]);
  });
});

// ── Align / Distribute ──────────────────────────────────────────────

function alignHarness(
  bounds: Record<string, [number, number, number, number]>,
) {
  const batches: Array<{ ops: unknown[]; label?: string }> = [];
  const objects = {
    async get(address: string, path: string) {
      expect(path).toBe("frameBounds");
      const b = bounds[address];
      return b ? { kind: "value", value: b } : { kind: "error" };
    },
    async batch(ops: readonly unknown[], opts?: { label?: string }) {
      batches.push({ ops: [...ops], label: opts?.label });
      return { applied: true, undoSteps: 1 as const };
    },
  };
  // The canvas app's registration (main.tsx): declared args, runAlign.
  const registry = createCommandRegistry(() => null);
  registry.register({
    id: ALIGN_COMMAND,
    title: "Align objects",
    category: "Object",
    args: ALIGN_ARGS,
    handler: (_p, payload) => runAlign(objects, payload as never),
  });
  return { registry, batches };
}

describe("Align / Distribute (paged.align.objects)", () => {
  const boxes = {
    a: [0, 0, 10, 10] as [number, number, number, number],
    b: [20, 30, 40, 50] as [number, number, number, number],
    c: [5, 100, 25, 140] as [number, number, number, number],
  };

  test("align left: every object to the leftmost edge, in ONE batch", async () => {
    covers("command:paged.align.objects");
    const h = alignHarness(boxes);
    const result = await h.registry.invoke(ALIGN_COMMAND, {
      kind: "left",
      targets: ["a", "b", "c"],
    });
    expect(result).toEqual({ applied: true, undoSteps: 1 });
    expect(h.batches).toEqual([
      {
        label: "align left",
        ops: [
          {
            op: "set",
            address: "b",
            path: "frameBounds",
            value: [20, 0, 40, 20],
          },
          {
            op: "set",
            address: "c",
            path: "frameBounds",
            value: [5, 0, 25, 40],
          },
        ],
      },
    ]);
  });

  test("every alignment kind plans the expected edge", () => {
    covers("command:paged.align.objects");
    const entries = Object.entries(boxes).map(([address, b]) => ({
      address,
      bounds: b,
    }));
    const lefts = (kind: Parameters<typeof planAlign>[0]) =>
      Object.fromEntries(
        planAlign(kind, entries).map((o) => {
          const set = o as { address: string; value: number[] };
          return [set.address, set.value];
        }),
      );
    expect(lefts("right")).toEqual({
      a: [0, 130, 10, 140],
      b: [20, 120, 40, 140],
    });
    expect(lefts("top")).toEqual({ b: [0, 30, 20, 50], c: [0, 100, 20, 140] });
    expect(lefts("bottom")).toEqual({
      a: [30, 0, 40, 10],
      c: [20, 100, 40, 140],
    });
    expect(lefts("centerH")).toEqual({
      a: [0, 65, 10, 75],
      b: [20, 60, 40, 80],
      c: [5, 50, 25, 90],
    });
    expect(lefts("centerV")).toEqual({
      a: [15, 0, 25, 10],
      b: [10, 30, 30, 50],
      c: [10, 100, 30, 140],
    });
    // Distribute moves the middle one between the outer two.
    expect(lefts("distributeH")).toEqual({ b: [20, 52.5, 40, 72.5] });
    expect(lefts("distributeV")).toEqual({ c: [7.5, 100, 27.5, 140] });
  });

  test("fewer than two (align) or three (distribute) objects move nothing: zero undo steps", async () => {
    covers("command:paged.align.objects");
    const h = alignHarness(boxes);
    expect(
      await h.registry.invoke(ALIGN_COMMAND, { kind: "left", targets: ["a"] }),
    ).toEqual({
      applied: true,
      undoSteps: 0,
    });
    expect(
      await h.registry.invoke(ALIGN_COMMAND, {
        kind: "distributeH",
        targets: ["a", "b"],
      }),
    ).toEqual({ applied: true, undoSteps: 0 });
    // An address without bounds (a story, a stale id) is skipped.
    expect(
      await h.registry.invoke(ALIGN_COMMAND, {
        kind: "left",
        targets: ["a", "nope"],
      }),
    ).toEqual({ applied: true, undoSteps: 0 });
    expect(h.batches).toEqual([]);
  });

  test("a payload that does not match the declared args is refused before anything runs", async () => {
    covers("command:paged.align.objects");
    const h = alignHarness(boxes);
    await expect(
      h.registry.invoke(ALIGN_COMMAND, { kind: "diagonal", targets: [] }),
    ).rejects.toThrow(/^invalidValue: paged\.align\.objects/);
    await expect(h.registry.invoke(ALIGN_COMMAND)).rejects.toThrow(
      /invalidValue/,
    );
    await expect(
      h.registry.invoke(ALIGN_COMMAND, { kind: "left", targets: "a" }),
    ).rejects.toThrow(/must be a list/);
    expect(h.batches).toEqual([]);
  });
});

// ── F-28: the clipboard verbs ───────────────────────────────────────

describe("SH-201 (UX audit F-28): Cut, Copy, Paste and Duplicate for page items", () => {
  // Every host command table the canvas app registers, with no-op handlers.
  const noop = () => {};
  const commandIds = () =>
    [
      ...buildAppCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildObjectCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildInsertCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildCoreCommandEntries(),
      SELECT_ALL_COMMAND,
      ...GLOBAL_LIGHT_COMMANDS,
    ].map((c) => c.id);
  const keys = () =>
    [
      ...APP_KEYBINDINGS,
      ...OBJECT_KEYBINDINGS,
      ...INSERT_KEYBINDINGS,
      ...SELECT_ALL_KEYBINDINGS,
    ].map((k) => `${k.key}→${k.command}`);
  const editMenu = () =>
    [
      ...APP_MENU_ITEMS,
      ...OBJECT_MENU_ITEMS,
      ...INSERT_MENU_ITEMS,
      ...CORE_COMMAND_MENU_ITEMS,
      SELECT_ALL_MENU_ITEM,
    ]
      .map((m) => m.path)
      .filter((p) => p.startsWith("Edit/"));

  test("today: the host registers none of them (the finding, as it stands)", () => {
    covers("command:paged.edit.selectAll");
    const verbs = commandIds().filter((id) =>
      /\b(cut|copy|paste|duplicate)\b/i.test(id.split(".").pop()!),
    );
    expect(verbs).toEqual([]);
    expect(keys().filter((k) => /^(cmd|ctrl)\+[cxv]→/.test(k))).toEqual([]);
    expect(editMenu()).toEqual([
      "Edit/Undo",
      "Edit/Redo",
      "Edit/Run command…",
      "Edit/Select all",
    ]);
  });

  test.failing(
    "SH-201: the Edit menu offers Cut, Copy, Paste and Duplicate, bound to the platform keys",
    () => {
      covers("command:paged.edit.selectAll");
      const paths = editMenu();
      for (const verb of ["Cut", "Copy", "Paste", "Duplicate"]) {
        expect(paths.some((p) => p.startsWith(`Edit/${verb}`))).toBe(true);
      }
      const bound = keys();
      for (const chord of [
        "cmd+x",
        "cmd+c",
        "cmd+v",
        "ctrl+x",
        "ctrl+c",
        "ctrl+v",
      ]) {
        expect(bound.some((k) => k.startsWith(`${chord}→`))).toBe(true);
      }
    },
  );
});
