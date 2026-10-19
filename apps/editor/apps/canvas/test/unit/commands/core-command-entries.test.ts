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

// `paged.core.*` — the menu and palette doors of the typed core commands
// (ADR 323 §4). Each door opens the typed-command form on ITS op with ITS
// prefill; Run command… opens the picker. The op must be a real typed core
// command of the engine this editor ships, and the prefill may only name
// that command's arguments — a door to an op the engine does not take, or
// a prefill the form would reject, is a dead menu item.

import { describe, expect, mock, test } from "bun:test";

import { createCommandRegistry } from "@paged-media/shell";
import { CORE_COMMAND_OPS, CORE_WIRE_OPS } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

const opened: Array<{
  op: string | null;
  prefill: unknown;
  opts: unknown;
}> = [];

// The dialog is a React form; the doors only ask it to open. Observe the
// ask, keep the rest of the module.
const dialog = await import("../../../src/core-command-dialog");
mock.module("../../../src/core-command-dialog", () => ({
  ...dialog,
  openCoreCommand: (
    op: string | null,
    prefill: unknown = {},
    opts: unknown = {},
  ) => void opened.push({ op, prefill, opts }),
}));
const {
  buildCoreCommandEntries,
  CORE_COMMAND_ENTRIES,
  CORE_COMMAND_MENU_ITEMS,
  RUN_CORE_COMMAND,
} = await import("../../../src/core-command-entries");

const EXPECTED_DOORS = [
  "paged.core.runCommand",
  "paged.core.insertField",
  "paged.core.insertHyperlink",
  "paged.core.insertAnchoredFrame",
  "paged.core.setFieldValue",
  "paged.core.pathPointInsert",
  "paged.core.pathPointRemove",
  "paged.core.pathPointSet",
  "paged.core.closePath",
  "paged.core.joinPaths",
  "paged.core.outlineStroke",
  "paged.core.offsetPath",
  "paged.core.pathfinderFaces",
  "paged.core.attachTextToPath",
  "paged.core.detachTextFromPath",
  "paged.core.applyOpacityMask",
  "paged.core.releaseOpacityMask",
  "paged.core.duplicateElements",
  "paged.core.movePage",
  "paged.core.createMaster",
  "paged.core.renameMaster",
  "paged.core.deleteMaster",
  "paged.core.deleteSection",
  "paged.core.createTextVariable",
  "paged.core.deleteTextVariable",
  "paged.core.createGradient",
  "paged.core.deleteGradient",
  "paged.core.createCellStyle",
  "paged.core.deleteCellStyle",
  "paged.core.createTableStyle",
  "paged.core.deleteTableStyle",
  "paged.core.setConditionVisible",
  "paged.core.deleteTable",
];

describe("the typed core command doors", () => {
  test("the set of doors is exactly the one these tests cover", () => {
    covers("command:paged.core.runCommand");
    expect(buildCoreCommandEntries().map((c) => c.id)).toEqual(EXPECTED_DOORS);
    expect(RUN_CORE_COMMAND).toBe("paged.core.runCommand");
  });

  test("Run command… opens the picker (no op), with no state required", async () => {
    covers("command:paged.core.runCommand");
    opened.length = 0;
    const registry = createCommandRegistry(() => null);
    for (const c of buildCoreCommandEntries()) registry.register(c);
    await registry.invoke("paged.core.runCommand");
    expect(opened).toEqual([{ op: null, prefill: {}, opts: {} }]);
  });

  test("every door opens the form on its own op, with its prefill and title", async () => {
    covers(
      "command:paged.core.insertField",
      "command:paged.core.insertHyperlink",
      "command:paged.core.insertAnchoredFrame",
      "command:paged.core.setFieldValue",
      "command:paged.core.pathPointInsert",
      "command:paged.core.pathPointRemove",
      "command:paged.core.pathPointSet",
      "command:paged.core.closePath",
      "command:paged.core.joinPaths",
      "command:paged.core.outlineStroke",
      "command:paged.core.offsetPath",
      "command:paged.core.pathfinderFaces",
      "command:paged.core.attachTextToPath",
      "command:paged.core.detachTextFromPath",
      "command:paged.core.applyOpacityMask",
      "command:paged.core.releaseOpacityMask",
      "command:paged.core.duplicateElements",
      "command:paged.core.movePage",
      "command:paged.core.createMaster",
      "command:paged.core.renameMaster",
      "command:paged.core.deleteMaster",
      "command:paged.core.deleteSection",
      "command:paged.core.createTextVariable",
      "command:paged.core.deleteTextVariable",
      "command:paged.core.createGradient",
      "command:paged.core.deleteGradient",
      "command:paged.core.createCellStyle",
      "command:paged.core.deleteCellStyle",
      "command:paged.core.createTableStyle",
      "command:paged.core.deleteTableStyle",
      "command:paged.core.setConditionVisible",
      "command:paged.core.deleteTable",
    );
    const registry = createCommandRegistry(() => null);
    for (const c of buildCoreCommandEntries()) registry.register(c);
    for (const entry of CORE_COMMAND_ENTRIES) {
      opened.length = 0;
      await registry.invoke(`paged.core.${entry.op}`);
      expect({ door: entry.op, opened }).toEqual({
        door: entry.op,
        opened: [
          {
            op: entry.op,
            prefill: entry.prefill ?? {},
            opts: { title: entry.title },
          },
        ],
      });
    }
  });

  test("every door names a typed core command the engine takes", () => {
    covers("command:paged.core.runCommand");
    const typed = new Set(CORE_COMMAND_OPS);
    const missing = CORE_COMMAND_ENTRIES.map((e) => e.op).filter(
      (op) => !typed.has(op),
    );
    expect(missing).toEqual([]);
  });

  test("a prefill names only arguments its command declares", () => {
    covers("command:paged.core.insertField");
    const bad: string[] = [];
    for (const e of CORE_COMMAND_ENTRIES) {
      const fields = CORE_WIRE_OPS[e.op]?.args.fields ?? {};
      for (const k of Object.keys(e.prefill ?? {})) {
        if (!(k in fields)) bad.push(`${e.op}.${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("the doors are not gated: the form itself checks the selection", () => {
    covers("command:paged.core.runCommand");
    for (const c of buildCoreCommandEntries()) expect(c.when).toBeUndefined();
  });

  test("menu items point at registered doors, one row per door", () => {
    covers("command:paged.core.runCommand");
    const ids = new Set(buildCoreCommandEntries().map((c) => c.id));
    for (const m of CORE_COMMAND_MENU_ITEMS)
      expect(ids.has(m.command)).toBe(true);
    const commands = CORE_COMMAND_MENU_ITEMS.map((m) => m.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});
