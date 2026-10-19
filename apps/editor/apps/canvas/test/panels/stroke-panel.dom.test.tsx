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

// Stroke (paged.stroke): a composition of schema-driven fields over the
// element selection. Every control is asserted three ways: the exact
// mutation it sends, the model reading the new value back, and the field
// showing it. Multi-selection writes are ONE batch (one undo step).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { StrokePanel } from "../../src/panels/stroke-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(StrokePanel, { id: "paged.stroke", scene: richScene });

const addr = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

/** What one field shows: its input's text, or the active segment. */
function shown(h: H, path: string): string | null {
  const f = h.field(path);
  const input = f.querySelector("input");
  if (input) return input.value;
  const active = f.querySelector('[data-active="true"]');
  if (active) return active.getAttribute("data-option-value");
  const select = f.querySelector("select");
  return select ? select.value : null;
}

const FIELDS = [
  "frameStrokeWeight",
  "frameStrokeColor",
  "frameStrokeType",
  "frameStrokeEndCap",
  "frameStrokeJoin",
  "frameStrokeMiterLimit",
  "frameStrokeAlignment",
  "frameStrokeGapColor",
  "frameStrokeGapTint",
];

describe("Stroke panel: states", () => {
  test("nothing selected: every field is there and disabled", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    for (const path of FIELDS) {
      expect(h.field(path).getAttribute("data-binding-state")).toBe("none");
      for (const c of h
        .field(path)
        .querySelectorAll<HTMLInputElement>("input, select, button")) {
        expect(c.disabled).toBe(true);
      }
    }
  });

  test("a rectangle: the model's stroke, read back", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(shown(h, "frameStrokeWeight")).toBe("1 pt");
    expect(shown(h, "frameStrokeEndCap")).toBe("ButtEndCap");
    expect(shown(h, "frameStrokeMiterLimit")).toBe("4");
    expect(shown(h, "frameStrokeGapTint")).toBe("100 %");
    for (const path of FIELDS) {
      expect(h.field(path).getAttribute("data-binding-state")).toBe("value");
    }
  });

  test("two frames that disagree: the field reads mixed, the rest agree", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.mutate({
      op: "setElementProperty",
      args: {
        elementId: h.scene.groupA,
        path: "frameStrokeWeight",
        value: { type: "length", value: 3 },
      },
    } as never);
    await h.select([h.scene.rect, h.scene.groupA]);
    expect(
      h.field("frameStrokeWeight").getAttribute("data-binding-state"),
    ).toBe("mixed");
    expect(shown(h, "frameStrokeWeight")).toBe("—");
    expect(
      h.field("frameStrokeEndCap").getAttribute("data-binding-state"),
    ).toBe("value");
  });

  test("an oval: the same fields, read from the oval", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.mutate({
      op: "setElementProperty",
      args: {
        elementId: h.scene.oval,
        path: "frameStrokeWeight",
        value: { type: "length", value: 5 },
      },
    } as never);
    await h.select([h.scene.oval]);
    expect(shown(h, "frameStrokeWeight")).toBe("5 pt");
    for (const path of FIELDS) {
      if (path === "frameStrokeJoin" || path === "frameStrokeMiterLimit")
        continue;
      expect(h.field(path).getAttribute("data-binding-state")).toBe("value");
    }
  });
});

