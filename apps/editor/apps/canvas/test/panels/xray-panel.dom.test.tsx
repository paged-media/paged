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

// Document X-Ray's "Why?" inspector (editor ADR 1226): the engine's facts
// for the caret's text and the selected item, shown as they come — the
// winning style level per property and what a local override overrides,
// the lock with its reason and Unlock, the picture, the flow, what a style
// edit changes. Explaining sends reads only.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { formatValue, sourceKey, XRayPanel } from "../../src/panels/xray-panel";
import { mountPanel, unmountAll } from "./harness";
import { XRAY, xrayFixture } from "../../tests/e2e/harness/xray-idml";

afterEach(unmountAll);

const mount = () =>
  mountPanel(XRayPanel, { id: "paged.xray", document: xrayFixture() });

const attr = (root: Element, sel: string, name: string) =>
  root.querySelector(sel)?.getAttribute(name) ?? null;

describe("Document X-Ray", () => {
  test("empty: asks for a selection", async () => {
    covers("panel:paged.xray");
    const h = await mountPanel(XRayPanel, { id: "paged.xray" });
    expect(h.root.querySelector("[data-xray-empty]")).not.toBeNull();
  });

  test("the caret's text: the style that wins, what an override overrides, the dependents", async () => {
    covers("panel:paged.xray");
    const h = await mount();
    const from = h.mark();
    await h.caret(XRAY.text.story, 3);
    await h.settle();
    const fill = '[data-xray-property="fillColor"]';
    expect(attr(h.root, fill, "data-xray-source")).toBe("style:Body");
    expect(attr(h.root, fill, "data-xray-value")).toBe("Red");
    expect(
      h.root.querySelector('[data-xray-chain-names="Body>Base"]'),
    ).not.toBeNull();
    const deps = '[data-xray-dependents="Body"]';
    expect(attr(h.root, deps, "data-xray-uses")).toBe("2");
    await h.caret(XRAY.text.story, 12);
    await h.settle();
    const size = '[data-xray-property="pointSize"]';
    expect(attr(h.root, size, "data-xray-source")).toBe("character");
    expect(attr(h.root, size, "data-xray-override")).toBe("true");
    expect(attr(h.root, size, "data-xray-value")).toBe("14 pt");
    // Reads only: nothing was written.
    expect(h.mutations(from)).toEqual([]);
  });

  test("a locked item says why and unlocks in one write", async () => {
    covers("panel:paged.xray");
    const h = await mount();
    await h.select([{ kind: "rectangle", id: XRAY.locked }]);
    await h.settle();
    expect(h.root.querySelector('[data-xray-lock="item"]')).not.toBeNull();
    expect(
      attr(h.root, '[data-xray-property="fillColor"]', "data-xray-source"),
    ).toBe("style:Box");
    const from = h.mark();
    await h.click(h.root.querySelector("[data-xray-unlock]")!);
    await h.settle();
    expect(h.mutations(from).length).toBe(1);
    expect(h.root.querySelector('[data-xray-lock="item"]')).toBeNull();
    await h.select([{ kind: "rectangle", id: XRAY.lockedLayer }]);
    await h.settle();
    expect(
      h.root.querySelector('[data-xray-lock="layer"]')?.textContent,
    ).toContain(XRAY.layerLock.name);
  });

  test("a picture and a thread: the link, the shared file, the overset", async () => {
    covers("panel:paged.xray");
    const h = await mount();
    await h.select([{ kind: "rectangle", id: XRAY.pictures[0] }]);
    await h.settle();
    expect(
      attr(h.root, "[data-xray-link-status]", "data-xray-link-status"),
    ).toBe("missing");
    expect(attr(h.root, "[data-xray-same-link]", "data-xray-same-link")).toBe(
      "1",
    );
    await h.select([{ kind: "textFrame", id: XRAY.thread.last }]);
    await h.settle();
    expect(
      Number(attr(h.root, "[data-xray-overset]", "data-xray-overset")),
    ).toBeGreaterThan(0);
    expect(
      attr(h.root, "[data-xray-frame-index]", "data-xray-frame-index"),
    ).toBe("1");
  });

  test("values and sources read as the user sees them", () => {
    expect(formatValue("Color/Red")).toBe("Red");
    expect(formatValue(12.345, "pt")).toBe("12.35 pt");
    expect(formatValue(null)).toBe("—");
    expect(sourceKey({ kind: "default" })).toBe("default");
    expect(
      sourceKey({
        kind: "style",
        style: { collection: "paragraph", id: "P/Body", name: "Body" },
        depth: 1,
      }),
    ).toBe("style:Body");
  });
});
