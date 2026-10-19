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

// Pathfinder (paged.pathfinder): the four shape modes (one
// pathfinderBoolean over the selection), the six region verbs (one
// mutation each, operands ordered front to back by the real stacking
// order), the path verbs (each opens the typed command form, prefilled
// from the selection), and the Convert shape / Corner seams.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { ElementId, SceneTreeNode } from "@paged-media/client";

import { CoreCommandDialog } from "../../src/core-command-dialog";
import { PathfinderPanel } from "../../src/panels/pathfinder-panel";
import {
  apply,
  richScene,
  type RichScene,
  type SceneBuilder,
} from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

/** The rich scene plus two overlapping rectangles: `back`
 *  [100, 350, 200, 450] and `front` [150, 400, 250, 500], inserted in
 *  that order (so `front` paints on top). */
type Scene = RichScene & { back: ElementId; front: ElementId };

const scene: SceneBuilder<Scene> = async (ctx) => {
  const s = await richScene(ctx);
  const back = await apply(ctx.client, {
    op: "insertFrame",
    args: { pageId: s.pageId, bounds: [100, 350, 200, 450] },
  } as never);
  const front = await apply(ctx.client, {
    op: "insertFrame",
    args: { pageId: s.pageId, bounds: [150, 400, 250, 500] },
  } as never);
  return { ...s, back: back.createdId!, front: front.createdId! };
};

type H = PanelHarness<Scene>;

/** The panel and the command form the app mounts beside the dock. */
function PathfinderWithForm() {
  return (
    <>
      <PathfinderPanel />
      <CoreCommandDialog />
    </>
  );
}

const mount = () =>
  mountPanel(PathfinderWithForm, { id: "paged.pathfinder", scene });

const kindButton = (h: H, kind: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-pathfinder-kind="${kind}"]`)!;
const verbButton = (h: H, verb: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-pathfinder-verb="${verb}"]`)!;
const status = (h: H) =>
  h.root.querySelector("[data-pathfinder-error]")?.textContent ?? null;
const dialog = () =>
  document.body.querySelector<HTMLElement>('[role="dialog"]');

/** Every page-item id the scene tree carries. */
async function sceneIds(h: H): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: SceneTreeNode[]) => {
    for (const n of nodes) {
      if (n.id) out.push(`${n.id.kind}:${String(n.id.id)}`);
      if (n.children) walk(n.children);
    }
  };
  walk(await h.client.sceneTree());
  return out;
}
/** The scene's ids and the two operands' anchors: what a region verb
 *  changes (some replace the operands, some reshape them in place). */
async function digest(h: H): Promise<string> {
  const anchors = async (id: ElementId) => {
    try {
      return await h.client.pathAnchors(id);
    } catch {
      return null;
    }
  };
  return JSON.stringify([
    await sceneIds(h),
    await anchors(h.scene.back),
    await anchors(h.scene.front),
  ]);
}
const key = (id: ElementId) => `${id.kind}:${String(id.id)}`;

const KINDS = ["union", "intersect", "subtract", "exclude"] as const;
const VERBS = [
  "pathfinderDivide",
  "pathfinderTrim",
  "pathfinderMerge",
  "pathfinderCrop",
  "pathfinderOutline",
  "pathfinderMinusBack",
] as const;
const PATH_OPS = [
  "pathPointInsert",
  "pathPointRemove",
  "pathPointSet",
  "closePath",
  "joinPaths",
  "outlineStroke",
  "offsetPath",
  "pathfinderFaces",
  "attachTextToPath",
  "detachTextFromPath",
  "applyOpacityMask",
  "releaseOpacityMask",
  "duplicateElements",
];

