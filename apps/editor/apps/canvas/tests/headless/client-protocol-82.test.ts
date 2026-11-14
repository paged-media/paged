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

// Protocol 82 through the editor's client, on the real engine: Document
// X-Ray (engine ADR 1307) and the line evidence with its preview (engine
// ADR 1308). Both are reads; a preview leaves the document, its history
// and its revision as they were.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { XRAY, xrayFixture } from "../e2e/harness/xray-idml";
import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

describe("protocol 82 through the client", () => {
  test("explain answers the style cascade, the lock and the overset from the model @feat:styles.cascade @level:happy", async () => {
    covers("command:paged.view.toggleXray");
    ed = await createHeadlessEditor({ idml: xrayFixture() });
    const depth = (await ed.client.undoLog()).undoLen;
    const text = await ed.client.explain(
      {
        kind: "storyRange",
        id: { story_id: XRAY.text.story, start: 0, end: 0 },
      } as never,
      {
        selection: {
          storyId: XRAY.text.story,
          start: 3,
          end: 3,
          affinity: false,
        } as never,
      },
    );
    const fill = text.text!.properties.find((p) => p.property === "fillColor")!;
    expect(fill.value).toBe("Color/Red");
    expect(fill.source).toMatchObject({ kind: "style", depth: 0 });
    const box = await ed.client.explain({
      kind: "rectangle",
      id: XRAY.locked,
    } as never);
    expect(box.lock.reasons).toEqual([{ kind: "item" }]);
    const thread = await ed.client.explain({
      kind: "textFrame",
      id: XRAY.thread.last,
    } as never);
    expect(thread.flow!.overset).toBe(true);
    expect((await ed.client.undoLog()).undoLen).toBe(depth);
  });

  test("line evidence and a preview that changes nothing; the write is one step @feat:typography.knuth-plass @level:happy", async () => {
    covers("command:paged.view.toggleTypographyDebugger");
    ed = await createHeadlessEditor({ idml: xrayFixture() });
    const story = XRAY.justified.story;
    const before = await ed.client.lineEvidence({ story });
    expect(before.lines.length).toBeGreaterThan(3);
    const depth = (await ed.client.undoLog()).undoLen;
    const write = {
      op: "setElementProperty",
      args: {
        elementId: {
          kind: "storyRange",
          id: { story_id: story, start: 0, end: 200 },
        },
        path: "characterTracking",
        value: { type: "length", value: -60 },
      },
    } as never;
    const preview = await ed.client.lineEvidence({ story, preview: write });
    expect(preview.preview).toBe(true);
    expect(preview.revision).toBe(before.revision);
    expect((await ed.client.undoLog()).undoLen).toBe(depth);
    expect(await ed.client.lineEvidence({ story })).toEqual(before);
    await ed.client.mutate(write);
    expect((await ed.client.undoLog()).undoLen).toBe(depth + 1);
    const applied = await ed.client.lineEvidence({ story });
    expect(applied.lines.map((l) => l.end)).toEqual(
      preview.lines.map((l) => l.end),
    );
  });
});
