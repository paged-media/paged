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

// Swatches (paged.swatches): the Fill apply picker (a schema-driven
// field on the selection's frameFillColor) over the document swatch
// grid: new, rename, delete, the edit popover, colour-group assign and
// the bundled libraries. Every write is core's own op, asserted on the
// wire and read back from the model.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { SwatchesPanel } from "../../src/panels/swatches-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { rowsByName, settleTimers } from "./support/styles";

afterEach(() => {
  unmountAll();
  unstubAllGlobals();
});

const mount = () =>
  mountPanel(SwatchesPanel, { id: "paged.swatches", scene: richScene });

const row = (h: PanelHarness<unknown>, selfId: string) => {
  const el = h.root.querySelector<HTMLElement>(
    `[data-swatch-id="${CSS.escape(selfId)}"]`,
  );
  if (!el) throw new Error(`no swatch row ${selfId}`);
  return el;
};
const hasRow = (h: PanelHarness<unknown>, selfId: string) =>
  h.root.querySelector(`[data-swatch-id="${CSS.escape(selfId)}"]`) !== null;

const fillSelect = (h: PanelHarness<unknown>) =>
  h.field("frameFillColor").querySelector("select") as HTMLSelectElement;

describe("Swatches panel: states", () => {
  test("no document: the grid says it is empty", async () => {
    covers("panel:paged.swatches");
    const h = await mountPanel(SwatchesPanel, {
      id: "paged.swatches",
      document: "none",
    });
    expect(h.root.querySelector('[data-swatches="empty"]')).not.toBeNull();
    expect(h.engine.errors).toEqual([]);
  });

  test("a blank document: Black is listed and reserved (no edit, rename, group or delete)", async () => {
    covers("panel:paged.swatches");
    const h = await mountPanel(SwatchesPanel, { id: "paged.swatches" });
    const black = row(h, "Color/Black");
    expect(black.getAttribute("data-swatch-reserved")).toBe("true");
    expect(
      black.querySelector<HTMLButtonElement>('[data-action="edit-swatch"]')!
        .disabled,
    ).toBe(true);
    expect(black.querySelector('[data-action="remove-swatch"]')).toBeNull();
    expect(black.querySelector('[data-action="assign-group"]')).toBeNull();
    await h.user.dblClick(black.querySelector("[data-swatch-name]")!);
    expect(black.querySelector("[data-swatch-rename-input]")).toBeNull();
  });

  test("nothing selected: the Fill picker has no target", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    expect(fillSelect(h).disabled).toBe(true);
    expect(h.field("frameFillColor").getAttribute("data-binding-state")).toBe(
      "none",
    );
  });

  test("the grid: groups as headers with their members, the rest below, with kind badges", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    const group = h.root.querySelector(
      `[data-swatch-group="${CSS.escape(h.scene.colorGroup)}"]`,
    )!;
    expect(group.textContent).toContain("Brand");
    expect(
      group.querySelector(`[data-swatch-id="${CSS.escape(h.scene.red)}"]`),
    ).not.toBeNull();
    expect(
      row(h, h.scene.spot).querySelector("[data-swatch-kind]")?.textContent,
    ).toBe("spot");
    expect(
      row(h, h.scene.red).querySelector("[data-swatch-kind]")?.textContent,
    ).toBe("process");
  });
});

