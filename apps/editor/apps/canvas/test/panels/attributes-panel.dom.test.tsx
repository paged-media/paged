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

// Attributes (paged.attributes): Visible, Locked, Nonprinting, the two
// overprints, and the selected object's script labels (the x-paged:
// namespace is written here; other labels are read only).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { AttributesPanel } from "../../src/panels/attributes-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, batch, bool, set, state } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(AttributesPanel, { id: "paged.attributes", scene: richScene });

const ROWS: ReadonlyArray<[string, string]> = [
  ["Visible", "elementVisible"],
  ["Locked", "elementLocked"],
  ["Nonprinting", "frameNonprinting"],
  ["Overprint fill", "frameOverprintFill"],
  ["Overprint stroke", "frameOverprintStroke"],
];

const toggle = (h: H, label: string) =>
  h.root.querySelector<HTMLElement>(
    `[data-check-row="${label}"] [role="switch"]`,
  )!;
const newKey = (h: H) =>
  h.root.querySelector<HTMLInputElement>("[data-label-new-key]")!;
const addButton = (h: H) =>
  h.root.querySelector<HTMLButtonElement>("[data-label-add]")!;

describe("Attributes panel: states", () => {
  test("nothing selected: every switch disabled, no labels section", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    for (const [label, path] of ROWS) {
      expect(state(h, path)).toBe("none");
      expect((toggle(h, label) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(h.root.querySelector('[data-section="Labels"]')).toBeNull();
  });

  test("a plain rectangle: visible, unlocked, printing, no overprint", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(toggle(h, "Visible").getAttribute("aria-checked")).toBe("true");
    for (const label of [
      "Locked",
      "Nonprinting",
      "Overprint fill",
      "Overprint stroke",
    ]) {
      expect(toggle(h, label).getAttribute("aria-checked")).toBe("false");
    }
    expect(h.root.querySelector("[data-labels-empty]")?.textContent).toBe(
      "No labels on this object.",
    );
  });

  test("the locked and the hidden frame read as such", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    await h.select([h.scene.locked]);
    expect(toggle(h, "Locked").getAttribute("aria-checked")).toBe("true");
    await h.select([h.scene.hidden]);
    expect(toggle(h, "Visible").getAttribute("aria-checked")).toBe("false");
  });

  test("a locked frame and a plain one: Locked reads mixed", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    await h.select([h.scene.locked, h.scene.rect]);
    expect(state(h, "elementLocked")).toBe("mixed");
    expect(state(h, "frameOverprintFill")).toBe("value");
    // Labels are per object: two selected, no labels section.
    expect(h.root.querySelector('[data-section="Labels"]')).toBeNull();
  });
});

describe("Attributes panel: every control writes the selection", () => {
  for (const [label, path] of ROWS) {
    test(`${label}: the switch flips ${path}`, async () => {
      covers("panel:paged.attributes");
      const h = await mount();
      await h.select([h.scene.rect]);
      const was = toggle(h, label).getAttribute("aria-checked") === "true";
      const from = h.mark();
      await h.click(toggle(h, label));
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), path, bool(!was)),
      ] as never);
      expect(await h.get(addr(h.scene.rect), path)).toEqual(bool(!was));
      expect(toggle(h, label).getAttribute("aria-checked")).toBe(String(!was));
    });
  }

  test("two frames: one batch, one undo restores both", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const before = await h.get(addr(h.scene.rect), "frameNonprinting");
    const from = h.mark();
    await h.click(toggle(h, "Nonprinting"));
    expect(h.mutations(from)).toEqual([
      batch(
        set(addr(h.scene.rect), "frameNonprinting", bool(true)),
        set(addr(h.scene.groupA), "frameNonprinting", bool(true)),
      ),
    ] as never);
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.rect), "frameNonprinting")).toEqual(before);
    expect(await h.get(addr(h.scene.groupA), "frameNonprinting")).toEqual(
      before,
    );
  });

  test("Add label: disabled until a key is typed, then writes an x-paged: label", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(addButton(h).disabled).toBe(true);
    await h.user.type(newKey(h), "my.tool");
    await h.settle();
    expect(addButton(h).disabled).toBe(false);
    const from = h.mark();
    await h.click(addButton(h));
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { address: string; path: string; value: { value: string } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("set");
    expect(sent[0].args.address).toBe(addr(h.scene.rect));
    expect(sent[0].args.path).toBe("labels[x-paged:my.tool]");
    expect(sent[0].args.value.value).toBe('{"v":1,"data":{}}');
    // The label is on the object now, and listed as an editable field.
    expect(await h.get(addr(h.scene.rect), "labels[x-paged:my.tool]")).toEqual({
      type: "text",
      value: '{"v":1,"data":{}}',
    });
    expect(h.hasField("labels[x-paged:my.tool]")).toBe(true);
    expect(newKey(h).value).toBe("");
  });

  test("a disabled switch sends nothing", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    const from = h.mark();
    await h.click(toggle(h, "Locked"));
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Attributes panel: findings", () => {
  // PN-259 (fixed, R1): InDesign's Nonprinting applies to any page item;
  // the engine had no frameNonprinting on an oval (noSuchPath), so an
  // oval alone read "mixed" and its switch wrote what it could not hold.
  test("PN-259: an oval can be made nonprinting, as any page item", async () => {
    covers("panel:paged.attributes");
    const h = await mount();
    await h.select([h.scene.oval]);
    expect(state(h, "frameNonprinting")).toBe("value");
    expect(await h.get(addr(h.scene.oval), "frameNonprinting")).toEqual(
      bool(false),
    );
  });

  // Gap color is a seam "awaiting engine support", but frameStrokeGapColor
  // is on the wire: the Stroke panel reads and writes it on this frame.
  test.failing(
    "PN-258: Gap color is live, as the engine reads and writes frameStrokeGapColor",
    async () => {
      covers("panel:paged.attributes");
      const h = await mount();
      await h.select([h.scene.rect]);
      expect(await h.get(addr(h.scene.rect), "frameStrokeGapColor")).toEqual({
        type: "colorRef",
        value: null,
      });
      expect(
        h.root.querySelector('[title="Gap colour — awaiting engine support"]'),
      ).toBeNull();
    },
  );
});
