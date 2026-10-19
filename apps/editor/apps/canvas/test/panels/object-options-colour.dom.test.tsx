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

// The colour-resource options panels of src/panels/object-options-panels
// .tsx, schema-driven forms over each object's address (ADR 323):
//
//   Swatch Options          swatch:<id>        name, type, tint, alpha,
//                                               ink settings, and the
//                                               colour as ONE struct write
//   Gradient Options        gradient:<id>      name, type, the stops list
//   Color Group Options     colorGroup:<id>    name, members
//   Numbering List Options  numberingList:<id> name, continue flags
//
// (The other panels of that file are tested beside it.)

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { ComponentType } from "react";

import { CoreCommandDialog } from "../../src/core-command-dialog";
import {
  ColorGroupOptionsPanel,
  GradientOptionsPanel,
  NumberingListOptionsPanel,
  SwatchOptionsPanel,
} from "../../src/panels/object-options-panels";
import { apply, richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { optionLabels, rowsByName, runCoreCommand } from "./support/styles";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const picker = (h: H, id: string) =>
  h.root.querySelector<HTMLSelectElement>(`[data-options-picker="${id}"]`)!;
const optionsTarget = (h: H) =>
  h.root
    .querySelector("[data-options-target]")
    ?.getAttribute("data-options-target");
const sentSets = (h: H, from: number) =>
  h.mutations(from) as unknown as Array<{
    op: string;
    args: {
      address: string;
      path: string;
      value: { type: string; value: unknown };
    };
  }>;

// ------------------------------------------------------------ swatch options

describe("Swatch Options panel", () => {
  const mount = () =>
    mountPanel(SwatchOptionsPanel, {
      id: "paged.swatch-options",
      scene: richScene,
    });
  const colourValue = (h: H) =>
    h.root.querySelector<HTMLInputElement>("[data-swatch-color-value]")!;
  const pickRed = async (h: H) => h.choose(picker(h, "swatch"), h.scene.red);

  test("no document: no editable swatches", async () => {
    covers("panel:paged.swatch-options");
    const h = await mountPanel(SwatchOptionsPanel, {
      id: "paged.swatch-options",
      document: "none",
    });
    expect(h.root.querySelector("[data-options-empty]")?.textContent).toBe(
      "This document has no editable swatches.",
    );
  });

  test("the picker lists the document's swatches; a pick targets that swatch and seeds the colour", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    expect(optionLabels(picker(h, "swatch"))).toEqual(["Black", "Red", "Spot"]);
    await pickRed(h);
    expect(optionsTarget(h)).toBe(`swatch:${h.scene.red}`);
    expect(
      h.root.querySelector<HTMLSelectElement>("[data-swatch-color-space]")!
        .value,
    ).toBe("CMYK");
    expect(colourValue(h).value).toBe("0, 100, 100, 0");
    expect(h.field("name").querySelector("input")!.value).toBe("Red");
  });

  test("Apply colour writes the whole colour struct in one set; the model holds it", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    await pickRed(h);
    await h.user.clear(colourValue(h));
    await h.user.type(colourValue(h), "10, 100, 90, 0");
    const from = h.mark();
    await h.click(
      h.root.querySelector('[data-cockpit-action="swatch-color-apply"]')!,
    );
    const sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({
      address: `swatch:${h.scene.red}`,
      path: "color",
    });
    expect(sent[0].args.value.value).toMatchObject({
      space: "CMYK",
      value: [10, 100, 90, 0],
    });
    expect(await h.get(`swatch:${h.scene.red}`, "color")).toMatchObject({
      value: { space: "CMYK", value: [10, 100, 90, 0] },
    });
  });

  test("a value with the wrong number of components cannot be applied", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    await pickRed(h);
    await h.user.clear(colourValue(h));
    await h.user.type(colourValue(h), "10, 100");
    expect(colourValue(h).getAttribute("aria-invalid")).toBe("true");
    const apply = h.root.querySelector<HTMLButtonElement>(
      '[data-cockpit-action="swatch-color-apply"]',
    )!;
    expect(apply.disabled).toBe(true);
    const from = h.mark();
    await h.click(apply);
    expect(h.mutations(from)).toEqual([]);
  });

  test("switching the space to RGB applies an RGB colour as one write", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    await pickRed(h);
    await h.choose(
      h.root.querySelector("[data-swatch-color-space]") as HTMLElement,
      "RGB",
    );
    await h.user.clear(colourValue(h));
    await h.user.type(colourValue(h), "255, 0, 0");
    const from = h.mark();
    await h.click(
      h.root.querySelector('[data-cockpit-action="swatch-color-apply"]')!,
    );
    const sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.value.value).toMatchObject({
      space: "RGB",
      value: [255, 0, 0],
    });
  });

  test("Name writes the swatch's name; the picker follows", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    await pickRed(h);
    const from = h.mark();
    await h.typeInto("name", "Signal");
    expect(sentSets(h, from)).toEqual([
      {
        op: "set",
        args: {
          address: `swatch:${h.scene.red}`,
          path: "name",
          value: { type: "text", value: "Signal" },
        },
      },
    ] as never);
    expect((await rowsByName(h, "swatches")).get("Signal")).toBe(h.scene.red);
    expect(optionLabels(picker(h, "swatch"))).toContain("Signal");
  });

  test("Type: Spot makes the swatch a spot ink", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    await pickRed(h);
    const from = h.mark();
    await h.choose("model", "Spot");
    const sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({
      address: `swatch:${h.scene.red}`,
      path: "model",
    });
    expect(sent[0].args.value.value).toBe("Spot");
    const inks = (await h.client.collection("inks")) as Array<{
      spotId: string;
    }>;
    expect(inks.map((i) => i.spotId)).toContain(h.scene.red);
  });

  test("To process (Ink) writes the spot's output conversion", async () => {
    covers("panel:paged.swatch-options");
    const h = await mount();
    await h.choose(picker(h, "swatch"), h.scene.spot);
    const from = h.mark();
    await h.click(
      h.field("convertToProcess").querySelector('[role="switch"]')!,
    );
    const sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("convertToProcess");
    expect(sent[0].args.value.value).toBe(true);
    const inks = (await h.client.collection("inks")) as Array<{
      spotId: string;
      convertToProcess: boolean;
    }>;
    expect(inks.find((i) => i.spotId === h.scene.spot)?.convertToProcess).toBe(
      true,
    );
  });

  // A swatch with no tint of its own is at 100 %; the engine answers
  // "unset" (null) and the fields show 0 %.
  test.failing(
    "PN-164: Tint and Alpha of an untinted, opaque swatch read 100 %",
    async () => {
      covers("panel:paged.swatch-options");
      const h = await mount();
      await pickRed(h);
      expect(h.field("tint").querySelector("input")!.value).toBe("100 %");
      expect(h.field("alpha").querySelector("input")!.value).toBe("100 %");
    },
  );

  // The Swatches grid treats [Black] as reserved (no rename, no edit),
  // as InDesign does; Swatch Options offers it first and edits it.
  test.failing(
    "PN-165: Black is reserved here as in the Swatches grid (not offered for editing)",
    async () => {
      covers("panel:paged.swatch-options");
      const h = await mount();
      expect(optionLabels(picker(h, "swatch"))).not.toContain("Black");
    },
  );
});

