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

// Two Boa `paged.*` findings the scripting layer's own suite (paged-script,
// Rust) does not pin, asserted through the editor's script door on the
// real engine. Each expected failure sits next to the passing case that
// shows the behaviour it should have.

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

  // Finding SCR-13: the engine splits inserted text into paragraphs on
  // "\n" only (`insert_segments`, paged-canvas mutate.rs), so "\r", the
  // paragraph return of InDesign's own scripting and of every script
  // ported from it, lands in the story as a literal character. The
  // footnote and tracked-change paths already read "\r" as a break.
  test.failing(
    "SCR-13: a \\r in the text starts a new paragraph, as \\n does",
    async () => {
      covers("script:paged.insertText");
      const { e, story } = await withStory();
      await run(
        e,
        `console.log(paged.insertText(${JSON.stringify(story)}, 5, "A\\rB"))`,
      );
      expect(await paragraphs(e, story)).toEqual(["HelloA", "B"]);
    },
  );
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
