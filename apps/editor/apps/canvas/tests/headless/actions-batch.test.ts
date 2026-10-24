/*
 * This file is part of paged (https://paged.media).
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

// WP4.11 against the real engine: a replayed action is ONE undo step
// (the client's undo group over the engine's amend), a pause the user
// edits during splits it honestly, the File ▸ Automate ▸ Batch… wiring
// (`appBatchDeps`) runs an action over two generated documents through
// the editor's own open path and exports each, and the open path reports
// a finished import to the run-on-import listeners.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ActionPlayer,
  onImported,
  openFile,
  playerDeps,
  runBatch,
  type ImportedFile,
  type PagedAction,
  type PagedEditor,
} from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import { appBatchDeps, BATCH_COMMAND } from "../../src/panels/batch-dialog";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

const SWATCH = (name: string, value: number[]) => ({
  op: "createSwatch" as const,
  args: {
    spec: { name, space: "CMYK", value, model: "Process" },
  },
});

/** A command that writes the document TWICE (two mutations). */
function registerWriter(e: HeadlessEditor, id: string, name: string) {
  e.registries.commands.register({
    id,
    title: name,
    handler: async () => {
      await e.client.mutate(SWATCH(`${name} 1`, [10, 0, 0, 0]) as never);
      await e.client.mutate(SWATCH(`${name} 2`, [0, 10, 0, 0]) as never);
    },
  });
}

const swatchNames = async (e: HeadlessEditor) =>
  (await e.client.collection<{ name: string | null }>("swatches"))
    .map((s) => s.name)
    .filter((n): n is string => !!n);

const action = (commands: string[], pauseAt?: number): PagedAction => ({
  id: "act_test",
  name: "Test",
  createdAt: 0,
  steps: commands.map((c, i) => ({
    command: c,
    title: c,
    verdict: "contextual",
    ...(i === pauseAt ? { pause: true } : {}),
  })),
  uncaptured: { gestures: 0, directEdits: 0 },
  includeDocumentBound: false,
});

async function blankEditor() {
  ed = await createHeadlessEditor();
  await ed.invoke("paged.file.new");
  await ed.idle();
  return ed;
}

describe("a replayed action is one undo unit [editor-shell.actions-batch]", () => {
  test("four writes from two commands undo with ONE Undo", async () => {
    const e = await blankEditor();
    registerWriter(e, "test.write.a", "A");
    registerWriter(e, "test.write.b", "B");
    const before = await swatchNames(e);
    const player = new ActionPlayer(
      action(["test.write.a", "test.write.b"]),
      playerDeps(e.registries.commands, e.client),
    );
    const s = await player.start();
    expect(s.status).toBe("done");
    expect(s.writes).toBe(4);
    expect(s.undoSteps).toBe(1);
    expect(await swatchNames(e)).toEqual([
      ...before,
      "A 1",
      "A 2",
      "B 1",
      "B 2",
    ]);
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(await swatchNames(e)).toEqual(before);
    // Redo brings the whole replay back, as one step too.
    await e.client.redo();
    expect(await swatchNames(e)).toEqual([
      ...before,
      "A 1",
      "A 2",
      "B 1",
      "B 2",
    ]);
  });

  test("a pause the user only looks at keeps it one step; an edit during it makes two", async () => {
    const e = await blankEditor();
    registerWriter(e, "test.write.a", "A");
    registerWriter(e, "test.write.b", "B");
    const before = await swatchNames(e);
    const deps = playerDeps(e.registries.commands, e.client);
    const quiet = new ActionPlayer(
      action(["test.write.a", "test.write.b"], 1),
      deps,
    );
    expect((await quiet.start()).status).toBe("paused");
    expect((await quiet.resume()).undoSteps).toBe(1);
    await e.invoke("paged.editor.undo");
    expect(await swatchNames(e)).toEqual(before);

    const edited = new ActionPlayer(
      action(["test.write.a", "test.write.b"], 1),
      deps,
    );
    await edited.start();
    await e.client.mutate(SWATCH("User", [0, 0, 10, 0]) as never);
    const s = await edited.resume();
    expect(s.undoSteps).toBe(2);
    // The user's own edit stays its own step between the two halves.
    await e.invoke("paged.editor.undo");
    expect(await swatchNames(e)).toEqual([...before, "A 1", "A 2", "User"]);
  });

  test("the client's undo group outside a player: a refused amend starts a new step, nothing is lost", async () => {
    const e = await blankEditor();
    const before = await swatchNames(e);
    e.client.beginUndoGroup();
    await e.client.mutate(SWATCH("G1", [1, 0, 0, 0]) as never);
    await e.client.undo(); // breaks the chain
    await e.client.mutate(SWATCH("G2", [2, 0, 0, 0]) as never);
    await e.client.mutate(SWATCH("G3", [3, 0, 0, 0]) as never);
    const r = await e.client.endUndoGroup();
    expect(r).toMatchObject({ steps: 2, writes: 3, joined: 1 });
    expect(await swatchNames(e)).toEqual([...before, "G2", "G3"]);
    await e.client.undo();
    expect(await swatchNames(e)).toEqual(before);
  });
});

