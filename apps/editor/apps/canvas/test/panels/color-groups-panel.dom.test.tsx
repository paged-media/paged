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

// Color groups (paged.color-groups): the document's colour groups with
// their member chips, New and per-group Delete (createColorGroup /
// deleteColorGroup). Member assignment is the Swatches panel's.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ColorGroupsPanel } from "../../src/panels/color-groups-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ColorGroupsPanel, { id: "paged.color-groups", scene: richScene });

const group = (h: H, selfId: string) =>
  h.root.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(selfId)}"]`);
const groups = async (h: H) =>
  (await h.client.collection("colorGroups")) as Array<{
    selfId: string;
    name: string;
    members: string[];
  }>;

describe("Color groups panel: states", () => {
  test("a blank document: no groups, and New is offered", async () => {
    covers("panel:paged.color-groups");
    const h = await mountPanel(ColorGroupsPanel, { id: "paged.color-groups" });
    expect(h.root.querySelector("[data-empty-color-groups]")).not.toBeNull();
    expect(
      h.root.querySelector<HTMLButtonElement>(
        '[data-toolbar-btn="new-color-group"]',
      )!.disabled,
    ).toBe(false);
  });

  test("a group shows its name, its member count and one chip per member, resolved to the swatch", async () => {
    covers("panel:paged.color-groups");
    const h = await mount();
    const row = group(h, h.scene.colorGroup)!;
    expect(row.querySelector("[data-group-toggle]")?.textContent).toBe(
      "Brand1",
    );
    const chips = [...row.querySelectorAll<HTMLElement>("[data-group-member]")];
    expect(chips.map((c) => c.getAttribute("data-group-member"))).toEqual([
      h.scene.red,
    ]);
    expect(chips[0].getAttribute("title")).toBe("Red");
  });

  test("the group header collapses and expands its members", async () => {
    covers("panel:paged.color-groups");
    const h = await mount();
    const toggle = group(h, h.scene.colorGroup)!.querySelector<HTMLElement>(
      "[data-group-toggle]",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await h.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      group(h, h.scene.colorGroup)!.querySelector("[data-group-members]"),
    ).toBeNull();
    await h.click(toggle);
    expect(
      group(h, h.scene.colorGroup)!.querySelector("[data-group-members]"),
    ).not.toBeNull();
  });
});

describe("Color groups panel: controls", () => {
  test("New group creates an empty group and lists it", async () => {
    covers("panel:paged.color-groups");
    const h = await mount();
    const from = h.mark();
    await h.click(
      h.root.querySelector('[data-toolbar-btn="new-color-group"]')!,
    );
    expect(h.mutations(from)).toEqual([
      {
        op: "createColorGroup",
        args: { spec: { selfId: null, name: "New group", members: [] } },
      },
    ] as never);
    const created = (await groups(h)).find((g) => g.name === "New group");
    expect(created?.members).toEqual([]);
    expect(group(h, created!.selfId)?.textContent).toContain("Empty group");
  });

  test("Delete removes the group and keeps its swatches; one undo brings it back", async () => {
    covers("panel:paged.color-groups");
    const h = await mount();
    const from = h.mark();
    await h.click(
      group(h, h.scene.colorGroup)!.querySelector("[data-group-delete]")!,
    );
    expect(h.mutations(from)).toEqual([
      { op: "deleteColorGroup", args: { groupId: h.scene.colorGroup } },
    ] as never);
    expect(await groups(h)).toEqual([]);
    expect(group(h, h.scene.colorGroup)).toBeNull();
    const swatches = (await h.client.collection("swatches")) as Array<{
      selfId: string;
    }>;
    expect(swatches.map((s) => s.selfId)).toContain(h.scene.red);
    await h.act(() => h.client.undo());
    expect((await groups(h)).map((g) => g.selfId)).toEqual([
      h.scene.colorGroup,
    ]);
    expect(group(h, h.scene.colorGroup)).not.toBeNull();
  });
});

describe("Color groups panel: findings", () => {
  // UX audit F-14 (commands enabled with nothing to act on fail
  // silently): with no document, New group stays enabled, sends a
  // mutation the engine refuses, and nothing tells the user.
  test.failing(
    "PN-157 (UX F-14): with no document, New group is disabled",
    async () => {
      covers("panel:paged.color-groups");
      const h = await mountPanel(ColorGroupsPanel, {
        id: "paged.color-groups",
        document: "none",
      });
      expect(
        h.root.querySelector<HTMLButtonElement>(
          '[data-toolbar-btn="new-color-group"]',
        )!.disabled,
      ).toBe(true);
    },
  );
});