describe("Pathfinder panel: states", () => {
  test("nothing selected: every verb disabled, the hint says why", async () => {
    covers("panel:paged.pathfinder");
    const h = await mount();
    for (const k of KINDS) expect(kindButton(h, k).disabled).toBe(true);
    for (const v of VERBS) expect(verbButton(h, v).disabled).toBe(true);
    for (const op of PATH_OPS) {
      expect(
        h.root.querySelector<HTMLButtonElement>(
          `[data-core-command-button="${op}"]`,
        )!.disabled,
      ).toBe(true);
    }
    expect(h.root.querySelector("[data-pathfinder-hint]")?.textContent).toBe(
      "Select 2 or more frames to combine.",
    );
  });

  test("one frame: the path verbs are on, the combining verbs are not", async () => {
    covers("panel:paged.pathfinder");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(kindButton(h, "union").disabled).toBe(true);
    expect(
      h.root.querySelector<HTMLButtonElement>(
        '[data-core-command-button="closePath"]',
      )!.disabled,
    ).toBe(false);
  });

  test("two frames: every combining verb on, no hint", async () => {
    covers("panel:paged.pathfinder");
    const h = await mount();
    await h.select([h.scene.back, h.scene.front]);
    for (const k of KINDS) expect(kindButton(h, k).disabled).toBe(false);
    for (const v of VERBS) expect(verbButton(h, v).disabled).toBe(false);
    expect(h.root.querySelector("[data-pathfinder-hint]")).toBeNull();
  });

  test("the seams: Convert shape and Corner are disabled and send nothing", async () => {
    covers("panel:paged.pathfinder");
    const h = await mount();
    await h.select([h.scene.back, h.scene.front]);
    const seams = [
      ...h.root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        "[data-convert-shape-seam] button, select[data-seam]",
      ),
    ];
    expect(seams).toHaveLength(5);
    expect(seams.every((s) => s.disabled)).toBe(true);
    const from = h.mark();
    for (const s of seams) await h.click(s);
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Pathfinder panel: the shape modes", () => {
  for (const kind of KINDS) {
    test(`${kind}: one pathfinderBoolean keeping the first selected, one undo restores both`, async () => {
      covers("panel:paged.pathfinder");
      const h = await mount();
      const before = await sceneIds(h);
      await h.select([h.scene.back, h.scene.front]);
      const from = h.mark();
      await h.click(kindButton(h, kind));
      expect(h.mutations(from)).toEqual([
        {
          op: "pathfinderBoolean",
          args: { kept: h.scene.back, others: [h.scene.front], kind },
        },
      ] as never);
      expect(status(h)).toBeNull();
      // The operand that was not kept is gone from the document.
      expect(await sceneIds(h)).not.toContain(key(h.scene.front));
      await h.act(() => h.client.undo());
      expect(await sceneIds(h)).toEqual(before);
    });
  }
});

describe("Pathfinder panel: the region verbs", () => {
  for (const verb of VERBS) {
    test(`${verb}: one mutation, operands front to back whatever the click order`, async () => {
      covers("panel:paged.pathfinder");
      const h = await mount();
      const before = await digest(h);
      // Selected back first: the panel must still hand the front first.
      await h.select([h.scene.back, h.scene.front]);
      const from = h.mark();
      await h.click(verbButton(h, verb));
      expect(h.mutations(from)).toEqual([
        { op: verb, args: { elementIds: [h.scene.front, h.scene.back] } },
      ] as never);
      expect(status(h)).toBeNull();
      expect(await digest(h)).not.toEqual(before);
      await h.act(() => h.client.undo());
      expect(await digest(h)).toEqual(before);
    });
  }
});

describe("Pathfinder panel: the path verbs open the typed form", () => {
  for (const op of PATH_OPS) {
    test(`${op}: the form for core.${op}, prefilled with the selection`, async () => {
      covers("panel:paged.pathfinder");
      const h = await mount();
      await h.select([h.scene.rect]);
      const from = h.mark();
      await h.click(
        h.root.querySelector(`[data-core-command-button="${op}"]`)!,
      );
      expect(dialog()?.textContent).toContain(`core.${op}`);
      // Opening the form writes nothing; Cancel closes it.
      expect(h.mutations(from)).toEqual([]);
      const cancel = [...dialog()!.querySelectorAll("button")].find(
        (b) => b.textContent === "Cancel",
      )!;
      await h.click(cancel);
      expect(dialog()).toBeNull();
      expect(h.mutations(from)).toEqual([]);
    });
  }

  test("outline stroke: Run sends the one mutation the form holds", async () => {
    covers("panel:paged.pathfinder");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(
      h.root.querySelector('[data-core-command-button="outlineStroke"]')!,
    );
    const values = [
      ...dialog()!.querySelectorAll<HTMLInputElement>("input, select"),
    ].map((i) => i.value);
    expect(values[0]).toBe(`rectangle:${h.scene.rect.id}`);
    const from = h.mark();
    await h.click(
      [...dialog()!.querySelectorAll("button")].find(
        (b) => b.textContent === "Run",
      )!,
    );
    expect(h.mutations(from)).toEqual([
      {
        op: "outlineStroke",
        args: {
          elementId: h.scene.rect,
          width: 1,
          cap: "butt",
          join: "miter",
          miterLimit: 4,
        },
      },
    ] as never);
    expect(dialog()).toBeNull();
  });
});

describe("Pathfinder panel: findings", () => {
  // A refused shape mode puts the engine's words in the status line; for a
  // rectangle and an oval the engine answers notImplemented with the
  // wire's variant name, and the panel shows "Mutation::PathfinderBoolean".
  test.failing(
    "PN-262: a refused shape mode says why in words, not with the wire's variant name",
    async () => {
      covers("panel:paged.pathfinder");
      const h = await mount();
      await h.select([h.scene.rect, h.scene.oval]);
      await h.click(kindButton(h, "intersect"));
      expect(status(h)).not.toBeNull();
      expect(status(h)).not.toContain("Mutation::");
    },
  );
});
