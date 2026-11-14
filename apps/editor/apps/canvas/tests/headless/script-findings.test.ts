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

// Boa `paged.*` findings the scripting layer's own suite (paged-script,
// Rust) does not pin, asserted through the editor's script door on the
// real engine. Each expected failure sits next to the passing case that
// shows the behaviour it should have. And `paged.relinkImage` (engine ADR
// 1308, protocol 81) through the same door: a missing link relinked to a
// picked file's bytes is one undo step.

import { afterEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { STRUCTURE, structureIdml } from "../../test/panels/support/structure";
import { createHeadlessEditor } from "./harness";

type Editor = Awaited<ReturnType<typeof createHeadlessEditor>>;

let ed: Editor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

/** Run a script; its last `console.log` line, parsed. */
async function run(e: Editor, source: string): Promise<unknown> {
  const out = await e.script(source);
  expect(out.error).toBeNull();
  const last = out.output.at(-1) ?? "null";
  return JSON.parse(last.replace(/^\[log\] /, ""));
}

/** A blank page with a text frame whose story holds "Hello"; its id. */
async function withStory(): Promise<{ e: Editor; story: string }> {
  const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
  const story = (await run(
    e,
    `const pid = JSON.parse(paged.pages())[0].selfId;
     paged.insertTextFrame(pid, [72, 72, 400, 400]);
     const sid = JSON.parse(paged.stories())[0].selfId;
     paged.insertText(sid, 0, "Hello");
     console.log(JSON.stringify(sid));`,
  )) as string;
  return { e, story };
}

const paragraphs = async (e: Editor, story: string) =>
  (
    (await e.dump()).stories[story] as {
      paragraphs: Array<{ runs: Array<{ text: string }> }>;
    }
  ).paragraphs.map((p) => p.runs.map((r) => r.text).join(""));

describe("paged.insertText and paragraph breaks", () => {
  test("a \\n in the text starts a new paragraph", async () => {
    covers("script:paged.insertText");
    const { e, story } = await withStory();
    await run(
      e,
      `console.log(paged.insertText(${JSON.stringify(story)}, 5, "A\\nB"))`,
    );
    expect(await paragraphs(e, story)).toEqual(["HelloA", "B"]);
  });

  // Finding SCR-13 (fixed, engine ADR 200): the engine split inserted text
  // into paragraphs on "\n" only, so "\r", the paragraph return of
  // InDesign's own scripting and of every script ported from it, landed in
  // the story as a literal character. "\r", "\r\n" and U+2029 start a
  // paragraph now, as on the footnote and tracked-change paths.
  test("SCR-13: a \\r in the text starts a new paragraph, as \\n does", async () => {
    covers("script:paged.insertText");
    const { e, story } = await withStory();
    await run(
      e,
      `console.log(paged.insertText(${JSON.stringify(story)}, 5, "A\\rB"))`,
    );
    expect(await paragraphs(e, story)).toEqual(["HelloA", "B"]);
  });
});

describe("paged.links and a link that does not resolve", () => {
  const status = async (e: Editor, frame: string) =>
    (
      (await run(e, "console.log(paged.links())")) as Array<{
        hostSelfId: string;
        status: string;
      }>
    ).find((l) => l.hostSelfId === frame)?.status ?? null;

  test("an imported image link to a missing file reports missing", async () => {
    covers("script:paged.links");
    const e = (ed = await createHeadlessEditor({ idml: structureIdml() }));
    expect(await status(e, STRUCTURE.imageFrame.id)).toBe("missing");
  });

  // Finding SCR-14 (fixed, engine ADR 198): `placeImage` sets only the
  // frame's link, and the build recorded a missing image only for a frame
  // that held a parsed <Image>, so a placed link that never resolved read
  // "ok". A link that resolves to nothing reads "missing" now, however it
  // was placed.
  test("SCR-14: an image placed from a file that does not exist reports its link missing", async () => {
    covers("script:paged.placeImage", "script:paged.links");
    const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
    const frame = (await run(
      e,
      `const pid = JSON.parse(paged.pages())[0].selfId;
         const f = paged.insertFrame(pid, [72, 72, 200, 200]);
         console.log(JSON.stringify(f.split(":").pop()));`,
    )) as string;
    // The bare id: the address `insertFrame` answers is refused (SCR-4).
    expect(
      await run(
        e,
        `console.log(paged.placeImage(${JSON.stringify(frame)}, "file:///no/such/image.png"))`,
      ),
    ).toBe(true);
    expect(await status(e, frame)).toBe("missing");
  });
});

describe("paged.relinkImage", () => {
  /** A 1×1 PNG, as the `number[]` of bytes `relinkImage` takes. */
  const PNG = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
    0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
    218, 99, 100, 96, 248, 95, 15, 0, 2, 135, 1, 128, 235, 71, 186, 146, 0, 0,
    0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ];
  const link = async (e: Editor, frame: string) =>
    (
      (await run(e, "console.log(paged.links())")) as Array<{
        hostSelfId: string;
        uri: string;
        status: string;
      }>
    ).find((l) => l.hostSelfId === frame) ?? null;

  test("a missing link relinked to a file's bytes draws, and one undo puts it back", async () => {
    covers("script:paged.relinkImage", "script:paged.links");
    const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
    const frame = (await run(
      e,
      `const pid = JSON.parse(paged.pages())[0].selfId;
         const f = paged.insertFrame(pid, [72, 72, 200, 200]);
         console.log(JSON.stringify(f.split(":").pop()));`,
    )) as string;
    expect(
      await run(
        e,
        `console.log(paged.placeImage(${JSON.stringify(frame)}, "file:///no/such/image.png"))`,
      ),
    ).toBe(true);
    expect(await link(e, frame)).toMatchObject({ status: "missing" });
    const before = await e.dumpJson();

    expect(
      await run(
        e,
        `console.log(paged.relinkImage(${JSON.stringify(frame)}, "file:///found.png", ${JSON.stringify(PNG)}))`,
      ),
    ).toBe(true);
    expect(await link(e, frame)).toMatchObject({
      uri: "file:///found.png",
      status: "ok",
    });

    // One undo: the missing link again, the model as it was.
    await e.invoke("paged.editor.undo");
    expect(await link(e, frame)).toMatchObject({
      uri: "file:///no/such/image.png",
      status: "missing",
    });
    expect(await e.dumpJson()).toBe(before);
  });

  test("a frame that is not there, or no frame at all, is refused and changes nothing", async () => {
    covers("script:paged.relinkImage");
    const e = (ed = await createHeadlessEditor({ blank: [612, 792] }));
    const before = await e.dumpJson();
    expect(
      await run(
        e,
        `console.log(paged.relinkImage("no-such-frame", "file:///found.png"))`,
      ),
    ).toBe(false);
    expect(await e.dumpJson()).toBe(before);
  });
});
