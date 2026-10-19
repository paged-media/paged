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

// Condition Sets (paged.condition-sets): one row per condition set with
// its condition count, and an Apply button per row.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ConditionSetsPanel } from "../../src/panels/condition-sets-panel";
import { mountPanel, unmountAll } from "./harness";
import { rows, structureIdml, STRUCTURE } from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(ConditionSetsPanel, { id: "paged.condition-sets", document });

const applyButton = (root: Element) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Apply",
  )!;

describe("Condition Sets panel", () => {
  test("no document: the empty state", async () => {
    covers("panel:paged.condition-sets");
    const h = await mount("none");
    expect(
      h.root.querySelector("[data-empty-condition-sets]")?.textContent,
    ).toBe("No condition sets in this document.");
  });

  test("a document without sets: the empty state", async () => {
    covers("panel:paged.condition-sets");
    const h = await mount("blank");
    expect(h.root.querySelector("[data-empty-condition-sets]")).not.toBeNull();
  });

  test("lists each set with how many conditions it holds", async () => {
    covers("panel:paged.condition-sets");
    const h = await mount();
    expect(rows(h.root).map((r) => [r.key, r.primary, r.secondary])).toEqual([
      [STRUCTURE.conditionSet, "Print", "2 conditions"],
    ]);
  });

  test("Apply is disabled today and sends nothing", async () => {
    covers("panel:paged.condition-sets");
    const h = await mount();
    const from = h.mark();
    expect(applyButton(h.root).disabled).toBe(true);
    await h.click(applyButton(h.root));
    expect(h.mutations(from)).toEqual([]);
  });

  // The panel says Apply waits for an ActivateConditionSet operation; the
  // engine has it (`activateConditionSet`, which restores each member
  // condition's recorded visibility), so the seam outlived its gap.
  test.failing(
    "PN-101: Apply activates the set (activateConditionSet)",
    async () => {
      covers("panel:paged.condition-sets");
      const h = await mount();
      await h.mutate({
        op: "setConditionVisible",
        args: { condition: STRUCTURE.conditions.draft, visible: false },
      } as never);
      const from = h.mark();
      await h.click(applyButton(h.root));
      expect(h.mutations(from)).toEqual([
        { op: "activateConditionSet", args: { set: STRUCTURE.conditionSet } },
      ] as never);
    },
  );
});
