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

// Align (paged.align): six align buttons and two distribute buttons over
// the selection. Each button invokes the typed command paged.align.objects
// with { kind, targets }; the app registers that command over the object
// registry (main.tsx), and so does this test, with the app's own handler
// (runAlign over the editor's object registry). Asserted per button: the
// invocation, ONE engine write, and where the frames end up.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  ALIGN_ARGS,
  ALIGN_COMMAND,
  runAlign,
  type AlignKind,
} from "../../src/align-plan";
import { objectRegistry } from "../../src/object-model";
import { AlignPanel } from "../../src/panels/align-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, bounds } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

/** Mount, with paged.align.objects registered as main.tsx registers it. */
async function mount() {
  const h = await mountPanel(AlignPanel, {
    id: "paged.align",
    scene: richScene,
  });
  h.registries.commands.register({
    id: ALIGN_COMMAND,
    title: "Align objects",
    category: "Object",
    args: ALIGN_ARGS,
    handler: (_paged: unknown, payload?: unknown) =>
      runAlign(
        objectRegistry,
        payload as { kind: AlignKind; targets: string[] },
      ),
  });
  return h;
}

const button = (h: H, kind: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-align-kind="${kind}"]`)!;
const frame = async (h: H, id: H["scene"]["rect"]) =>
  h.get(addr(id), "frameBounds");

// rect [400, 72, 500, 200]; groupA [550, 72, 600, 150] and groupB
// [550, 200, 600, 280] (members of the group, selected on their own).
// An oval reads its frameBounds like every page item (PN-261, fixed).

describe("Align panel: states", () => {
  test("nothing or one selected: every button disabled, the hint says why", async () => {
    covers("panel:paged.align");
    const h = await mount();
    for (const kind of [
      "left",
      "centerH",
      "right",
      "top",
      "centerV",
      "bottom",
      "distributeH",
      "distributeV",
    ]) {
      expect(button(h, kind).disabled).toBe(true);
    }
    expect(h.root.querySelector("[data-align-hint]")?.textContent).toBe(
      "Select 2 or more frames to align.",
    );
    await h.select([h.scene.rect]);
    expect(button(h, "left").disabled).toBe(true);
  });

  test("two selected: align on, distribute off with its own hint", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupB]);
    expect(button(h, "left").disabled).toBe(false);
    expect(button(h, "distributeH").disabled).toBe(true);
    expect(h.root.querySelector("[data-align-hint]")).toBeNull();
    expect(h.root.querySelector("[data-distribute-hint]")?.textContent).toBe(
      "Select 3 or more frames to distribute.",
    );
  });

  test("three selected: distribute on", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA, h.scene.groupB]);
    expect(button(h, "distributeH").disabled).toBe(false);
    expect(button(h, "distributeV").disabled).toBe(false);
    expect(h.root.querySelector("[data-distribute-hint]")).toBeNull();
  });

  test("the seams: Align to offers only Selection, Use spacing is off and disabled", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupB]);
    const scope =
      h.root.querySelector<HTMLSelectElement>("[data-align-scope]")!;
    expect(scope.value).toBe("selection");
    expect(
      [...scope.options].filter((o) => !o.disabled).map((o) => o.value),
    ).toEqual(["selection"]);
    const spacing =
      h.root.querySelector<HTMLButtonElement>("[data-use-spacing]")!;
    expect(spacing.disabled).toBe(true);
    const from = h.mark();
    await h.click(spacing);
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Align panel: every button moves the frames", () => {
  for (const [kind, pair, moved] of [
    ["left", "groupB", { groupB: [550, 72, 600, 152] }],
    ["right", "groupB", { rect: [400, 152, 500, 280] }],
    [
      "centerH",
      "groupB",
      { rect: [400, 112, 500, 240], groupB: [550, 136, 600, 216] },
    ],
    ["top", "groupA", { groupA: [400, 72, 450, 150] }],
    ["bottom", "groupA", { rect: [500, 72, 600, 200] }],
    [
      "centerV",
      "groupA",
      { rect: [450, 72, 550, 200], groupA: [475, 72, 525, 150] },
    ],
  ] as const) {
    test(`${kind}: the command gets { kind, targets }, ONE write, the frames land`, async () => {
      covers("panel:paged.align", "command:paged.align.objects");
      const h = await mount();
      const other = h.scene[pair];
      await h.select([h.scene.rect, other]);
      const from = h.mark();
      await h.click(button(h, kind));
      expect(h.invoked(ALIGN_COMMAND)).toEqual([
        {
          id: ALIGN_COMMAND,
          payload: { kind, targets: [addr(h.scene.rect), addr(other)] },
        },
      ]);
      expect(h.mutations(from)).toHaveLength(1);
      const want = moved as unknown as Record<
        string,
        [number, number, number, number]
      >;
      for (const [name, b] of Object.entries(want)) {
        expect(await frame(h, h.scene[name as "rect"])).toEqual(bounds(b));
      }
      // One undo step puts everything back.
      await h.act(() => h.client.undo());
      expect(await frame(h, h.scene.rect)).toEqual(bounds([400, 72, 500, 200]));
    });
  }

  test("distribute horizontally: the middle frame's centre moves to the even step", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA, h.scene.groupB]);
    const from = h.mark();
    await h.click(button(h, "distributeH"));
    expect(h.mutations(from)).toHaveLength(1);
    // Centres 111 (groupA), 136 (rect), 240 (groupB): rect goes to 175.5.
    expect(await frame(h, h.scene.rect)).toEqual(
      bounds([400, 111.5, 500, 239.5]),
    );
    expect(await frame(h, h.scene.groupB)).toEqual(
      bounds([550, 200, 600, 280]),
    );
  });

  test("distribute vertically: the middle frame's centre moves to the even step", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    // Centres 450 (rect), 575 (groupA), 575 (groupB): groupA, the middle
    // one, goes to 512.5.
    await h.select([h.scene.rect, h.scene.groupA, h.scene.groupB]);
    await h.click(button(h, "distributeV"));
    expect(await frame(h, h.scene.groupA)).toEqual(
      bounds([487.5, 72, 537.5, 150]),
    );
  });

  test("frames already aligned: the command runs and nothing is written", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.groupA, h.scene.groupB]);
    const from = h.mark();
    await h.click(button(h, "top"));
    expect(h.invoked(ALIGN_COMMAND)).toHaveLength(1);
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Align panel: findings", () => {
  // PN-261 (fixed, R1): the engine's oval carried no frameBounds
  // (requestGet answered noSuchPath), so runAlign could not read where
  // an oval is and left it out: aligning a rectangle and an oval to the
  // left moved nothing.
  test("PN-261: aligning a rectangle and an oval moves the oval", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval]);
    const from = h.mark();
    await h.click(button(h, "left"));
    expect(h.mutations(from)).toHaveLength(1);
  });

  // UX audit F-39: the spacing reads "— mm" while every other length in
  // the editor (the control bar, Properties, this document) is in points.
  test.failing(
    "PN-260 (UX F-39): the spacing reads in the document's unit (pt), not mm",
    async () => {
      covers("panel:paged.align");
      const h = await mount();
      await h.select([h.scene.rect, h.scene.groupB]);
      expect(h.root.textContent).not.toContain(" mm");
    },
  );
});