// ---------------------------------------------------------- gradient options

describe("Gradient Options panel", () => {
  function WithForm() {
    return (
      <>
        <GradientOptionsPanel />
        <CoreCommandDialog />
      </>
    );
  }
  const mount = () =>
    mountPanel(WithForm as ComponentType<never>, {
      id: "paged.gradient-options",
      scene: richScene,
    });
  const address = (h: H) => `gradient:${h.scene.gradient}`;
  const items = (h: H) => [
    ...h.field("stops").querySelectorAll<HTMLElement>("[data-list-item]"),
  ];

  test("a blank document: no gradients, and Delete is disabled", async () => {
    covers("panel:paged.gradient-options");
    const h = await mountPanel(GradientOptionsPanel, {
      id: "paged.gradient-options",
    });
    expect(h.root.querySelector("[data-options-empty]")?.textContent).toBe(
      "This document has no gradients.",
    );
    expect(
      h.root.querySelector<HTMLButtonElement>(
        '[data-core-command-button="deleteGradient"]',
      )!.disabled,
    ).toBe(true);
  });

  test("the gradient's name, type and stops are its fields", async () => {
    covers("panel:paged.gradient-options");
    const h = await mount();
    expect(optionsTarget(h)).toBe(address(h));
    expect(optionLabels(picker(h, "gradient"))).toEqual(["Fade"]);
    expect(h.field("name").querySelector("input")!.value).toBe("Fade");
    expect(h.field("kind").querySelector("select")!.value).toBe("Linear");
    expect(items(h)).toHaveLength(2);
  });

  test("Name and Type are one set each on the gradient", async () => {
    covers("panel:paged.gradient-options");
    const h = await mount();
    const from = h.mark();
    await h.typeInto("name", "Sunset");
    await h.choose("kind", "Radial");
    const sent = sentSets(h, from);
    expect(
      sent.map((m) => [m.args.address, m.args.path, m.args.value.value]),
    ).toEqual([
      [address(h), "name", "Sunset"],
      [address(h), "kind", "Radial"],
    ]);
    expect((await h.client.gradientDetail(h.scene.gradient))?.kind).toBe(
      "radial",
    );
    expect((await rowsByName(h, "gradients")).get("Sunset")).toBe(
      h.scene.gradient,
    );
  });

  test("+ adds a stop: ONE set of the whole stops list (one undo step)", async () => {
    covers("panel:paged.gradient-options");
    const h = await mount();
    const from = h.mark();
    await h.click(h.field("stops").querySelector("[data-list-add]")!);
    const sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.path).toBe("stops");
    expect(sent[0].args.value.value as unknown[]).toHaveLength(3);
    expect(
      (await h.client.gradientDetail(h.scene.gradient))?.stops,
    ).toHaveLength(3);
    await h.act(() => h.client.undo());
    expect(
      (await h.client.gradientDetail(h.scene.gradient))?.stops,
    ).toHaveLength(2);
  });

  test("× removes a stop, ↓ moves one: each one set of the list", async () => {
    covers("panel:paged.gradient-options");
    const h = await mount();
    let from = h.mark();
    await h.click(items(h)[0].querySelector("[data-list-move-down]")!);
    let sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(
      (sent[0].args.value.value as Array<{ stopColor: string }>).map(
        (s) => s.stopColor,
      ),
    ).toEqual([h.scene.red, "Color/Black"]);
    from = h.mark();
    await h.click(items(h)[1].querySelector("[data-list-remove]")!);
    sent = sentSets(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.value.value as unknown[]).toHaveLength(1);
  });

  test("New… runs core.createGradient from its form; Delete runs core.deleteGradient on the picked gradient", async () => {
    covers(
      "panel:paged.gradient-options",
      "command:paged.core.createGradient",
      "command:paged.core.deleteGradient",
    );
    const h = await mount();
    await h.click(
      h.root.querySelector('[data-core-command-button="createGradient"]')!,
    );
    let from = h.mark();
    await runCoreCommand(h);
    expect(sentSets(h, from).map((m) => m.op)).toEqual(["createGradient"]);
    expect(optionLabels(picker(h, "gradient"))).toEqual([
      "Fade",
      "New gradient",
    ]);
    from = h.mark();
    await h.click(
      h.root.querySelector('[data-core-command-button="deleteGradient"]')!,
    );
    expect(h.mutations(from)).toEqual([
      { op: "deleteGradient", args: { gradientId: h.scene.gradient } },
    ] as never);
    expect([...(await rowsByName(h, "gradients")).values()]).not.toContain(
      h.scene.gradient,
    );
  });

  // UX audit F-22: the stops list titles each stop by its swatch's id.
  test.failing(
    "PN-166 (UX F-22): each stop is titled by its swatch's name, not its id",
    async () => {
      covers("panel:paged.gradient-options");
      const h = await mount();
      const titles = [
        ...h.field("stops").querySelectorAll("[data-list-item-title]"),
      ].map((t) => t.textContent ?? "");
      expect(titles.some((t) => t.startsWith("Color/"))).toBe(false);
    },
  );
});

