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

// The Color Guide's reads and write: the base is the first selected item's
// own fill as the document shows it; a chip paints the selection through a
// swatch named for its hex, found or created, in one batch.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import { applyGuideColor, readGuideBase } from "../../src/color-guide";

const A = { kind: "rectangle", id: "a" } as unknown as ElementId;
const B = { kind: "oval", id: "b" } as unknown as ElementId;

const fill = (value: string | null) => ({
  entries: [{ path: "frameFillColor", value: { type: "colorRef", value } }],
});

function reads(ref: string | null, hex = "#336699") {
  return {
    elementProperties: async () => fill(ref),
    send: async () => ({
      kind: "colorPreviewReply",
      payload: { result: { rgbHex: hex } },
    }),
    collection: async () => [],
  } as never;
}

describe("readGuideBase", () => {
  test("the first item's fill colour as shown", async () => {
    covers("panel:paged.color-wheel");
    expect(await readGuideBase(reads("Color/Blue"), [A])).toEqual([
      0x33, 0x66, 0x99,
    ]);
  });

  test("no selection, no fill, a gradient or None has no base", async () => {
    expect(await readGuideBase(reads("Color/Blue"), [])).toBeNull();
    expect(await readGuideBase(reads(null), [A])).toBeNull();
    expect(await readGuideBase(reads("Gradient/g1"), [A])).toBeNull();
    expect(await readGuideBase(reads("Swatch/None"), [A])).toBeNull();
  });
});

describe("applyGuideColor", () => {
  function writes(
    swatches: { selfId: string; name: string }[] = [],
    reply: unknown = { kind: "mutationApplied", payload: {} },
  ) {
    const sent: {
      args: { ops: { op: string; args: Record<string, unknown> }[] };
    }[] = [];
    return {
      sent,
      client: {
        collection: async () => swatches,
        mutate: async (m: unknown) => {
          sent.push(m as never);
          return reply;
        },
      } as never,
    };
  }

  test("a new colour creates its swatch and paints every selected item, in one batch", async () => {
    const w = writes();
    expect(
      await applyGuideColor(w.client, [A, B], [255, 0, 128], false),
    ).toBeNull();
    expect(w.sent).toHaveLength(1);
    const ops = w.sent[0]!.args.ops;
    expect(ops.map((o) => o.op)).toEqual([
      "createSwatch",
      "setElementProperty",
      "setElementProperty",
    ]);
    expect((ops[0]!.args.spec as { name: string }).name).toBe("#ff0080");
    expect(ops[1]!.args.path).toBe("frameFillColor");
    expect(ops[1]!.args.value).toEqual({
      type: "colorRef",
      value: "Color/guide-ff0080",
    });
  });

  test("a colour with a swatch reuses it; Alt strokes", async () => {
    const w = writes([{ selfId: "Color/u9", name: "#ff0080" }]);
    await applyGuideColor(w.client, [A], [255, 0, 128], true);
    const ops = w.sent[0]!.args.ops;
    expect(ops.map((o) => o.op)).toEqual(["setElementProperty"]);
    expect(ops[0]!.args.path).toBe("frameStrokeColor");
    expect(ops[0]!.args.value).toEqual({ type: "colorRef", value: "Color/u9" });
  });

  test("nothing selected sends nothing; the engine's refusal comes back in words", async () => {
    const none = writes();
    expect(await applyGuideColor(none.client, [], [1, 2, 3], false)).toBeNull();
    expect(none.sent).toEqual([]);
    const refused = writes([], {
      kind: "mutationFailed",
      payload: { error: "nope" },
    });
    expect(
      await applyGuideColor(refused.client, [A], [1, 2, 3], false),
    ).toContain("ope");
  });
});
