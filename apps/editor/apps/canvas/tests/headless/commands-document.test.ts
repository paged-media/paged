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

// The document-level commands against the real engine: File ▸ New and
// File ▸ Open… (with the discard prompt), the swatch library in and out
// (.ase), Undo / Redo, Select all, Align, and New from a brief. Each is
// the app's own command builder registered in the headless editor.

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildExportAseCommand,
  buildImportAseCommand,
  buildOpenIdmlCommand,
} from "@paged-media/shell";
import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
  stubGlobal,
  unstubAllGlobals,
} from "@paged-media/test-kit";
import { dumpDiff, elementKey } from "@paged-media/test-kit/headless";

import { addressOfElement } from "../../src/object-model";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  unstubAllGlobals();
  await ed?.dispose();
  ed = null;
});

const targets = async () =>
  (ed = await createHeadlessEditor({ idml: gestureFixture("targets") }));

/** Make the open document dirty (one real edit). */
async function edit(e: HeadlessEditor) {
  await e.select([T.frame.id]);
  await e.invoke("paged.object.delete");
  await e.idle();
}

/** An Adobe Swatch Exchange file with one RGB swatch per entry. */
function ase(colors: Array<{ name: string; rgb: [number, number, number] }>) {
  const blocks = colors.map(({ name, rgb }) => {
    const chars = [...name].map((c) => c.charCodeAt(0));
    const len = 2 + (chars.length + 1) * 2 + 4 + 12 + 2;
    const b = new DataView(new ArrayBuffer(6 + len));
    let o = 0;
    b.setUint16(o, 0x0001);
    o += 2;
    b.setUint32(o, len);
    o += 4;
    b.setUint16(o, chars.length + 1);
    o += 2;
    for (const c of chars) {
      b.setUint16(o, c);
      o += 2;
    }
    o += 2; // the name's terminating NUL
    for (const ch of "RGB ") b.setUint8(o++, ch.charCodeAt(0));
    for (const v of rgb) {
      b.setFloat32(o, v);
      o += 4;
    }
    b.setUint16(o, 2); // normal (not global, not spot)
    return new Uint8Array(b.buffer);
  });
  const head = new DataView(new ArrayBuffer(12));
  for (const [i, ch] of [..."ASEF"].entries())
    head.setUint8(i, ch.charCodeAt(0));
  head.setUint16(4, 1);
  head.setUint16(6, 0);
  head.setUint32(8, blocks.length);
  const out = new Uint8Array(12 + blocks.reduce((n, b) => n + b.length, 0));
  out.set(new Uint8Array(head.buffer), 0);
  let at = 12;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

describe("File ▸ New (paged.file.new)", () => {
  test("replaces the document with one blank page", async () => {
    covers("command:paged.file.new");
    const e = await targets();
    await e.invoke("paged.file.new");
    await e.idle();
    expect(e.state.document.handle?.pageCount).toBe(1);
    const dump = await e.dump();
    expect(Object.keys(dump.elements)).toEqual([]);
    expect(e.state.document.snapshotsReady).toBe(true);
  });

  test("an edited document is kept when the discard prompt is declined, replaced when accepted", async () => {
    covers("command:paged.file.new");
    const e = await targets();
    await edit(e);
    const prompts: string[] = [];
    stubGlobal("confirm", (m: string) => (prompts.push(m), false));
    const kept = await e.dump();
    await e.invoke("paged.file.new");
    await e.idle();
    expect(prompts).toHaveLength(1);
    expect(dumpDiff(kept, await e.dump())).toEqual([]);
    stubGlobal("confirm", (m: string) => (prompts.push(m), true));
    await e.invoke("paged.file.new");
    await e.idle();
    expect(prompts).toHaveLength(2);
    expect(e.state.document.handle?.pageCount).toBe(1);
  });
});

describe("File ▸ Open… (paged.file.openIdml)", () => {
  function register(e: HeadlessEditor, file: File | null) {
    const status: string[] = [];
    e.registries.commands.register(
      buildOpenIdmlCommand({
        pickFile: async () => file,
        setStatus: (s) => void status.push(s),
        pushWarning: () => {},
      }),
    );
    return status;
  }

  test("opens the picked IDML as the document", async () => {
    covers("command:paged.file.openIdml");
    ed = await createHeadlessEditor({ blank: [300, 300] });
    const status = register(
      ed,
      new File([gestureFixture("targets").slice()], "Targets.idml"),
    );
    await ed.invoke("paged.file.openIdml");
    await ed.idle();
    expect(ed.state.document.handle?.pageIds).toEqual([
      T.pageId,
      T.secondPageId,
    ]);
    expect(ed.state.document.sourceName).toBe("Targets");
    expect(Object.keys((await ed.dump()).elements)).toContain(
      elementKey(T.frame.id),
    );
    expect(status.at(-1)).toBe("loaded 2 pages");
  });

  test("an edited document is not replaced when the prompt is declined", async () => {
    covers("command:paged.file.openIdml");
    const e = await targets();
    await edit(e);
    register(e, new File([gestureFixture("paths").slice()], "Paths.idml"));
    stubGlobal("confirm", () => false);
    const kept = await e.dump();
    await e.invoke("paged.file.openIdml");
    await e.idle();
    expect(dumpDiff(kept, await e.dump())).toEqual([]);
  });

  test("bytes that are no IDML fail the open and keep the document", async () => {
    covers("command:paged.file.openIdml");
    const e = await targets();
    const status = register(
      e,
      new File([new Uint8Array([1, 2, 3])], "broken.idml"),
    );
    const kept = await e.dump();
    await e.invoke("paged.file.openIdml");
    await e.idle();
    expect(status.at(-1)).toMatch(/^load failed: /);
    expect(dumpDiff(kept, await e.dump())).toEqual([]);
  });
});

describe("the swatch library (.ase)", () => {
  test("Import swatches adds the file's swatches as ONE undo step", async () => {
    covers("command:paged.library.importAse");
    const e = await targets();
    e.registries.commands.unregister("paged.library.importAse");
    const status: string[] = [];
    e.registries.commands.register(
      buildImportAseCommand({
        pickFile: async () =>
          new File(
            [
              ase([
                { name: "Brand Red", rgb: [0.9, 0.1, 0.1] },
                { name: "Brand Blue", rgb: [0.1, 0.2, 0.8] },
              ]),
            ],
            "Brand.ase",
          ),
        setStatus: (s) => void status.push(s),
      }),
    );
    const before = await e.dump();
    await e.invoke("paged.library.importAse");
    await e.idle();
    expect(status).toEqual(["imported swatch library “Brand”"]);
    const names = (d: typeof before) =>
      (d.collections.swatches as Array<{ name: string }>).map((s) => s.name);
    expect(names(await e.dump())).toEqual(
      expect.arrayContaining([...names(before), "Brand Red", "Brand Blue"]),
    );
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("Save swatches downloads the document's swatches as an .ase", async () => {
    covers("command:paged.library.exportAse");
    const e = await targets();
    const downloads: Array<{ name: string; bytes: Uint8Array }> = [];
    const blobs = new Map<string, Blob>();
    stubGlobal("document", {
      createElement: () => {
        const a = {
          href: "",
          download: "",
          click: async () =>
            downloads.push({
              name: a.download,
              bytes: new Uint8Array(await blobs.get(a.href)!.arrayBuffer()),
            }),
        };
        return a;
      },
    });
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (b: Blob) => {
      const url = `blob:${blobs.size}`;
      blobs.set(url, b);
      return url;
    };
    URL.revokeObjectURL = () => {};
    try {
      e.registries.commands.unregister("paged.library.exportAse");
      e.registries.commands.register(
        buildExportAseCommand({ setStatus: () => {} }),
      );
      const before = await e.dump();
      await e.invoke("paged.library.exportAse");
      await new Promise((r) => setTimeout(r, 0));
      expect(downloads).toHaveLength(1);
      expect(downloads[0].name).toBe("swatches.ase");
      expect(String.fromCharCode(...downloads[0].bytes.slice(0, 4))).toBe(
        "ASEF",
      );
      expect(dumpDiff(before, await e.dump())).toEqual([]);
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });
});

describe("Undo and Redo (paged.editor.undo / paged.editor.redo)", () => {
  test("undo takes the last edit back, redo puts it again, each one step", async () => {
    covers("command:paged.editor.undo", "command:paged.editor.redo");
    const e = await targets();
    const before = await e.dump();
    await edit(e);
    const after = await e.dump();
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    await e.invoke("paged.editor.redo");
    await e.idle();
    expect(dumpDiff(after, await e.dump())).toEqual([]);
  });

  test("with nothing to undo or redo, the document is untouched", async () => {
    covers("command:paged.editor.undo", "command:paged.editor.redo");
    const e = await targets();
    const before = await e.dump();
    await e.invoke("paged.editor.undo");
    await e.invoke("paged.editor.redo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });
});

describe("Select all (paged.edit.selectAll)", () => {
  test("selects every top-level item of the spread in view and changes nothing", async () => {
    covers("command:paged.edit.selectAll");
    const e = await targets();
    const before = await e.dump();
    await e.invoke("paged.edit.selectAll");
    await e.idle();
    expect(e.state.selection.elementSelection.map(elementKey).sort()).toEqual(
      [T.frame.id, T.group.id, T.rotated.id, T.locked.id, T.path.id]
        .map(elementKey)
        .sort(),
    );
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("with no document it does not apply", async () => {
    covers("command:paged.edit.selectAll");
    ed = await createHeadlessEditor();
    expect(await ed.invoke("paged.edit.selectAll")).toBeUndefined();
    expect(ed.state.selection.elementSelection).toEqual([]);
  });
});

describe("Align (paged.align.objects)", () => {
  test("align top moves the objects to the topmost edge in ONE undo step", async () => {
    covers("command:paged.align.objects");
    const e = await targets();
    const before = await e.dump();
    const frame = addressOfElement(T.frame.id as never);
    const locked = addressOfElement(T.locked.id as never);
    const second = addressOfElement(T.path.id as never);
    const result = await e.invoke("paged.align.objects", {
      kind: "top",
      targets: [frame, second],
    });
    await e.idle();
    expect(result).toMatchObject({ applied: true, undoSteps: 1 });
    expect(dumpDiff(before, await e.dump()).length).toBeGreaterThan(0);
    await e.invoke("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    // A locked frame is not moved: the batch is refused whole.
    const refused = await e
      .invoke("paged.align.objects", { kind: "left", targets: [frame, locked] })
      .catch((err: unknown) => ({ error: String(err) }));
    await e.idle();
    expect(refused).not.toMatchObject({ applied: true, undoSteps: 1 });
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("a payload that does not match the declared arguments is refused", async () => {
    covers("command:paged.align.objects");
    const e = await targets();
    await expect(
      e.invoke("paged.align.objects", { kind: "diagonal", targets: [] }),
    ).rejects.toThrow(/^invalidValue: paged\.align\.objects/);
  });
});

describe("New from a brief (paged.file.newFromBrief)", () => {
  test("opens the assistant; the document is untouched", async () => {
    covers("command:paged.file.newFromBrief");
    const e = await targets();
    const before = await e.dump();
    await e.invoke("paged.file.newFromBrief");
    expect(e.opened).toContainEqual({ kind: "assistant" });
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });
});
