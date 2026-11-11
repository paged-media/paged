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

// Engine ADR 1096 — the Word shapes' frames read back for the save: the
// skeleton's frame ids (a shape with line ends is a group whose first
// child carries the outline) and each frame's live preset and outline.

import { describe, expect, it } from "bun:test";

import { shapeFrameIds, shapeFrameOf } from "../src/save-structure";

describe("Word shapes read back for the save [doc.shapes]", () => {
  it("names the skeleton's outline frames in mint order", () => {
    const ir = {
      story: {
        blocks: [
          { kind: "paragraph", shapes: [{}, { heads: [{}] }] },
          { kind: "table", cells: [{ paragraphs: [{ shapes: [{}] }] }] },
          { kind: "paragraph" },
          { kind: "paragraph", shapes: [{ heads: [] }] },
        ],
      },
    } as never;
    expect(shapeFrameIds(ir)).toEqual([
      "docx_shape0",
      "docx_shape1_0",
      "docx_shape2",
      "docx_shape3",
    ]);
  });

  it("reads a frame's preset and outline, and nothing without an outline", () => {
    const corner = (x: number, y: number) => ({
      anchor: [x, y],
      left: [x, y],
      right: [x, y],
    });
    const preset = { name: "roundRect", frame: [0, 0, 10, 5], handles: [] };
    const entries = [
      {
        path: "framePath",
        value: {
          type: "framePath",
          value: { anchors: [corner(0, 0), corner(10, 5)], subpathStarts: [0] },
        },
      },
      {
        path: "frameShapePreset",
        value: { type: "text", value: JSON.stringify(preset) },
      },
    ];
    expect(shapeFrameOf("docx_shape0", entries)).toEqual({
      frameId: "docx_shape0",
      preset,
      anchors: [
        [0, 0, 0, 0, 0, 0],
        [10, 5, 10, 5, 10, 5],
      ],
      starts: [0],
    });
    // Not live: no preset read, the outline still is.
    const unread = shapeFrameOf("docx_shape0", [
      entries[0]!,
      { path: "frameShapePreset", value: { type: "text", value: "" } },
    ]);
    expect(unread?.preset).toBeUndefined();
    expect(shapeFrameOf("docx_shape0", [])).toBeNull();
  });
});
