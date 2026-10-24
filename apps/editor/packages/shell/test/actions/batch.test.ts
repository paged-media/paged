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

// WP4.11 — Batch over files: open, play (stops passed by), export in the
// chosen format, deliver under the file's name, and an honest log when a
// file fails at any stage. Two GENERATED documents stand in for a picked
// folder; the "editor" here is a model of one open document.

import { describe, expect, test } from "bun:test";

import {
  batchOutputName,
  runBatch,
  stopStep,
  type BatchDeps,
  type PagedAction,
} from "../../src/actions";

interface Doc {
  name: string;
  body: string;
}

const ACTION: PagedAction = {
  id: "a1",
  name: "Stamp",
  createdAt: 0,
  steps: [
    { command: "test.stamp", title: "Stamp", verdict: "contextual" },
    stopStep("Look at it"),
    { command: "test.upper", title: "Upper", verdict: "contextual" },
  ],
  uncaptured: { gestures: 0, directEdits: 0 },
  includeDocumentBound: false,
};

function editor(files: Doc[], failOpen: string[] = []) {
  let open: Doc | null = null;
  const delivered: Array<{ name: string; text: string }> = [];
  const deps: BatchDeps<Doc> = {
    async open(file) {
      if (failOpen.includes(file.name)) throw new Error("not a document");
      open = { ...files.find((f) => f.name === file.name)! };
    },
    player: {
      async invoke(id) {
        if (!open) throw new Error("no document");
        if (id === "test.stamp") open.body += " [stamped]";
        if (id === "test.upper") open.body = open.body.toUpperCase();
      },
    },
    async exportAs(format) {
      return new TextEncoder().encode(`${format}:${open!.body}`);
    },
    deliver(name, bytes) {
      delivered.push({ name, text: new TextDecoder().decode(bytes) });
    },
    afterFile() {
      open = null;
    },
  };
  return { deps, delivered };
}

describe("runBatch [editor-shell.actions-batch]", () => {
  test("names the output after the input, in the chosen format", () => {
    expect(batchOutputName("Annual Report.idml", "pdf")).toBe(
      "Annual Report.pdf",
    );
    expect(batchOutputName("dir/a.b.paged", "idml")).toBe("a.b.idml");
    expect(batchOutputName("noext", "paged")).toBe("noext.paged");
  });

  test("runs the action over two generated documents and delivers each", async () => {
    const files = [
      { name: "one.idml", body: "first" },
      { name: "two.idml", body: "second" },
    ];
    const ed = editor(files);
    const progress: number[] = [];
    const r = await runBatch(files, ACTION, "pdf", ed.deps, {
      onProgress: (p) => progress.push(p.done),
    });
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(0);
    expect(ed.delivered).toEqual([
      { name: "one.pdf", text: "pdf:FIRST [STAMPED]" },
      { name: "two.pdf", text: "pdf:SECOND [STAMPED]" },
    ]);
    // The stop was passed by (nobody to answer it) and logged.
    expect(r.log[0].passedStops).toEqual(["Look at it"]);
    expect(r.log[0].ran).toBe(2);
    expect(progress).toEqual([0, 1, 2]);
  });

  test("a file that fails to open is logged with its stage, and the batch goes on", async () => {
    const files = [
      { name: "bad.idml", body: "" },
      { name: "good.idml", body: "ok" },
    ];
    const ed = editor(files, ["bad.idml"]);
    const r = await runBatch(files, ACTION, "idml", ed.deps);
    expect(r.log[0]).toMatchObject({
      file: "bad.idml",
      ok: false,
      stage: "open",
      error: "not a document",
    });
    expect(r.log[1]).toMatchObject({ ok: true, output: "good.idml" });
    expect(r.failed).toBe(1);
  });

  test("an export failure is the export stage's, not a silent skip", async () => {
    const files = [{ name: "x.idml", body: "x" }];
    const ed = editor(files);
    ed.deps.exportAs = async () => {
      throw new Error("pdf writer refused");
    };
    const r = await runBatch(files, ACTION, "pdf", ed.deps);
    expect(r.log[0]).toMatchObject({
      stage: "export",
      error: "pdf writer refused",
    });
    expect(ed.delivered).toEqual([]);
  });

  test("a cancelled batch stops before the next file", async () => {
    const files = [
      { name: "a.idml", body: "a" },
      { name: "b.idml", body: "b" },
    ];
    const ed = editor(files);
    const signal = { aborted: false };
    const r = await runBatch(files, ACTION, "paged", ed.deps, {
      signal,
      onLog: () => {
        signal.aborted = true;
      },
    });
    expect(r.cancelled).toBe(true);
    expect(r.log).toHaveLength(1);
  });
});
