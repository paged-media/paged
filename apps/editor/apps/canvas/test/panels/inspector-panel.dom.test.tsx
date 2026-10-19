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

// Inspector (paged.inspector): every property the engine reports for the
// ONE selected element, each as a schema-driven field (a path without a
// schema row would fall back to a raw editor marked data-schema="none").

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { InspectorPanel } from "../../src/panels/inspector-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(InspectorPanel, { id: "paged.inspector", scene: richScene });

const addr = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;
const rows = (h: H) =>
  [...h.root.querySelectorAll("[data-property]")].map((r) =>
    r.getAttribute("data-property"),
  );
const state = (h: PanelHarness<unknown>) =>
  h.root.querySelector("[data-inspector]")?.getAttribute("data-inspector");

describe("Inspector panel: states", () => {
  test("nothing selected: asks for an element", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    expect(state(h)).toBe("empty");
    expect(h.root.textContent).toBe("Select an element to inspect.");
  });

  test("no document: the same", async () => {
    covers("panel:paged.inspector");
    const h = await mountPanel(InspectorPanel, {
      id: "paged.inspector",
      document: "none",
    });
    expect(state(h)).toBe("empty");
  });

  test("two elements: it inspects one at a time, so it asks again", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval]);
    expect(state(h)).toBe("empty");
  });

  test("a rectangle: its kind, its id and one row per property the engine reports", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(state(h)).toBe("ready");
    expect(h.root.querySelector("[data-inspector-kind]")?.textContent).toBe(
      "Rectangle",
    );
    expect(h.root.querySelector("[data-inspector-id]")?.textContent).toBe(
      String(h.scene.rect.id),
    );
    const props = await h.props(h.scene.rect);
    expect(rows(h)).toEqual(Object.keys(props));
    // Every one of them has a schema row: no raw fallback editor.
    expect(h.root.querySelectorAll('[data-schema="none"]').length).toBe(0);
  });

  test("a text frame: its kind", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    expect(h.root.querySelector("[data-inspector-kind]")?.textContent).toBe(
      "TextFrame",
    );
  });

  test("the filter narrows the rows by path or label, and clearing it restores them", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect]);
    const all = rows(h);
    const filter = h.view.getByPlaceholderText("Filter properties");
    await h.user.type(filter, "miter");
    await h.settle();
    expect(rows(h)).toEqual(["frameStrokeMiterLimit"]);
    await h.user.clear(filter);
    await h.settle();
    expect(rows(h)).toEqual(all);
  });

  test("a value changed elsewhere shows here (re-read on every change)", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.mutate({
      op: "set",
      args: {
        address: addr(h.scene.rect),
        path: "frameStrokeWeight",
        value: { type: "length", value: 7 },
      },
    } as never);
    expect(h.field("frameStrokeWeight").querySelector("input")!.value).toBe(
      "7 pt",
    );
  });
});

describe("Inspector panel: rows write the element", () => {
  test("a length row: typing writes the path on the element", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameStrokeWeight", "5");
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: addr(h.scene.rect),
          path: "frameStrokeWeight",
          value: { type: "length", value: 5 },
        },
      },
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameStrokeWeight")).toEqual({
      type: "length",
      value: 5,
    });
  });

  test("a switch row: flipping writes the bool", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect]);
    const sw = h
      .field("frameNonprinting")
      .querySelector<HTMLElement>('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    const from = h.mark();
    await h.click(sw);
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: addr(h.scene.rect),
          path: "frameNonprinting",
          value: { type: "bool", value: true },
        },
      },
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameNonprinting")).toEqual({
      type: "bool",
      value: true,
    });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  test("a select row: choosing writes the enum", async () => {
    covers("panel:paged.inspector");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose("frameStrokeAlignment", "InsideAlignment");
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: addr(h.scene.rect),
          path: "frameStrokeAlignment",
          value: { type: "text", value: "InsideAlignment" },
        },
      },
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameStrokeAlignment")).toEqual({
      type: "text",
      value: "InsideAlignment",
    });
  });
});