// ------------------------------------------------------- colour group options

describe("Color Group Options panel", () => {
  const mount = () =>
    mountPanel(ColorGroupOptionsPanel, {
      id: "paged.color-group-options",
      scene: richScene,
    });

  test("a blank document: no color groups", async () => {
    covers("panel:paged.color-group-options");
    const h = await mountPanel(ColorGroupOptionsPanel, {
      id: "paged.color-group-options",
    });
    expect(h.root.querySelector("[data-options-empty]")?.textContent).toBe(
      "This document has no color groups.",
    );
  });

  test("the group is picked by name; Name is one set on it", async () => {
    covers("panel:paged.color-group-options");
    const h = await mount();
    expect(optionLabels(picker(h, "colorGroup"))).toEqual(["Brand"]);
    expect(optionsTarget(h)).toBe(`colorGroup:${h.scene.colorGroup}`);
    const from = h.mark();
    await h.typeInto("name", "House");
    expect(sentSets(h, from)).toEqual([
      {
        op: "set",
        args: {
          address: `colorGroup:${h.scene.colorGroup}`,
          path: "name",
          value: { type: "text", value: "House" },
        },
      },
    ] as never);
    expect((await rowsByName(h, "colorGroups")).get("House")).toBe(
      h.scene.colorGroup,
    );
  });

  // UX audit F-22: the members field is the raw JSON of swatch ids.
  test.failing(
    "PN-167 (UX F-22): the group's swatches read as names, not as JSON of ids",
    async () => {
      covers("panel:paged.color-group-options");
      const h = await mount();
      const shown =
        h.field("members").querySelector("input")?.value ??
        h.field("members").textContent ??
        "";
      expect(shown).not.toContain("Color/");
    },
  );
});

