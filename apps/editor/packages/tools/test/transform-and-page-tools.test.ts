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

// The worker-gesture tools (Rotate, Scale, Shear) and the Page tool,
// driven through the gesture DSL against the editor-shaped fake: the
// gesture channel they speak (begin / update / commit / cancel), the
// click-to-set pivot, the begin-before-resolve races, and the page
// mutations.

import { describe, expect, it, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { expectNoCommit, expectOneCommit } from "@paged-media/test-kit";

import { createPageHandler } from "../src/handlers/page-tool";
import { createShearHandler } from "../src/handlers/shear-tool";
import {
  createRotateHandler,
  createScaleHandler,
  createTransformGestureHandler,
} from "../src/handlers/transform-tools";
import { harness, lastPreview, quietWarnings } from "./support";

const FRAME = { kind: "rectangle", id: "r1" } as ElementId;
const OTHER = { kind: "oval", id: "o1" } as ElementId;

type Payload = {
  delta?: number[];
  modifiers?: Record<string, boolean>;
  lane?: string;
  gesture?: { kind: string };
  anchor?: Record<string, unknown>;
  nodes?: unknown[];
};
/** Release every held reply, and the ones they lead to. */
async function drain(fake: ReturnType<typeof harness>["fake"]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    fake.flushReplies();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const payloads = (fake: ReturnType<typeof harness>["fake"]) =>
  fake
    .gestureMessages()
    .map((m) => ({ message: m.message, ...(m.payload as Payload) }));

describe.each([
  ["rotate", createRotateHandler],
  ["scale", createScaleHandler],
  ["shear", createShearHandler],
] as const)("%s tool", (kind, create) => {
  it(`a drag on a selection begins a ${kind} gesture anchored at the press, streams doc deltas over the SAB lane, commits once @level:gesture`, async () => {
    const { fake, g } = harness({
      selection: [FRAME],
      geometry: (id) => ({ id, bounds: [0, 0, 10, 10] }),
    });
    const mark = fake.mark();
    await g
      .tool(create)
      .drag({ from: [200, 200], to: [260, 230], steps: 3, mods: ["shift"] })
      .settle();
    const msgs = payloads(fake);
    expect(msgs[0]).toMatchObject({
      message: "beginGesture",
      nodes: [FRAME],
      gesture: { kind },
      anchor: { pageId: "page-1", pointInPage: [200, 200] },
    });
    expect(msgs[0].anchor).not.toHaveProperty("pivotInPage");
    const updates = msgs.filter((m) => m.message === "updateGesture");
    expect(updates.at(-1)).toMatchObject({
      delta: [60, 30],
      lane: "sab",
      modifiers: { shift: true, alt: false },
    });
    expect(msgs.at(-1)?.message).toBe("commitGesture");
    expectOneCommit(fake, mark);
    // The selection chrome is refreshed from the committed geometry.
    expect(fake.ofChannel("selection").map((e) => e.method)).toContain(
      "setElementGeometry",
    );
  });

  it("with nothing selected a drag begins nothing @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(create)
      .drag({ from: [200, 200], to: [260, 230] })
      .settle();
    expect(fake.gestureMessages()).toEqual([]);
  });

  it("INV-2: Escape mid-drag cancels the worker gesture; nothing commits @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME] });
    const mark = fake.mark();
    await g
      .tool(create)
      .drag({ from: [200, 200], to: [260, 230], release: false })
      .settle()
      .cancel()
      .up()
      .settle();
    expectNoCommit(fake, mark);
    expect(payloads(fake).map((m) => m.message)).toContain("cancelGesture");
  });
});

// The handlers begin a worker gesture only for a press ON a page (the
// anchor names one); a press on the pasteboard does nothing. InDesign's
// Rotate / Scale / Shear take the drag anywhere. Found by the gesture
// matrix at 25 % (GT-4).
test.failing(
  "[GT-4] a transform tool drag that starts on the pasteboard still transforms the selection @level:gesture",
  async () => {
    const { fake, g } = harness({ selection: [FRAME] });
    await g
      .tool(createRotateHandler)
      .drag({ from: [700, 100], to: [760, 160] })
      .settle();
    expect(payloads(fake).map((m) => m.message)).toEqual([
      "beginGesture",
      "updateGesture",
      "commitGesture",
    ]);
  },
);

