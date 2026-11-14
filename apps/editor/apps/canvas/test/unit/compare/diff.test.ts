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

// What differs between two states of a document (editor ADRs 1234 and
// 1235): the pixels of a page, cell by cell, merged into boxes; and the
// engine's facts — frames moved, reshaped, restyled, added or removed,
// pictures substituted, text and formatting, style definitions.
// Deterministic.

import { describe, expect, test } from "bun:test";

import {
  diffStates,
  isEmptyDiff,
  pixelDiff,
  readStateFacts,
  type StateFacts,
} from "../../../src/compare/diff";

function state(
  items: Array<[string, string, string?]>,
  more: Partial<Omit<StateFacts, "items">> = {},
): StateFacts {
  return {
    items: new Map(
      items.map(([id, box, look]) => [
        id,
        { kind: "rectangle", page: "p1", box, ...(look ? { look } : {}) },
      ]),
    ),
    links: more.links ?? new Map(),
    stories: more.stories ?? new Map(),
    styles: more.styles ?? new Map(),
  };
}

describe("the items that differ", () => {
  test("frames moved, reshaped, restyled, added and removed; a picture substituted; text, formatting and styles", () => {
    const before = state(
      [
        ["a", "0,0,100,50"],
        ["b", "0,0,100,50"],
        ["c", "0,0,100,50", "red"],
        ["gone", "0,0,10,10"],
        ["same", "5,5,10,10", "blue"],
      ],
      {
        links: new Map([["pic", "file:///photo-1.jpg"]]),
        stories: new Map([
          ["s1", { text: "Hello", format: "[12]" }],
          ["s2", { text: "Same", format: "[12]" }],
          ["s3", { text: "Kept", format: "[12]" }],
        ]),
        styles: new Map([
          ["paragraph: Heading", "24"],
          ["paragraph: Body", "10"],
        ]),
      },
    );
    const after = state(
      [
        ["a", "30,0,100,50"],
        ["b", "0,0,140,50"],
        ["c", "0,0,100,50", "black"],
        ["new", "0,0,10,10"],
        ["same", "5,5,10,10", "blue"],
      ],
      {
        links: new Map([["pic", "file:///photo-2.jpg"]]),
        stories: new Map([
          ["s1", { text: "Hello world", format: "[12]" }],
          ["s2", { text: "Same", format: "[14]" }],
          ["s3", { text: "Kept", format: "[12]" }],
        ]),
        styles: new Map([
          ["paragraph: Heading", "28"],
          ["paragraph: Body", "10"],
        ]),
      },
    );
    const d = diffStates(before, after);
    expect(d.items).toEqual([
      { id: "a", kind: "rectangle", change: "moved" },
      { id: "b", kind: "rectangle", change: "reshaped" },
      { id: "c", kind: "rectangle", change: "restyled" },
      { id: "gone", kind: "rectangle", change: "removed" },
      { id: "new", kind: "rectangle", change: "added" },
    ]);
    expect(d.substitutions).toEqual([
      { frame: "pic", from: "file:///photo-1.jpg", to: "file:///photo-2.jpg" },
    ]);
    expect(d.stories).toEqual([
      { story: "s1", change: "text" },
      { story: "s2", change: "formatting" },
    ]);
    expect(d.styles).toEqual(["paragraph: Heading"]);
    expect(isEmptyDiff(diffStates(before, before))).toBe(true);
  });

  test("the facts are what the engine reports: boxes on the page through the item's transform", async () => {
    const client = {
      sceneTree: async () => [
        {
          kind: "page",
          label: "p",
          children: [
            { id: { kind: "rectangle", id: "r1" }, kind: "rect", label: "r" },
          ],
        },
      ],
      elementGeometry: async () => [
        {
          id: { kind: "rectangle", id: "r1" },
          pageId: "p1",
          bounds: [10, 20, 30, 60],
          itemTransform: [1, 0, 0, 1, 100, 50],
        },
      ],
      elementProperties: async () => ({
        entries: [
          { path: "frameFillColor", value: { type: "colorRef", value: "Red" } },
          {
            path: "frameBounds",
            value: { type: "bounds", value: [0, 0, 1, 1] },
          },
        ],
      }),
      collection: async (name: string) =>
        name === "links"
          ? [{ hostSelfId: "r1", uri: "file:///a.png" }]
          : name === "stories"
            ? [{ selfId: "s1" }]
            : name === "paragraphStyles"
              ? [{ selfId: "ParagraphStyle/H", name: "H" }]
              : [],
      send: async (m: { kind: string }) =>
        m.kind === "requestStoryContent"
          ? {
              kind: "storyContentResult",
              payload: {
                content: {
                  selfId: "s1",
                  paragraphs: [
                    {
                      paragraphStyle: "Body",
                      runs: [{ text: "Hi", pointSize: 12 }],
                    },
                  ],
                },
              },
            }
          : {
              kind: "styleProperties",
              payload: {
                result: {
                  collection: "paragraphStyles",
                  styleId: "ParagraphStyle/H",
                  basedOn: null,
                  entries: [],
                },
              },
            },
    };
    const facts = await readStateFacts(client as never);
    expect(facts.items.get("r1")).toEqual({
      kind: "rectangle",
      page: "p1",
      box: "120,60,40,20",
      look: '[["frameFillColor",{"type":"colorRef","value":"Red"}]]',
    });
    expect(facts.links.get("r1")).toBe("file:///a.png");
    expect(facts.stories.get("s1")?.text).toBe("Hi");
    expect(facts.stories.get("s1")?.format).toBe(
      '[["Body",[{"pointSize":12}]]]',
    );
    expect([...facts.styles.keys()]).toEqual(["paragraph: H"]);
  });
});

describe("the pixels that differ", () => {
  const image = (
    w: number,
    h: number,
    paint?: (x: number, y: number) => boolean,
  ) => {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (paint?.(x, y)) data.set([0, 0, 0, 255], (y * w + x) * 4);
    return { width: w, height: h, data };
  };

  test("unchanged pages have no boxes; changed regions are boxed as fractions of the page", () => {
    const a = image(64, 64);
    expect(pixelDiff(a, image(64, 64))).toEqual([]);
    const b = image(64, 64, (x, y) => x >= 16 && x < 32 && y >= 8 && y < 16);
    expect(pixelDiff(a, b)).toEqual([{ x: 0.25, y: 0.125, w: 0.25, h: 0.125 }]);
    const c = image(64, 64, (x, y) => (x < 8 && y < 8) || (x >= 56 && y >= 56));
    expect(pixelDiff(a, c)).toHaveLength(2);
    expect(pixelDiff(a, image(32, 64))).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });
});
