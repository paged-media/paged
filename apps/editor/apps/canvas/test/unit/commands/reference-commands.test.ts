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

// `paged.insert.footnote` / `endnote` / `bookmark` / `crossReference` /
// `indexEntry`: the host's reference inserts over a recording client. Each
// writes one engine op at the caret; a bare form command opens its panel;
// a missing caret is reported in words.

import { describe, expect, test } from "bun:test";

import { REFERENCE_INSERT_COMMANDS } from "@paged-media/helpers";
import { covers } from "@paged-media/test-kit";

import {
  buildReferenceCommands,
  REFERENCE_ENTRIES,
  REFERENCE_MENU_ITEMS,
  type ReferenceDeps,
} from "../../../src/reference-commands";

function rig(caret = true) {
  const sent: unknown[] = [];
  const opened: string[] = [];
  const reports: string[] = [];
  const deps: ReferenceDeps = {
    client: {
      send: (async () => ({
        kind: "storyContentResult",
        payload: {
          content: { paragraphs: [{ runs: [{ text: "Alpha beta" }] }] },
        },
      })) as never,
      mutate: (async (m: unknown) => {
        sent.push(m);
        return { kind: "mutationApplied", payload: {} };
      }) as never,
    },
    getSelection: () => (caret ? { storyId: "s1", start: 5, end: 5 } : null),
  };
  const commands = buildReferenceCommands(
    deps,
    (id) => opened.push(id),
    (m) => reports.push(m),
    () => {},
  );
  const run = (id: string, payload?: unknown) =>
    commands.find((c) => c.id === id)!.handler({} as never, payload);
  return { sent, opened, reports, run, commands };
}

describe("the reference inserts", () => {
  test("each kind writes one engine op at the caret", async () => {
    covers(
      "command:paged.insert.footnote",
      "command:paged.insert.endnote",
      "command:paged.insert.bookmark",
      "command:paged.insert.crossReference",
      "command:paged.insert.indexEntry",
    );
    const { sent, run } = rig();
    await run("paged.insert.footnote");
    await run("paged.insert.bookmark", { name: "Here" });
    await run("paged.insert.crossReference", {
      bookmark: "Here",
      referTo: "aboveBelow",
    });
    await run("paged.insert.indexEntry", { topic: ["Alpha"] });
    expect((sent as { op: string }[]).map((m) => m.op)).toEqual([
      "insertFootnote",
      "insertTextAnchor",
      "insertCrossReference",
      "insertIndexMarker",
    ]);
    expect((sent[0] as { args: unknown }).args).toEqual({
      storyId: "s1",
      offset: 5,
      text: "",
    });
  });

  test("a bare form command opens its panel; no caret is reported", async () => {
    const { opened, run, sent } = rig();
    await run("paged.insert.bookmark");
    await run("paged.insert.crossReference");
    await run("paged.insert.indexEntry");
    expect(opened).toEqual([
      "paged.cross-references",
      "paged.cross-references",
      "paged.index",
    ]);
    expect(sent).toEqual([]);
    const none = rig(false);
    await none.run("paged.insert.endnote");
    expect(none.reports).toEqual(["no caret"]);
  });

  test("the spelled-out ids are the shared ones", () => {
    expect(
      Object.fromEntries(REFERENCE_ENTRIES.map((e) => [e.kind, e.id])),
    ).toEqual({ ...REFERENCE_INSERT_COMMANDS });
  });

  test("the Type menu lists them", () => {
    expect(REFERENCE_MENU_ITEMS.map((m) => m.path)).toEqual([
      "Type/Insert footnote",
      "Type/Insert endnote",
      "Type/Insert bookmark…",
      "Type/Insert cross-reference…",
      "Type/New index entry…",
    ]);
  });
});
