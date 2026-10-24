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

// Align (paged.align): Align Objects (six), Distribute Objects (six) and
// Distribute Spacing (two) against the scope in "Align to" — the
// selection, a key object, the margins, the page or the spread — with an
// optional fixed spacing. Each button invokes the typed command
// paged.align.objects with { kind, targets, to, key?, spacing? }; the app
// registers that command from transform-commands.ts, and so does this
// test. Asserted per button: the invocation, ONE engine write, and where
// the frames end up (their transformed boxes: align moves through
// frameTransform, WP4.4).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { ALIGN_SCOPE } from "@paged-media/shell";

import { ALIGN_COMMAND } from "../../src/align-plan";
import { AlignPanel } from "../../src/panels/align-panel";
import { buildTransformCommands } from "../../src/transform-commands";
import { transformBounds, type Affine } from "../../src/transform-targets";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

/** Mount, with paged.align.objects registered as the app registers it. */
async function mount() {
  const h = await mountPanel(AlignPanel, {
    id: "paged.align",
    scene: richScene,
  });
  h.scope.get(ALIGN_SCOPE).set({ to: "selection", key: null });
  for (const c of buildTransformCommands(h.objects.registry))
    h.registries.commands.register(c);
  return h;
}

const button = (h: H, kind: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-align-kind="${kind}"]`)!;
const scopeSelect = (h: H) =>
  h.root.querySelector<HTMLSelectElement>("[data-align-scope]")!;

/** Where an object shows: its box through its transform, page space. */
async function shown(h: H, id: H["scene"]["rect"]) {
  const [g] = await h.client.elementGeometry([id]);
  const b = transformBounds(
    g!.bounds as [number, number, number, number],
    (g!.itemTransform ?? null) as Affine | null,
  );
  return b.map((v) => Math.round(v * 100) / 100);
}

const ALL_KINDS = [
  "left",
  "centerH",
  "right",
  "top",
  "centerV",
  "bottom",
  "distributeLeft",
  "distributeH",
  "distributeRight",
  "distributeTop",
  "distributeV",
  "distributeBottom",
  "spaceH",
  "spaceV",
];

// rect [400, 72, 500, 200]; groupA [550, 72, 600, 150] and groupB
// [550, 200, 600, 280] (members of the group, selected on their own),
// on a 612 × 792 page.

describe("Align panel: states", () => {
  test("nothing or one selected: every button disabled, the hint says why", async () => {
    covers("panel:paged.align");
    const h = await mount();
    for (const kind of ALL_KINDS) expect(button(h, kind).disabled).toBe(true);
    expect(h.root.querySelector("[data-align-hint]")?.textContent).toBe(
      "Select 2 or more objects to align.",
    );
    await h.select([h.scene.rect]);
    expect(button(h, "left").disabled).toBe(true);
  });

  test("two selected: align on, distribute off with its own hint; Use spacing turns it on", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupB]);
    expect(button(h, "left").disabled).toBe(false);
    expect(button(h, "distributeH").disabled).toBe(true);
    expect(button(h, "spaceH").disabled).toBe(true);
    expect(h.root.querySelector("[data-align-hint]")).toBeNull();
    expect(h.root.querySelector("[data-distribute-hint]")?.textContent).toBe(
      "Select 3 or more objects to distribute.",
    );
    const spacing =
      h.root.querySelector<HTMLButtonElement>("[data-use-spacing]")!;
    const from = h.mark();
    await h.click(spacing);
    expect(spacing.getAttribute("aria-checked")).toBe("true");
    expect(button(h, "spaceH").disabled).toBe(false);
    expect(h.mutations(from)).toEqual([]);
  });

  test("three selected: distribute on", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA, h.scene.groupB]);
    for (const kind of ALL_KINDS) expect(button(h, kind).disabled).toBe(false);
    expect(h.root.querySelector("[data-distribute-hint]")).toBeNull();
  });

  test("Align to offers all five scopes; a page scope aligns one object", async () => {
    covers("panel:paged.align");
    const h = await mount();
    const scope = scopeSelect(h);
    expect(scope.value).toBe("selection");
    expect(
      [...scope.options].filter((o) => !o.disabled).map((o) => o.value),
    ).toEqual(["selection", "keyObject", "margins", "page", "spread"]);
    await h.select([h.scene.rect]);
    await h.choose(scope, "page");
    expect(h.scope.get(ALIGN_SCOPE).get().to).toBe("page");
    expect(button(h, "left").disabled).toBe(false);
    expect(h.root.querySelector("[data-align-hint]")).toBeNull();
  });

  test("Key object shows how to pick the key", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.choose(scopeSelect(h), "keyObject");
    expect(h.root.querySelector("[data-key-object-hint]")?.textContent).toBe(
      "Click a selected object to make it the key object.",
    );
  });
});

describe("Align panel: every button moves the frames, one undo step each [editor-shell.align-transform-each]", () => {
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
    test(`${kind}: the command gets its args, ONE write, the frames land`, async () => {
      covers("panel:paged.align", "command:paged.align.objects");
      const h = await mount();
      const other = h.scene[pair];
      await h.select([h.scene.rect, other]);
      const from = h.mark();
      await h.click(button(h, kind));
      expect(h.invoked(ALIGN_COMMAND)).toEqual([
        {
          id: ALIGN_COMMAND,
          payload: {
            kind,
            targets: [addr(h.scene.rect), addr(other)],
            to: "selection",
          },
        },
      ]);
      expect(h.mutations(from)).toHaveLength(1);
      for (const [name, b] of Object.entries(moved)) {
        expect(await shown(h, h.scene[name as "rect"])).toEqual([...b]);
      }
      await h.act(() => h.client.undo());
      expect(await shown(h, h.scene.rect)).toEqual([400, 72, 500, 200]);
    });
  }

  test("distribute objects by an edge, and distribute spacing", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA, h.scene.groupB]);
    // Lefts 72, 72, 200: rect (the middle one by order) goes to 136.
    let from = h.mark();
    await h.click(button(h, "distributeLeft"));
    expect(h.mutations(from)).toHaveLength(1);
    expect(await shown(h, h.scene.rect)).toEqual([400, 72, 500, 200]);
    await h.act(() => h.client.undo());
    // Centres 111 (groupA), 136 (rect), 240 (groupB): rect to 175.5.
    from = h.mark();
    await h.click(button(h, "distributeH"));
    expect(h.mutations(from)).toHaveLength(1);
    expect(await shown(h, h.scene.rect)).toEqual([400, 111.5, 500, 239.5]);
    await h.act(() => h.client.undo());
    // Bottoms 500 (rect), 600 (groupA), 600 (groupB): the outer two stay,
    // groupA's bottom goes to the even step, 550.
    await h.click(button(h, "distributeBottom"));
    expect(await shown(h, h.scene.groupA)).toEqual([500, 72, 550, 150]);
  });

  test("a fixed spacing: two objects, the gap typed", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.groupA, h.scene.groupB]);
    await h.click(
      h.root.querySelector<HTMLButtonElement>("[data-use-spacing]")!,
    );
    await h.typeInto(
      h.root.querySelector<HTMLElement>("[data-spacing-value] input")!,
      "12",
    );
    const from = h.mark();
    await h.click(button(h, "spaceH"));
    expect(h.invoked(ALIGN_COMMAND).at(-1)?.payload).toMatchObject({
      kind: "spaceH",
      spacing: 12,
    });
    expect(h.mutations(from)).toHaveLength(1);
    // groupA ends at 150: groupB starts 12 pt later.
    expect(await shown(h, h.scene.groupB)).toEqual([550, 162, 600, 242]);
  });

  test("align to the page: one object to the page's right edge", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.choose(scopeSelect(h), "page");
    const from = h.mark();
    await h.click(button(h, "right"));
    expect(h.mutations(from)).toHaveLength(1);
    expect(await shown(h, h.scene.rect)).toEqual([400, 484, 500, 612]);
  });

  test("align to the spread and the margins follow the page reads", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.choose(scopeSelect(h), "spread");
    await h.click(button(h, "top"));
    expect((await shown(h, h.scene.rect))[0]).toBe(0);
    await h.choose(scopeSelect(h), "margins");
    const pages = (await h.client.collection("pages")) as Array<{
      marginLeftPt: number;
    }>;
    await h.click(button(h, "left"));
    expect((await shown(h, h.scene.rect))[1]).toBe(pages[0]!.marginLeftPt);
  });

  test("align to a key object: the key stays, its address rides the args", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.groupB, h.scene.rect]);
    await h.choose(scopeSelect(h), "keyObject");
    await h.click(button(h, "left"));
    expect(h.invoked(ALIGN_COMMAND).at(-1)?.payload).toMatchObject({
      to: "keyObject",
      key: addr(h.scene.groupB),
    });
    // groupB (the first selected) is the key: rect moves to its left.
    expect(await shown(h, h.scene.groupB)).toEqual([550, 200, 600, 280]);
    expect(await shown(h, h.scene.rect)).toEqual([400, 200, 500, 328]);
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
  // PN-261 (fixed, R1): an oval read no frameBounds, so align left it out.
  test("PN-261: aligning a rectangle and an oval moves the oval", async () => {
    covers("panel:paged.align", "command:paged.align.objects");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval]);
    const from = h.mark();
    await h.click(button(h, "left"));
    expect(h.mutations(from)).toHaveLength(1);
  });

  // UX audit F-39 (fixed, ADR 245): the spacing reads in the document unit.
  test("PN-260 (UX F-39): the spacing reads in the document's unit (pt), not mm", async () => {
    covers("panel:paged.align");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupB]);
    expect(h.root.textContent).not.toContain(" mm");
  });
});