describe("Batch over files [editor-shell.actions-batch]", () => {
  test("File ▸ Automate ▸ Batch… runs an action over two generated documents and exports each", async () => {
    covers("command:paged.actions.batch");
    const e = await blankEditor();
    expect(e.registries.commands.get(BATCH_COMMAND)).toBeDefined();
    // Two generated documents, each with a swatch naming it.
    const files: File[] = [];
    for (const name of ["Alpha", "Beta"]) {
      await e.invoke("paged.file.new");
      await e.client.mutate(SWATCH(name, [0, 0, 0, 50]) as never);
      files.push(
        new File([(await e.client.exportIdml()).slice()], `${name}.idml`),
      );
      e.client.markSaved();
    }
    registerWriter(e, "test.stamp", "Stamp");
    const out: Array<{ name: string; bytes: Uint8Array }> = [];
    const result = await runBatch(
      files,
      action(["test.stamp"]),
      "idml",
      appBatchDeps(e.editor as unknown as PagedEditor, {
        deliver: (name, bytes) => void out.push({ name, bytes }),
      }),
    );
    expect(
      result.log.map((l) => [l.file, l.ok, l.output, l.undoSteps]),
    ).toEqual([
      ["Alpha.idml", true, "Alpha.idml", 1],
      ["Beta.idml", true, "Beta.idml", 1],
    ]);
    // Each output is its own document with the action applied.
    for (const [i, name] of ["Alpha", "Beta"].entries()) {
      await e.load(out[i].bytes);
      const names = await swatchNames(e);
      expect(names).toContain(name);
      expect(names).toContain("Stamp 1");
      expect(names).toContain("Stamp 2");
      expect(names).not.toContain(i === 0 ? "Beta" : "Alpha");
    }
  });

  test("a file that is not a document is logged at the open stage and the batch goes on", async () => {
    const e = await blankEditor();
    await e.client.mutate(SWATCH("Only", [0, 0, 0, 50]) as never);
    const good = new File([(await e.client.exportIdml()).slice()], "good.idml");
    e.client.markSaved();
    registerWriter(e, "test.stamp", "Stamp");
    const result = await runBatch(
      [new File([new Uint8Array([1, 2, 3])], "junk.idml"), good],
      action(["test.stamp"]),
      "paged",
      appBatchDeps(e.editor as unknown as PagedEditor, { deliver: () => {} }),
    );
    expect(result.log[0]).toMatchObject({
      file: "junk.idml",
      ok: false,
      stage: "open",
    });
    expect(result.log[1]).toMatchObject({
      file: "good.idml",
      ok: true,
      output: "good.paged",
    });
  });
});

describe("run on import [editor-shell.actions-batch]", () => {
  test("the open path reports a finished document load to the import listeners", async () => {
    const e = await blankEditor();
    await e.client.mutate(SWATCH("X", [0, 0, 0, 50]) as never);
    const bytes = (await e.client.exportIdml()).slice();
    e.client.markSaved();
    const seen: ImportedFile[] = [];
    const off = onImported(e.editor.scope, (f) => void seen.push(f));
    await openFile(
      e.editor as unknown as PagedEditor,
      new File([bytes], "In.idml"),
      {
        setStatus: () => {},
        pushWarning: () => {},
      },
    );
    off();
    expect(seen).toEqual([{ name: "In.idml", via: "document" }]);
  });
});