describe("Swatches panel: controls", () => {
  test("Fill: picking Red sets the frame's fill colour ref, read back and shown", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    await h.select([h.scene.rect]);
    const address = `rectangle:${String(h.scene.rect.id)}`;
    const from = h.mark();
    await h.choose(fillSelect(h), h.scene.red);
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address,
          path: "frameFillColor",
          value: { type: "colorRef", value: h.scene.red },
        },
      },
    ] as never);
    expect(await h.get(address, "frameFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.red,
    });
    expect(fillSelect(h).value).toBe(h.scene.red);
  });

  test("Fill over two frames is one batch", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval]);
    const from = h.mark();
    await h.choose(fillSelect(h), h.scene.spot);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { ops: unknown[] };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("batch");
    expect(sent[0].args.ops).toHaveLength(2);
  });

  test("+ New creates a process-black swatch named New swatch and lists it", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="add-swatch"]')!);
    expect(h.mutations(from)).toEqual([
      {
        op: "createSwatch",
        args: {
          spec: {
            name: "New swatch",
            space: "CMYK",
            value: [0, 0, 0, 100],
            model: "Process",
          },
        },
      },
    ] as never);
    const created = (await rowsByName(h, "swatches")).get("New swatch");
    expect(created).toBeDefined();
    expect(row(h, created!).textContent).toContain("New swatch");
  });

  test("✕ deletes the swatch from the document and the grid", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    const from = h.mark();
    await h.click(
      row(h, h.scene.spot).querySelector('[data-action="remove-swatch"]')!,
    );
    expect(h.mutations(from)).toEqual([
      { op: "deleteSwatch", args: { swatchId: h.scene.spot } },
    ] as never);
    expect([...(await rowsByName(h, "swatches")).values()]).not.toContain(
      h.scene.spot,
    );
    expect(hasRow(h, h.scene.spot)).toBe(false);
  });

  test("double-click renames: Enter writes the name with the colour untouched", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    await h.user.dblClick(
      row(h, h.scene.red).querySelector("[data-swatch-name]")!,
    );
    const input = row(h, h.scene.red).querySelector<HTMLInputElement>(
      "[data-swatch-rename-input]",
    )!;
    const from = h.mark();
    await h.user.clear(input);
    await h.user.type(input, "Brand red{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([
      {
        op: "editSwatch",
        args: {
          swatchId: h.scene.red,
          spec: {
            selfId: h.scene.red,
            name: "Brand red",
            space: "CMYK",
            value: [0, 100, 100, 0],
            model: "Process",
            alternateSpace: null,
            alternateValue: [],
            tint: null,
            alpha: null,
          },
        },
      },
    ] as never);
    expect((await rowsByName(h, "swatches")).get("Brand red")).toBe(
      h.scene.red,
    );
    expect(
      row(h, h.scene.red).querySelector("[data-swatch-name]")?.textContent,
    ).toBe("Brand red");
  });

  test("Escape leaves a rename without writing", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    await h.user.dblClick(
      row(h, h.scene.red).querySelector("[data-swatch-name]")!,
    );
    const input = row(h, h.scene.red).querySelector<HTMLInputElement>(
      "[data-swatch-rename-input]",
    )!;
    const from = h.mark();
    await h.user.type(input, "zzz{Escape}");
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
    expect(
      row(h, h.scene.red).querySelector("[data-swatch-rename-input]"),
    ).toBeNull();
  });

  test("assigning a group moves the swatch into it (editColorGroup with the new members)", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    const from = h.mark();
    await h.choose(
      row(h, h.scene.spot).querySelector(
        '[data-action="assign-group"]',
      ) as HTMLElement,
      h.scene.colorGroup,
    );
    expect(h.mutations(from)).toEqual([
      {
        op: "editColorGroup",
        args: {
          groupId: h.scene.colorGroup,
          spec: {
            selfId: h.scene.colorGroup,
            name: "Brand",
            members: [h.scene.red, h.scene.spot],
          },
        },
      },
    ] as never);
    const groups = (await h.client.collection("colorGroups")) as Array<{
      selfId: string;
      members: string[];
    }>;
    expect(groups[0].members).toEqual([h.scene.red, h.scene.spot]);
    const group = h.root.querySelector(
      `[data-swatch-group="${CSS.escape(h.scene.colorGroup)}"]`,
    )!;
    expect(
      group.querySelector(`[data-swatch-id="${CSS.escape(h.scene.spot)}"]`),
    ).not.toBeNull();
  });

  test("the — group takes the swatch out of its group", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    const from = h.mark();
    await h.choose(
      row(h, h.scene.red).querySelector(
        '[data-action="assign-group"]',
      ) as HTMLElement,
      "",
    );
    expect(h.mutations(from)).toEqual([
      {
        op: "editColorGroup",
        args: {
          groupId: h.scene.colorGroup,
          spec: { selfId: h.scene.colorGroup, name: "Brand", members: [] },
        },
      },
    ] as never);
    expect(
      h.root.querySelector(
        `[data-swatch-group="${CSS.escape(h.scene.colorGroup)}"]`,
      ),
    ).toBeNull();
  });

  test("the chip opens the editor seeded with the raw channels; a channel edit writes editSwatch", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    await settleTimers(h);
    await h.click(
      row(h, h.scene.red).querySelector('[data-action="edit-swatch"]')!,
    );
    const editor = document.querySelector<HTMLElement>("[data-swatch-editor]")!;
    expect(editor).not.toBeNull();
    const inputs = [
      ...editor.querySelectorAll<HTMLInputElement>(
        "[data-mixer-channel] input",
      ),
    ];
    expect(inputs.map((i) => i.value)).toEqual(["0", "100", "100", "0"]);
    const from = h.mark();
    await h.typeInto(inputs[3], "20");
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { swatchId: string; spec: { value: number[]; space: string } };
    }>;
    expect(sent.map((m) => m.op)).toEqual(["editSwatch"]);
    expect(sent[0].args.swatchId).toBe(h.scene.red);
    expect(sent[0].args.spec.space).toBe("CMYK");
    expect(sent[0].args.spec.value).toEqual([0, 100, 100, 20]);
    expect(await h.get(`swatch:${h.scene.red}`, "color")).toMatchObject({
      value: { space: "CMYK", value: [0, 100, 100, 20] },
    });
  });

  test("Libraries: the menu lists the bundled libraries, the filter narrows it, a pick imports it as one op", async () => {
    covers("panel:paged.swatches");
    // The library's URL is its file (test/vite-shim.ts); the browser
    // fetches it, the test reads it.
    stubGlobal("fetch", async (url: string) => {
      const bytes = readFileSync(url);
      return {
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
      };
    });
    const h = await mount();
    await h.click(h.root.querySelector('[data-action="open-libraries"]')!);
    const menu = document.querySelector<HTMLElement>("[data-libraries-menu]")!;
    expect(menu.querySelectorAll("[data-library-id]").length).toBeGreaterThan(
      10,
    );
    expect(menu.querySelector("[data-hlc-attribution]")).not.toBeNull();
    await h.user.type(
      menu.querySelector<HTMLInputElement>("[data-libraries-filter]")!,
      "Hi-Pearl",
    );
    const picks = [
      ...menu.querySelectorAll<HTMLButtonElement>("[data-library-id]"),
    ];
    expect(picks.map((b) => b.textContent)).toEqual(["LGChem Hi-Pearl Film"]);
    const before = (await h.client.collection("swatches")).length;
    const from = h.mark();
    await h.click(picks[0]);
    await settleTimers(h, 50);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { groupName: string; bytes: number[] };
    }>;
    expect(sent.map((m) => m.op)).toEqual(["importSwatchLibrary"]);
    expect(sent[0].args.groupName).toBe("LGChem Hi-Pearl Film");
    expect(sent[0].args.bytes.length).toBe(222);
    expect((await h.client.collection("swatches")).length).toBeGreaterThan(
      before,
    );
    expect(document.querySelector("[data-libraries-menu]")).toBeNull();
  });
});

describe("Swatches panel: findings", () => {
  // The delete control's accessible name is its glyph; the words are
  // only in the title, which a name computed from content ignores.
  test.failing(
    'PN-155: a swatch\'s delete button is named in words, not "✕"',
    async () => {
      covers("panel:paged.swatches");
      const h = await mount();
      const del = row(h, h.scene.red).querySelector(
        '[data-action="remove-swatch"]',
      )!;
      expect(del.getAttribute("aria-label") ?? del.textContent).not.toBe("✕");
    },
  );
});