// ----------------------------------------------------- numbering list options

describe("Numbering List Options panel", () => {
  const withList = async (ctx: Parameters<typeof richScene>[0]) => {
    const s = await richScene(ctx);
    await apply(ctx.client, {
      op: "createNumberingList",
      args: { spec: { name: "Steps", continueAcrossStories: false } },
    } as never);
    return s;
  };
  const mount = () =>
    mountPanel(NumberingListOptionsPanel, {
      id: "paged.numbering-list-options",
      scene: withList,
    });

  test("a document without numbering lists says so", async () => {
    covers("panel:paged.numbering-list-options");
    const h = await mountPanel(NumberingListOptionsPanel, {
      id: "paged.numbering-list-options",
      scene: richScene,
    });
    expect(h.root.querySelector("[data-options-empty]")?.textContent).toBe(
      "This document has no numbering lists.",
    );
  });

  test("a list is picked by name; Name and Continue across stories write it", async () => {
    covers("panel:paged.numbering-list-options");
    const h = await mount();
    expect(optionLabels(picker(h, "numberingList"))).toEqual(["Steps"]);
    const address = optionsTarget(h)!;
    expect(address.startsWith("numberingList:")).toBe(true);
    const from = h.mark();
    await h.typeInto("name", "Procedure");
    await h.click(
      h.field("continueAcrossStories").querySelector('[role="switch"]')!,
    );
    const sent = sentSets(h, from);
    expect(
      sent.map((m) => [m.args.address, m.args.path, m.args.value.value]),
    ).toEqual([
      [address, "name", "Procedure"],
      [address, "continueAcrossStories", true],
    ]);
    expect(await h.get(address, "continueAcrossStories")).toMatchObject({
      value: true,
    });
    expect(
      (await rowsByName(h, "numberingLists")).get("Procedure"),
    ).toBeDefined();
  });
});
