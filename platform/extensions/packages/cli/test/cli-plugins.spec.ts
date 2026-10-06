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
// ADR 323/324 — plugin object kinds through the CLI: a bundle that
// contributes an object model (the SDK's reference "notes" bundle, whose
// state lives in container parts behind a label hash) is discovered with
// --plugins, its kinds show in schema/plugins, and get/set reach its objects
// across separate invocations (the state rides in the saved .paged).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseArgs } from "../src/args";
import { openSession, type CliSession } from "../src/session";
import { GLOBAL_OPTIONS, sessionOptions, VERBS } from "../src/verbs";
import { cli, FIXTURES, tempDir, writeFixture } from "./helpers";

/** One session shared by several verb runs (opened by the first). */
function keptSession() {
  let s: Promise<CliSession> | null = null;
  return {
    open: (doc: string | null, args: ReturnType<typeof parseArgs>) => (s ??= openSession(doc, sessionOptions(args, tmp.dir))),
    get: () => s!,
  };
}
async function verb(name: string, argv: string[], kept: ReturnType<typeof keptSession>) {
  const v = VERBS.find((x) => x.name === name)!;
  const args = parseArgs(argv, [...v.options, ...GLOBAL_OPTIONS]);
  const r = await v.run({ args, cwd: tmp.dir, session: (doc) => kept.open(doc, args) });
  return r as typeof r & { json: any };
}

const NOTES = `--plugins=${join(FIXTURES, "notes-plugin.ts")}`;
const NOTE = "plugin:acme.notes/note/n1";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
});
afterAll(() => tmp.done());

describe("plugin object kinds", () => {
  it("appear in plugins / schema, are created by a typed command, and round-trip get/set through files", async () => {
    const listed = await cli(["plugins", NOTES]);
    expect(listed.json.plugins).toEqual([expect.objectContaining({ id: "acme.notes", kinds: ["plugin:acme.notes/note"] })]);
    const kinds = await cli(["schema", fx.paged, NOTES]);
    expect(kinds.json.commands.map((c: { id: string }) => c.id)).toEqual(["acme.notes.attach"]);
    expect((await cli(["schema", fx.paged, "plugin:acme.notes/note", NOTES])).json.rows.map((r: { path: string }) => r.path)).toEqual(
      expect.arrayContaining(["text", "size", "visible", "tone", "length"]),
    );

    // The reference bundle keeps its host frame per session (it does not
    // rediscover it on load), so the verbs share ONE session here.
    const sess = keptSession();
    const script = join(tmp.dir, "attach.mjs");
    writeFileSync(script, "export default (paged) => paged.invoke('acme.notes.attach', { frame: 'rectangle:urect', count: 2 });");
    expect((await verb("run", [fx.paged, script, "--no-save", NOTES], sess)).json).toMatchObject({ result: 2 });
    expect((await verb("query", [fx.paged, "plugin:acme.notes/note"], sess)).json.addresses).toEqual([NOTE, "plugin:acme.notes/note/n2"]);
    const set = await verb("set", [fx.paged, NOTE, "size", "18", "--no-save"], sess);
    expect(set.json.result).toMatchObject({ applied: true, undoSteps: 1 });
    expect((await verb("get", [fx.paged, NOTE, "size"], sess)).json.value).toBe(18);
    expect((await verb("query", [fx.paged, "plugin:acme.notes/note[size=18]"], sess)).json.addresses).toEqual([NOTE]);
    // One undo step reverts the plugin state (label-hash pattern).
    await (await sess.get()).driver.document.undo();
    expect((await verb("get", [fx.paged, NOTE, "size"], sess)).json.value).toBe(12);

    // Values are refused by the PLUGIN's schema: range, enum, derived.
    await expect(verb("set", [fx.paged, NOTE, "size", "100", "--no-save"], sess)).rejects.toThrow(/size 100 is above 72/);
    await expect(verb("set", [fx.paged, NOTE, "tone", "green", "--no-save"], sess)).rejects.toThrow(/expected enum \(red \| blue\)/);
    await expect(verb("set", [fx.paged, NOTE, "length", "3", "--no-save"], sess)).rejects.toThrow(/length: is derived/);
    (await sess.get()).dispose();
  });

  it("an explicit plugin that cannot load is a usage error", async () => {
    const r = await cli(["query", fx.paged, "doc", "--plugins=@paged-media/not-installed"]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/plugin @paged-media\/not-installed/);
  });
});
