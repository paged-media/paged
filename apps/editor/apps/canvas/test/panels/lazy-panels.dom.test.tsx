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

// The panels that load when first shown (src/panels/lazy-panels.tsx): the
// registry's entry renders the real panel once its chunk has arrived, and
// a chunk that cannot be loaded is caught by the panel's own error net,
// which every panel has in the editor (`PanelHost`), with the rest of the
// page untouched.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { lazy, Suspense } from "react";

import { PanelErrorBoundary } from "@paged-media/shell";

import { BUILT_IN_PANELS } from "../../src/panels/built-in-panels";
import { JournalPanel as EagerJournalPanel } from "../../src/panels/journal-panel";
import { mountPanel, unmountAll } from "./harness";

afterEach(() => {
  unmountAll();
  cleanup();
});

describe("a panel that loads when first shown", () => {
  test("the registry's entry is the deferred panel, and it shows the panel itself once loaded", async () => {
    const entry = BUILT_IN_PANELS.find((p) => p.id === "paged.journal")!;
    // Not the panel's own component: the entry does not import its module.
    expect(entry.component).not.toBe(EagerJournalPanel as never);
    const h = await mountPanel(entry, { document: "none" });
    for (
      let i = 0;
      i < 40 && !h.root.querySelector("[data-journal-summary]");
      i++
    )
      await h.settle();
    expect(h.root.querySelector("[data-journal-summary]")).not.toBeNull();
    expect(h.root.querySelector("[data-panel-loading]")).toBeNull();
  });

  test("a chunk that cannot be loaded is the panel's failure, not the editor's", async () => {
    const Broken = lazy(() =>
      Promise.reject(new Error("Failed to fetch dynamically imported module")),
    );
    const error = console.error;
    console.error = () => {};
    try {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(
          <div>
            <p data-test-rest>The rest of the editor</p>
            <PanelErrorBoundary id="test.broken" name="Broken">
              <Suspense fallback={<div data-panel-loading="" />}>
                <Broken />
              </Suspense>
            </PanelErrorBoundary>
          </div>,
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      const alert = view.container.querySelector(
        '[data-panel-error="test.broken"]',
      );
      expect(alert).not.toBeNull();
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(alert?.textContent).toContain("Broken stopped working.");
      expect(view.container.querySelector("[data-test-rest]")).not.toBeNull();
    } finally {
      console.error = error;
    }
  });
});
