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

// The Layout variants panel (editor ADR 1235): without a library document
// it says to save first; with one it lists the main layout and its
// variants, marks the open one, and New variant… branches the open layout.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { DocumentEntry, VariantEntry } from "@paged-media/repository";
import {
  setCurrentLibraryDocument,
  setCurrentLibraryRef,
  setLibrary,
} from "@paged-media/shell";

import { VariantsPanel } from "../../src/panels/variants-panel";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const doc: DocumentEntry = {
  id: "doc-1",
  name: "Brochure",
  createdAt: 0,
  updatedAt: 0,
  head: "a".repeat(64),
};

const variant = (slug: string, name: string): VariantEntry => ({
  slug,
  name,
  ref: `drafts/user:local/variants/${slug}`,
  head: "b".repeat(64),
  createdAt: 1,
  base: "a".repeat(64),
});

describe("Layout variants", () => {
  test("lists main and the variants, marks the open one, and branches the open layout", async () => {
    covers("panel:paged.variants");
    const none = await mountPanel(VariantsPanel, {
      id: "paged.variants",
      document: "blank",
    });
    expect(none.root.querySelector("[data-variants-unsaved]")).not.toBeNull();
    unmountAll();

    const h = await mountPanel(VariantsPanel, {
      id: "paged.variants",
      document: "blank",
    });
    const list = [variant("compact", "Compact")];
    const made: Array<{ name: string; bytes: number }> = [];
    await h.act(() => {
      setLibrary(h.scope, {
        // A fresh array per call, as the library answers (its `variants`
        // maps the stored list): the panel keeps what it was handed, and
        // a compiled panel re-renders only for a new list.
        variants: async () => [...list],
        createVariant: async (_id: string, name: string, bytes: Uint8Array) => {
          made.push({ name, bytes: bytes.length });
          const v = variant("image-heavy", name);
          list.push(v);
          return v;
        },
      } as never);
      setCurrentLibraryDocument(h.scope, doc);
      setCurrentLibraryRef(h.scope, list[0]!.ref);
    });
    for (
      let i = 0;
      i < 20 && !h.root.querySelector('[data-variant-row="compact"]');
      i++
    )
      await h.settle();
    expect(
      [...h.root.querySelectorAll("[data-variant-row]")].map((r) =>
        r.getAttribute("data-variant-row"),
      ),
    ).toEqual(["main", "compact"]);
    expect(
      h.root
        .querySelector('[data-variant-row="compact"]')
        ?.getAttribute("data-variant-open"),
    ).toBe("true");
    // Shared changes are applied from the main layout only.
    expect(
      (h.root.querySelector("[data-variant-shared-plan]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await h.user.click(h.root.querySelector("[data-variant-new]")!);
    await h.user.type(
      h.root.querySelector("[data-variant-name]")!,
      "Image heavy",
    );
    await h.user.click(h.root.querySelector("[data-variant-create]")!);
    for (
      let i = 0;
      i < 20 && !h.root.querySelector('[data-variant-row="image-heavy"]');
      i++
    )
      await h.settle();
    expect(made.map((m) => m.name)).toEqual(["Image heavy"]);
    expect(made[0]!.bytes).toBeGreaterThan(0);
    expect(
      h.root.querySelector('[data-variant-row="image-heavy"]'),
    ).not.toBeNull();
  });
});
