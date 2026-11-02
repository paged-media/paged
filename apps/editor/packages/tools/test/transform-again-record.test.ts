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

// Transform Again's memory: the Rotate / Scale / Shear tools commit an
// engine gesture that reports no angle or factor, so what the drag did is
// read back as the linear part of the first target's transform change and
// remembered (`@paged-media/helpers`) for `paged.transform.again`.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import {
  createEditorScope,
  scopeOf,
  TRANSFORM_MEMORY,
  type PagedEditor,
} from "@paged-media/shell";

import {
  createRotateHandler,
  recordTransformOf,
} from "../src/handlers/transform-tools";
import { harness } from "./support";

const FRAME = { kind: "rectangle", id: "r1" } as ElementId;

const pagedAnswering = (itemTransform: number[] | null) =>
  ({
    scope: createEditorScope(),
    client: {
      elementGeometry: async () => [
        { id: FRAME, bounds: [0, 0, 1, 1], itemTransform },
      ],
    },
  }) as unknown as PagedEditor;

const lastOf = (paged: PagedEditor) =>
  (paged as unknown as { scope: ReturnType<typeof createEditorScope> }).scope
    .get(TRANSFORM_MEMORY)
    .last();

describe("recordTransformOf", () => {
  it("remembers the linear part of what a drag changed, whatever its pivot", async () => {
    // A half turn about some pivot, after the item had moved by (40, 50).
    const paged = pagedAnswering([-1, 0, 0, -1, 260, 150]);
    await recordTransformOf(
      paged,
      FRAME,
      Promise.resolve([1, 0, 0, 1, 40, 50]),
    );
    expect(lastOf(paged)).toEqual({
      kind: "linear",
      linear: [-1, 0, 0, -1],
      copy: false,
    });
  });

  it("a scale reads as the scale", async () => {
    const paged = pagedAnswering([2, 0, 0, 3, 10, 10]);
    await recordTransformOf(paged, FRAME, Promise.resolve(null));
    expect(lastOf(paged)).toMatchObject({ linear: [2, 0, 0, 3] });
  });

  it("a drag that changed nothing, or an unreadable item, remembers nothing", async () => {
    const moved = pagedAnswering([1, 0, 0, 1, 90, 5]);
    await recordTransformOf(moved, FRAME, Promise.resolve([1, 0, 0, 1, 5, 5]));
    const unreadable = pagedAnswering(null);
    await recordTransformOf(unreadable, FRAME, Promise.resolve(null));
    await recordTransformOf(unreadable, undefined, Promise.resolve(null));
    expect(lastOf(moved)).toBeNull();
    expect(lastOf(unreadable)).toBeNull();
  });
});

describe("the Rotate tool", () => {
  it("a committed drag that moved nothing in the document leaves the memory empty @level:gesture", async () => {
    const { g } = harness({
      selection: [FRAME],
      geometry: (id) => ({ id, bounds: [0, 0, 10, 10] }),
    });
    await g
      .tool(createRotateHandler)
      .drag({ from: [200, 200], to: [260, 230], steps: 3 })
      .settle();
    await new Promise((r) => setTimeout(r, 0));
    expect(scopeOf(undefined).get(TRANSFORM_MEMORY).last()).toBeNull();
  });
});