describe("Stroke panel: every control writes the model", () => {
  test("Weight: typing 3 sets frameStrokeWeight to 3 pt", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameStrokeWeight", "3");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameStrokeWeight", {
        type: "length",
        value: 3,
      }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameStrokeWeight")).toEqual({
      type: "length",
      value: 3,
    });
    expect(shown(h, "frameStrokeWeight")).toBe("3 pt");
  });

  test("Type: choosing Dashed writes the built-in stroke-style reference", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose("frameStrokeType", "StrokeStyle/$ID/Dashed");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameStrokeType", {
        type: "text",
        value: "StrokeStyle/$ID/Dashed",
      }),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameStrokeType")).toEqual({
      type: "text",
      value: "StrokeStyle/$ID/Dashed",
    });
  });

  for (const [path, value] of [
    ["frameStrokeEndCap", "RoundEndCap"],
    ["frameStrokeEndCap", "ProjectingEndCap"],
    ["frameStrokeJoin", "RoundEndJoin"],
    ["frameStrokeJoin", "BevelEndJoin"],
    ["frameStrokeAlignment", "InsideAlignment"],
    ["frameStrokeAlignment", "OutsideAlignment"],
  ] as const) {
    test(`${path}: the ${value} segment writes it and becomes the active one`, async () => {
      covers("panel:paged.stroke");
      const h = await mount();
      await h.select([h.scene.rect]);
      const from = h.mark();
      await h.press(path, value);
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), path, { type: "text", value }),
      ] as never);
      expect(await h.get(addr(h.scene.rect), path)).toEqual({
        type: "text",
        value,
      });
      expect(shown(h, path)).toBe(value);
    });
  }

  test("Miter limit: typing 10 writes it", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameStrokeMiterLimit", "10");
    const sent = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("frameStrokeMiterLimit");
    expect(sent[0].args.value.value).toBe(10);
    expect(shown(h, "frameStrokeMiterLimit")).toBe("10");
  });

  test("Gap tint: typing 50 writes it", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameStrokeGapTint", "50");
    const sent = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("frameStrokeGapTint");
    expect(sent[0].args.value.value).toBe(50);
    expect(shown(h, "frameStrokeGapTint")).toBe("50 %");
  });

  test("two frames: one edit is ONE batch over both, and one undo restores both", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const before = await h.get(addr(h.scene.rect), "frameStrokeWeight");
    const from = h.mark();
    await h.typeInto("frameStrokeWeight", "2");
    expect(h.mutations(from)).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            set(addr(h.scene.rect), "frameStrokeWeight", {
              type: "length",
              value: 2,
            }),
            set(addr(h.scene.groupA), "frameStrokeWeight", {
              type: "length",
              value: 2,
            }),
          ],
        },
      },
    ] as never);
    await h.act(() => h.client.undo());
    for (const id of [h.scene.rect, h.scene.groupA]) {
      expect(await h.get(addr(id), "frameStrokeWeight")).toEqual(before);
    }
    expect(shown(h, "frameStrokeWeight")).toBe("1 pt");
  });

  test("a disabled field sends nothing", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    const from = h.mark();
    const input = h.field("frameStrokeWeight").querySelector("input")!;
    await h.user.type(input, "5{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Stroke panel: findings", () => {
  // The engine answers noSuchPath for join and miter on an oval (they
  // are rectangle-only); a single object cannot disagree with itself.
  test.failing(
    "PN-3: an oval's Join and Miter limit read as not applicable, not as mixed",
    async () => {
      covers("panel:paged.stroke");
      const h = await mount();
      await h.select([h.scene.oval]);
      for (const path of ["frameStrokeJoin", "frameStrokeMiterLimit"]) {
        expect(h.field(path).getAttribute("data-binding-state")).not.toBe(
          "mixed",
        );
      }
    },
  );

  // UX audit F-22 / F-37: "Properties ▸ Stroke Type lists
  // StrokeStyle/$ID/Japanese Dots" — the panel shows the engine's ids.
  test.failing(
    "PN-1: Stroke Type option labels are human names, not StrokeStyle ids",
    async () => {
      covers("panel:paged.stroke");
      const h = await mount();
      await h.select([h.scene.rect]);
      const labels = [
        ...h.field("frameStrokeType").querySelectorAll("option"),
      ].map((o) => o.textContent ?? "");
      expect(labels.filter((l) => l.startsWith("StrokeStyle/"))).toEqual([]);
    },
  );

  // Typing into that field anyway sends a write the engine refuses
  // ("FrameStrokeMiterLimit is not supported on Oval"), and the field
  // shows the refusal as raw wire JSON.
  test.failing(
    "PN-4: a refused write is reported in words, not as the wire's JSON",
    async () => {
      covers("panel:paged.stroke");
      const h = await mount();
      await h.select([h.scene.oval]);
      await h.typeInto("frameStrokeMiterLimit", "9");
      expect(h.field("frameStrokeMiterLimit").textContent).not.toContain(
        '{"error"',
      );
    },
  );

  test.failing(
    "PN-2: toggle-group segments expose which one is on (aria-pressed)",
    async () => {
      covers("panel:paged.stroke");
      const h = await mount();
      await h.select([h.scene.rect]);
      const active = h
        .field("frameStrokeEndCap")
        .querySelector('[data-active="true"]')!;
      expect(active.getAttribute("aria-pressed")).toBe("true");
    },
  );
});
