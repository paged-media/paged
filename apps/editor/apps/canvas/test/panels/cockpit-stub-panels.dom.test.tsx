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

// Comments (paged.comments) and the component Library
// (paged.component-library): Review mode's and the component system's
// panels, honest stubs until the collaboration backend and the component
// system land. What is asserted is the honesty: the coming-soon card says
// what is missing, nothing on them pretends to work (no enabled control),
// and they send nothing to the engine, with or without a document.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  CommentsPanel,
  ComponentLibraryPanel,
} from "../../src/panels/cockpit/stub-panels";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";
import { comingSoonTitles, enabledControls } from "./support/cockpit";

afterEach(unmountAll);

describe("Comments panel", () => {
  test("says comments land with the collaboration backend, on any document", async () => {
    covers("panel:paged.comments");
    for (const document of ["none", "blank"] as const) {
      const h = await mountPanel(CommentsPanel, {
        id: "paged.comments",
        document,
      });
      expect(h.root.querySelector("[data-comments-panel]")).not.toBeNull();
      expect(comingSoonTitles(h.root)).toEqual(["No comments yet"]);
      expect(h.root.textContent).toContain(
        "Threaded review comments, approvals and version compare land with the collaboration backend.",
      );
      h.unmount();
    }
  });

  test("offers no control and sends nothing, even with a selection", async () => {
    covers("panel:paged.comments");
    const h = await mountPanel(CommentsPanel, {
      id: "paged.comments",
      scene: richScene,
    });
    const from = h.mark();
    await h.select([h.scene.rect]);
    await h.caret(h.scene.storyId, 1);
    expect(enabledControls(h.root)).toEqual([]);
    expect(h.mutations(from)).toEqual([]);
    expect(comingSoonTitles(h.root)).toEqual(["No comments yet"]);
  });
});

describe("Component library panel", () => {
  test("says the component library is coming, on any document", async () => {
    covers("panel:paged.component-library");
    for (const document of ["none", "blank"] as const) {
      const h = await mountPanel(ComponentLibraryPanel, {
        id: "paged.component-library",
        document,
      });
      expect(
        h.root.querySelector("[data-component-library-panel]"),
      ).not.toBeNull();
      expect(comingSoonTitles(h.root)).toEqual([
        "Component library coming soon",
      ]);
      h.unmount();
    }
  });

  test("offers no control and sends nothing", async () => {
    covers("panel:paged.component-library");
    const h = await mountPanel(ComponentLibraryPanel, {
      id: "paged.component-library",
      scene: richScene,
    });
    const from = h.mark();
    await h.select([h.scene.group]);
    expect(enabledControls(h.root)).toEqual([]);
    expect(h.mutations(from)).toEqual([]);
    // The stub asks the engine nothing: the only traffic is the
    // selection's own (the canvas click h.select stands for).
    const own = new Set(["setElementSelection", "requestElementGeometry"]);
    expect(h.sent(undefined, from).filter((m) => !own.has(m.kind))).toEqual([]);
  });
});
