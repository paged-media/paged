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

// @feat: plugin-platform.object-model.node-cli
//
// `paged commands` / `paged invoke` (DESIGN.md §21.12): the typed core
// commands (`core.<op>`, generated from the wire) and every plugin's, run
// from the shell, each write ONE undo step saved to a .paged file and read
// back from it by a fresh session. Real engine.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CORE_COMMAND_OPS } from "@paged-media/plugin-sdk";

import { cli, laneProtocol, tempDir, writeFixture } from "./helpers";

const NP = "--no-plugins";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
let lane = 0;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
  lane = await laneProtocol();
});
afterAll(() => tmp.done());

describe("paged commands", () => {
  it("lists every core command with its argument schema", async () => {
    const r = await cli(["commands", fx.paged, "--owner", "core", NP]);
    expect(r.code).toBe(0);
    const ids = (r.json.commands as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual(CORE_COMMAND_OPS.map((op) => `core.${op}`));
    const table = (r.json.commands as Array<{ id: string; args: unknown }>).find((c) => c.id === "core.insertTable")!;
    expect(table.args).toMatchObject({ kind: "struct", fields: { storyId: { kind: "ref", to: "story" }, rows: { kind: "number" } } });
    const text = await cli(["commands", "--owner", "core", "--format", "text", NP]);
    expect(text.out).toMatch(/core\.insertTable\s+core\s+storyId: ref to story, rows: number, cols: number, headerRows\?: number/);
  });
});

describe("paged invoke", () => {
  it("inserts a table into a story by address; the file holds it", async () => {
    const out = join(tmp.dir, "table.paged");
    const r = await cli(["invoke", fx.paged, "core.insertTable", JSON.stringify({ storyId: fx.story, rows: 2, cols: 3 }), "-o", out, NP]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.result.undoSteps).toBe(1);
    const [table] = r.json.result.created as string[];
    expect(table).toMatch(/^table:/);
    expect((await cli(["query", out, "table", NP])).json.addresses).toEqual([table]);
    if (lane >= 71) expect((await cli(["get", out, table!, "tableColumnCount", NP])).json.value).toBe(3);
  });

  it("duplicates and moves a page (args from a file)", async () => {
    const dup = join(tmp.dir, "dup.paged");
    const r = await cli(["invoke", fx.paged, "core.duplicatePage", '{"page":"page:#1"}', "-o", dup, NP]);
    expect(r.code, r.out).toBe(0);
    const [made] = r.json.result.created as string[];
    expect(made).toMatch(/^page:/);
    const pages = (await cli(["query", dup, "page", NP])).json.addresses as string[];
    expect(pages).toHaveLength(2);
    const argsFile = join(tmp.dir, "move.json");
    writeFileSync(argsFile, JSON.stringify({ page: pages[1], after: null }));
    const moved = join(tmp.dir, "moved.paged");
    expect((await cli(["invoke", dup, "core.movePage", argsFile, "-o", moved, NP])).code).toBe(0);
    expect(((await cli(["query", moved, "page", NP])).json.addresses as string[])[0]).toBe(pages[1]);
  });

  it("a core command joins `paged batch` beside a set: one undo step", async () => {
    if (lane < 71) return; // a $h: address in a Set needs protocol 71
    const ops = join(tmp.dir, "ops.json");
    writeFileSync(
      ops,
      JSON.stringify([
        { op: "invoke", command: "core.insertFrame", args: { pageId: "page:#1", bounds: [300, 20, 340, 80], handle: "box" } },
        { op: "set", address: "$h:box", path: "itemName", value: "from the shell" },
      ]),
    );
    const out = join(tmp.dir, "batch.paged");
    const r = await cli(["batch", fx.paged, ops, "-o", out, NP]);
    expect(r.code, r.out).toBe(0);
    expect(r.json.result).toMatchObject({ applied: true, undoSteps: 1 });
    const [frame] = r.json.result.commands[0].created as string[];
    expect((await cli(["get", out, frame!, "itemName", NP])).json.value).toBe("from the shell");
  });

  it("refuses an unknown command (usage) and bad args (failed) and writes nothing", async () => {
    const unknown = await cli(["invoke", fx.paged, "core.nope", "{}", NP]);
    expect(unknown.code).toBe(2);
    const bad = await cli(["invoke", fx.paged, "core.insertTable", JSON.stringify({ storyId: fx.story, rows: "two", cols: 2 }), "--no-save", NP]);
    expect(bad.code).toBe(1);
    expect(bad.json).toMatchObject({ applied: false, saved: null });
    expect(bad.json.error).toMatch(/^invalidValue/);
  });
});