describe("the click-to-set pivot (RFI C-67)", () => {
  it("a click sets the pivot (a diamond marker) and the next drag sends it as pivotInPage @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME] });
    await g
      .tool(() => createTransformGestureHandler("rotate"))
      .click([150, 120])
      .settle();
    expect(lastPreview(fake)).toEqual({
      pageId: "page-1",
      points: [
        [150, 116],
        [154, 120],
        [150, 124],
        [146, 120],
      ],
      close: true,
    });
    // The click's own begin is cancelled, not committed.
    expect(payloads(fake).map((m) => m.message)).toEqual([
      "beginGesture",
      "cancelGesture",
    ]);
    await g.drag({ from: [300, 300], to: [330, 340] }).settle();
    const begins = payloads(fake).filter((m) => m.message === "beginGesture");
    expect(begins[1].anchor).toMatchObject({
      pointInPage: [300, 300],
      pivotInPage: [150, 120],
    });
  });

  it("the pivot is forgotten when the selection changes, and on Escape @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME] });
    await g
      .tool(() => createTransformGestureHandler("scale"))
      .click([150, 120])
      .settle();
    fake.setSelection([OTHER]);
    await g.drag({ from: [300, 300], to: [330, 340] }).settle();
    expect(
      payloads(fake)
        .filter((m) => m.message === "beginGesture")
        .at(-1)?.anchor,
    ).not.toHaveProperty("pivotInPage");
    expect(lastPreview(fake)).toBeNull();
    await g.click([150, 120]).settle().key("Escape").settle();
    expect(lastPreview(fake)).toBeNull();
  });
});

describe("the begin-before-resolve races (replies held)", () => {
  it("a drag released before the begin resolves still commits, with its final delta @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME], replies: "manual" });
    await g
      .tool(createRotateHandler)
      .drag({ from: [200, 200], to: [240, 260] });
    expect(payloads(fake).map((m) => m.message)).toEqual(["beginGesture"]);
    await drain(fake);
    const msgs = payloads(fake);
    expect(msgs.map((m) => m.message)).toEqual([
      "beginGesture",
      "updateGesture",
      "commitGesture",
    ]);
    expect(msgs[1].delta).toEqual([40, 60]);
  });

  it("a click released before the begin resolves cancels the gesture once it lands @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME], replies: "manual" });
    await g.tool(createRotateHandler).click([200, 200]);
    await drain(fake);
    expect(payloads(fake).map((m) => m.message)).toEqual([
      "beginGesture",
      "cancelGesture",
    ]);
  });

  it("moves before the begin resolves are buffered and flushed as one update @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME], replies: "manual" });
    await g
      .tool(createScaleHandler)
      .drag({ from: [200, 200], to: [230, 210], release: false });
    expect(payloads(fake).map((m) => m.message)).toEqual(["beginGesture"]);
    await drain(fake);
    expect(
      payloads(fake)
        .filter((m) => m.message === "updateGesture")
        .map((m) => m.delta),
    ).toEqual([[30, 10]]);
  });
});

describe("tool switching", () => {
  it("a spring-load suspend keeps the worker gesture; a switch cancels it @level:gesture", async () => {
    const { fake, g } = harness({ selection: [FRAME] });
    const handler = createRotateHandler();
    await g
      .tool(handler)
      .drag({ from: [200, 200], to: [240, 260], release: false })
      .settle();
    handler.onDeactivate("suspend");
    await g.up().settle();
    expect(payloads(fake).at(-1)?.message).toBe("commitGesture");
    const second = createRotateHandler();
    await g
      .tool(second)
      .drag({ from: [200, 200], to: [240, 260], release: false })
      .settle();
    second.onDeactivate("switch");
    await fake.settle();
    expect(payloads(fake).at(-1)?.message).toBe("cancelGesture");
  });
});

describe("Page tool", () => {
  it("a drag resizes the page to the drag end (72 pt floor), with a live rect preview @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPageHandler)
      .drag({ from: [100, 100], to: [400, 50] })
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "resizePage", args: { pageId: "page-1", bounds: [0, 0, 72, 400] } },
    ]);
    expect(lastPreview(fake)).toBeNull();
  });

  it("Alt+click inserts a page after it; a click arms it and Delete deletes it @level:gesture", async () => {
    const { fake, g } = harness();
    await g
      .tool(createPageHandler)
      .click([100, 100], { mods: ["alt"] })
      .click([50, 50])
      .key("Delete")
      .key("Delete")
      .settle();
    expect(fake.mutations()).toEqual([
      { op: "insertPage", args: { afterPageId: "page-1", masterId: null } },
      { op: "deletePage", args: { pageId: "page-1" } },
    ]);
  });

  it("refusals (the only page) are warned, not thrown; Escape cancels a resize drag @level:gesture", async () => {
    const { fake, g } = harness({
      refuse: (m) => (m.op === "deletePage" ? "the only page" : null),
    });
    const restore = quietWarnings();
    try {
      await g
        .tool(createPageHandler)
        .click([50, 50])
        .key("Backspace")
        .drag({ from: [100, 100], to: [400, 500], release: false })
        .cancel()
        .up()
        .settle();
    } finally {
      restore();
    }
    expect(fake.mutations().map((m) => m.op)).toEqual(["deletePage"]);
  });
});
