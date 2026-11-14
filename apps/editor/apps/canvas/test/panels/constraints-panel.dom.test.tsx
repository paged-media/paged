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

// The Design constraints panel (editor ADR 1233): the document's
// constraints with whether each holds, measured on the engine's own
// geometry; adding and removing one is one undo step each; measuring moves
// nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { publicationIssuesOf } from "@paged-media/shell";

import { addConstraint } from "../../src/constraints/add-constraint";
import { useDesignConstraintsSource } from "../../src/constraints/source";
import { ConstraintsPanel } from "../../src/panels/constraints-panel";
import { mountPanel, unmountAll } from "./harness";
import { shapesScene } from "./fixtures";

afterEach(unmountAll);

function PanelWithSource() {
  useDesignConstraintsSource();
  return <ConstraintsPanel />;
}

const undoLen = async (client: {
  undoLog(limit?: number): Promise<{ undoLen: number }>;
}) => (await client.undoLog(0)).undoLen;

describe("Design constraints", () => {
  test("each constraint says whether it holds; add and remove are one undo step each; measuring moves nothing", async () => {
    covers("panel:paged.constraints");
    const h = await mountPanel(PanelWithSource, {
      id: "paged.constraints",
      scene: shapesScene,
    });
    await h.settle();
    expect(h.root.querySelector("[data-constraints-empty]")).not.toBeNull();

    const before = await undoLen(h.client);
    // The rectangle (left 72) and the oval (left 300) share a top edge.
    const top = await addConstraint(h.paged, {
      kind: "align",
      members: [h.scene.rect, h.scene.oval],
      params: { edge: "top" },
    });
    const left = await addConstraint(h.paged, {
      kind: "align",
      members: [h.scene.rect, h.scene.oval],
      params: { edge: "left" },
    });
    expect(top.ok && left.ok).toBe(true);
    expect(await undoLen(h.client)).toBe(before + 2);
    const geometry = JSON.stringify(
      await h.client.elementGeometry([h.scene.rect, h.scene.oval]),
    );

    const row = (id: string) =>
      h.root.querySelector(`[data-constraint-row="${id}"]`);
    const topId = top.ok ? top.constraint.id : "";
    const leftId = left.ok ? left.constraint.id : "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await h.settle();
      if (
        row(leftId)?.getAttribute("data-constraint-status") === "broken" &&
        row(topId)?.getAttribute("data-constraint-status") === "holds"
      )
        break;
    }
    expect(row(topId)?.getAttribute("data-constraint-status")).toBe("holds");
    expect(row(leftId)?.getAttribute("data-constraint-status")).toBe("broken");
    expect(
      row(leftId)?.querySelector("[data-constraint-state]")?.textContent,
    ).toContain("228");
    // The broken one is an issue of the publication; the holding one not.
    expect(
      publicationIssuesOf(h.scope).issues.map((i) => [i.id, i.kind]),
    ).toEqual([[`constraint:${leftId}`, "constraint"]]);
    // Measuring changed nothing.
    expect(
      JSON.stringify(
        await h.client.elementGeometry([h.scene.rect, h.scene.oval]),
      ),
    ).toBe(geometry);
    expect(await undoLen(h.client)).toBe(before + 2);

    // Remove: one undo step, and the row goes.
    await h.user.click(row(leftId)!.querySelector("[data-constraint-remove]")!);
    for (let i = 0; i < 40 && row(leftId); i++) {
      await new Promise((r) => setTimeout(r, 50));
      await h.settle();
    }
    expect(row(leftId)).toBeNull();
    expect(await undoLen(h.client)).toBe(before + 3);
  });
});
