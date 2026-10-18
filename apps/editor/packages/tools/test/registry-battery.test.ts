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

// Every built-in tool, mounted BY ID through the registry the way the
// gesture spine mounts it, survives the standard gesture battery on the
// fake: press-drag-release, a click, Escape mid-drag, a double-click and
// a tool switch — no throw, at most one commit per gesture, nothing
// committed by the cancelled one, the overlay left clear.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { commitsSince, expectNoCommit } from "@paged-media/test-kit";

import { BUILT_IN_TOOLS } from "../src/built-in-tools";
import { harness, lastPreview, quietWarnings } from "./support";

const WITH_HANDLER = BUILT_IN_TOOLS.filter(
  (t) => t.gesture && t.status !== "planned",
);

describe("the built-in tools, mounted from the registry", () => {
  it("the registry has the host tools the handler tests cover", () => {
    expect(WITH_HANDLER.map((t) => t.id).sort()).toEqual(
      [
        "paged.tool.ellipse",
        "paged.tool.ellipseFrame",
        "paged.tool.eyedropper",
        "paged.tool.gradientFeather",
        "paged.tool.gradientSwatch",
        "paged.tool.line",
        "paged.tool.page",
        "paged.tool.pen",
        "paged.tool.pencil",
        "paged.tool.polygon",
        "paged.tool.polygonFrame",
        "paged.tool.rectangle",
        "paged.tool.rectangleFrame",
        "paged.tool.rotate",
        "paged.tool.scale",
        "paged.tool.scissors",
        "paged.tool.shear",
        "paged.tool.smooth",
        "paged.tool.type",
      ].sort(),
    );
  });

  for (const tool of WITH_HANDLER) {
    it(`${tool.id}: the gesture battery @level:gesture`, async () => {
      const target = { kind: "rectangle", id: "r1" } as ElementId;
      const { fake, g } = harness({
        selection: [target],
        hitTest: () => target,
      });
      for (const t of BUILT_IN_TOOLS) fake.editor.registries.tools.register(t);
      const restore = quietWarnings();
      try {
        await g.tool(tool.id).settle();
        let mark = fake.mark();
        await g
          .drag({ from: [100, 100], to: [250, 200] })
          .key("Enter")
          .settle();
        const one = commitsSince(fake, mark);
        expect(one.applied.length + one.committed.length).toBeLessThanOrEqual(
          2,
        );
        mark = fake.mark();
        await g
          .drag({ from: [300, 300], to: [400, 380], release: false })
          .settle()
          .cancel()
          .up()
          .settle();
        expectNoCommit(fake, mark, `${tool.id} cancelled`);
        await g
          .click([150, 150])
          .settle()
          .dblclick([160, 160])
          .settle()
          .key("Escape")
          .settle();
        await g
          .tool(
            BUILT_IN_TOOLS.find((t) => t.id === "paged.tool.rectangleFrame")!
              .id,
          )
          .settle();
        const preview = lastPreview(fake);
        // A transform tool's click-set pivot marker is the one preview that
        // legitimately outlives a gesture; a switch clears it.
        expect(preview).toBeNull();
      } finally {
        restore();
      }
    });
  }
});
