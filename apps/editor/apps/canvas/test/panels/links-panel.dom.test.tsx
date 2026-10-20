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

// Links (paged.links): the placed-image links with their status (a dot,
// a "missing" badge), colour space and resolution; the toolbar is three
// seams (update, relink history, go to link).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { LinksPanel } from "../../src/panels/links-panel";
import { mountPanel, unmountAll } from "./harness";
import {
  rows,
  seamButtons,
  structureIdml,
  STRUCTURE,
} from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(LinksPanel, { id: "paged.links", document });

describe("Links panel: states", () => {
  test("no document: the empty state and the three seams", async () => {
    covers("panel:paged.links");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-links]")?.textContent).toBe(
      "No image links in this document.",
    );
    expect(
      seamButtons(h.root).map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Update link — awaiting engine support",
      "Relink history — awaiting engine support",
      "Go to link — awaiting engine support",
    ]);
  });

  test("a missing link: the file name, the host kind, the missing badge", async () => {
    covers("panel:paged.links");
    const h = await mount();
    expect(rows(h.root)).toEqual([
      {
        key: STRUCTURE.imageFrame.id,
        primary: "photo.jpg",
        secondary: "Rectangle",
        badge: "missing",
        selected: false,
      },
    ]);
  });

  test("no filter box for a short list", async () => {
    covers("panel:paged.links");
    const h = await mount();
    expect(h.root.querySelector("[data-list-search]")).toBeNull();
  });

  test("follows the model: a frame given an image is listed", async () => {
    covers("panel:paged.links");
    const h = await mount();
    const placed = await h.mutate({
      op: "insertFrame",
      args: { pageId: STRUCTURE.page2, bounds: [72, 72, 200, 200] },
    } as never);
    const frame = (placed as { payload: { createdId: { id: string } } }).payload
      .createdId;
    await h.mutate({
      op: "placeImage",
      args: { elementId: frame.id, uri: "file:///nowhere/second.png" },
    } as never);
    expect(rows(h.root).map((r) => r.primary)).toEqual([
      "photo.jpg",
      "second.png",
    ]);
  });

  test("an EPS whose bytes are there is not drawn, not missing (engine ADR 207)", async () => {
    covers("panel:paged.links");
    const h = await mount();
    const placed = await h.mutate({
      op: "insertFrame",
      args: { pageId: STRUCTURE.page2, bounds: [72, 72, 200, 200] },
    } as never);
    const frame = (placed as { payload: { createdId: { id: string } } }).payload
      .createdId;
    await h.mutate({
      op: "placeImage",
      args: { elementId: frame.id, uri: "file:///assets/legacy.eps" },
    } as never);
    const eps = new TextEncoder().encode(
      "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 72 72\n%%EOF\n",
    );
    await h.mutate({
      op: "replaceImageBytes",
      args: { elementId: frame.id, bytes: Array.from(eps) },
    } as never);
    expect(
      rows(h.root).map((r) => ({ primary: r.primary, badge: r.badge })),
    ).toEqual([
      { primary: "photo.jpg", badge: "missing" },
      { primary: "legacy.eps", badge: "not drawn" },
    ]);
  });
});

describe("Links panel: controls", () => {
  test("the three toolbar buttons are disabled and send nothing", async () => {
    covers("panel:paged.links");
    const h = await mount();
    const from = h.mark();
    for (const b of seamButtons(h.root)) {
      expect(b.disabled).toBe(true);
      await h.click(b);
    }
    expect(h.mutations(from)).toEqual([]);
  });
});
