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

// Data ADR 566 — the workflow's six steps read from the session's facts,
// and the outlier finder's ranking over the bound fields' values.

import { describe, expect, it } from "bun:test";

import { findOutliers, overflowCandidates, ratioText } from "../src/outliers";
import { workflowStates } from "../src/workflow";

describe("the workflow's steps", () => {
  it("the first step not done is the current one", () => {
    expect(
      workflowStates({
        sources: 0,
        records: 0,
        bindings: 0,
        previewed: false,
        problems: null,
        published: false,
      }),
    ).toEqual({
      connect: "current",
      records: "todo",
      bind: "todo",
      preview: "todo",
      validate: "todo",
      publish: "todo",
    });
    expect(
      workflowStates({
        sources: 1,
        records: 12,
        bindings: 2,
        previewed: true,
        problems: 0,
        published: false,
      }),
    ).toMatchObject({
      connect: "done",
      preview: "done",
      validate: "done",
      publish: "current",
    });
  });

  it("validation that found problems asks for attention", () => {
    expect(
      workflowStates({
        sources: 1,
        records: 12,
        bindings: 2,
        previewed: true,
        problems: 3,
        published: false,
      }),
    ).toMatchObject({ validate: "attention", publish: "todo" });
  });
});

describe("the outlier finder", () => {
  const titles = [
    "Lamp",
    "Chair",
    "Desk",
    "Sofa",
    "",
    "An extraordinarily long product title that will not fit",
    "Rug",
  ];

  it("ranks missing values (by record), then the longest text, worst first", () => {
    const found = findOutliers([
      { bindingId: "b1", label: "title", kind: "text", values: titles },
      {
        bindingId: "b2",
        label: "price",
        kind: "text",
        values: ["9", "19", null, "29", "39", "49", "59"],
      },
    ]);
    expect(found.map((o) => [o.kind, o.field, o.record])).toEqual([
      ["missing", "price", 2],
      ["missing", "title", 4],
      ["long", "title", 5],
    ]);
    expect(found[2]).toMatchObject({ measure: 55, usual: 4 });
    expect(overflowCandidates(found)).toEqual([5]);
  });

  it("finds a picture whose proportions differ from the others'", () => {
    const found = findOutliers([
      {
        bindingId: "img",
        label: "photo",
        kind: "image",
        values: ["a", "b", "c", "d"],
        ratios: [1.5, 1.5, 1.49, 0.5],
      },
    ]);
    expect(found).toEqual([
      expect.objectContaining({ kind: "ratio", record: 3, measure: 0.5 }),
    ]);
    expect(ratioText(1.5)).toBe("3:2");
    expect(ratioText(0.5)).toBe("1:2");
    expect(ratioText(1.85)).toBe("1.85:1");
  });

  it("records that overflow when rendered come first; nothing stands out reads empty", () => {
    const found = findOutliers(
      [{ bindingId: "b1", label: "title", kind: "text", values: titles }],
      [5],
    );
    expect(found[0]).toMatchObject({ kind: "overflow", record: 5 });
    expect(
      findOutliers([
        { bindingId: "b", label: "t", kind: "text", values: ["ab", "cd"] },
      ]),
    ).toEqual([]);
  });
});
