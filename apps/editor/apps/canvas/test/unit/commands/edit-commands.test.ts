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
// caret; Align / Distribute is align-plan.test.ts). And finding SH-201
// (UX audit F-28, fixed by ADR 231): Cut, Copy, Paste, Paste in place and
// Duplicate for page items.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { createCommandRegistry } from "@paged-media/shell";
import { covers, expectNoCommit } from "@paged-media/test-kit";

import {
  APP_KEYBINDINGS,
  APP_MENU_ITEMS,
  buildAppCommands,
} from "../../../src/app-commands";
import {
  buildClipboardCommands,
  CLIPBOARD_KEYBINDINGS,
  CLIPBOARD_MENU_ITEMS,
  resolvePaste,
} from "../../../src/clipboard-commands";
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

// ── Align / Distribute: test/unit/commands/align-plan.test.ts ──────

// ── F-28: the clipboard verbs ───────────────────────────────────────

describe("SH-201 (UX audit F-28): Cut, Copy, Paste and Duplicate for page items", () => {
  // Every host command table the canvas app registers, with no-op handlers.
  const noop = () => {};
  const commandIds = () =>
    [
      ...buildAppCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildClipboardCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildObjectCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildInsertCommands(new Proxy({}, { get: () => noop }) as never),
      ...buildCoreCommandEntries(),
      SELECT_ALL_COMMAND,
      ...GLOBAL_LIGHT_COMMANDS,
    ].map((c) => c.id);
  const keys = () =>
    [
      ...APP_KEYBINDINGS,
      ...CLIPBOARD_KEYBINDINGS,
      ...OBJECT_KEYBINDINGS,
      ...INSERT_KEYBINDINGS,
      ...SELECT_ALL_KEYBINDINGS,
    ].map((k) => `${k.key}→${k.command}`);
  const editMenu = () =>
    [
      ...APP_MENU_ITEMS,
      ...CLIPBOARD_MENU_ITEMS,
      ...OBJECT_MENU_ITEMS,
      ...INSERT_MENU_ITEMS,
      ...CORE_COMMAND_MENU_ITEMS,
      SELECT_ALL_MENU_ITEM,
    ]
      .map((m) => m.path)
      .filter((p) => p.startsWith("Edit/"));

  test("the host registers Cut, Copy, Paste, Paste in place and Duplicate", () => {
    covers(
      "keybinding:cmd+x→paged.edit.cut",
      "keybinding:cmd+c→paged.edit.copy",
      "keybinding:cmd+v→paged.edit.paste",
      "keybinding:cmd+alt+shift+v→paged.edit.pasteInPlace",
      "keybinding:cmd+alt+shift+d→paged.edit.duplicate",
      "keybinding:ctrl+x→paged.edit.cut",
      "keybinding:ctrl+c→paged.edit.copy",
      "keybinding:ctrl+v→paged.edit.paste",
      "keybinding:ctrl+alt+shift+v→paged.edit.pasteInPlace",
      "keybinding:ctrl+alt+shift+d→paged.edit.duplicate",
    );
    covers(
      "command:paged.edit.cut",
      "command:paged.edit.copy",
      "command:paged.edit.paste",
      "command:paged.edit.pasteInPlace",
      "command:paged.edit.duplicate",
    );
    const verbs = commandIds().filter((id) =>
      /\b(cut|copy|paste|pasteInPlace|duplicate)\b/i.test(id.split(".").pop()!),
    );
    expect(verbs).toEqual([
      "paged.edit.cut",
      "paged.edit.copy",
      "paged.edit.paste",
      "paged.edit.pasteInPlace",
      "paged.edit.duplicate",
    ]);
    // InDesign's chords: Paste in Place and Duplicate on Alt+Shift.
    expect(keys()).toEqual(
      expect.arrayContaining([
        "cmd+alt+shift+v→paged.edit.pasteInPlace",
        "ctrl+alt+shift+d→paged.edit.duplicate",
      ]),
    );
    expect(editMenu()).toEqual([
      "Edit/Undo",
      "Edit/Redo",
      "Edit/History",
      "Edit/Cut",
      "Edit/Copy",
      "Edit/Paste",
      "Edit/Paste in place",
      "Edit/Duplicate",
      "Edit/Run command…",
      "Edit/Select all",
    ]);
  });

  test("a paste pastes the newest clipboard content: our copy while its marker is there, text from elsewhere otherwise", () => {
    covers("command:paged.edit.paste");
    const ours = { snippet: "{S}", text: "Hello", count: 1, token: "t1" };
    const html = '<div data-paged-clip="t1">Hello</div>';
    expect(resolvePaste({ text: "Hello", html }, ours)).toEqual({
      kind: "items",
      snippet: "{S}",
    });
    expect(resolvePaste({ text: "Other app", html: "" }, ours)).toEqual({
      kind: "text",
      text: "Other app",
    });
    // The browser would not let us read: our copy.
    expect(resolvePaste(null, ours)).toEqual({ kind: "items", snippet: "{S}" });
    expect(resolvePaste(null, null)).toEqual({ kind: "empty" });
    // Another tab's copy carries its snippet in the HTML form.
    const b64 = btoa("{T}");
    expect(
      resolvePaste(
        {
          text: "x",
          html: `<div data-paged-clip="t9" data-paged-snippet="${b64}">x</div>`,
        },
        ours,
      ),
    ).toEqual({ kind: "items", snippet: "{T}" });
  });

  test("SH-201: the Edit menu offers Cut, Copy, Paste and Duplicate, bound to the platform keys", () => {
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
  });
});
