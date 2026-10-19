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

// Color settings (paged.color-settings): the CMYK working space, rendering
// intent and black-point compensation (setColorSettings), the soft-proof
// setup (setProofSetup), and "Add profile (.icc)…", which registers a
// picked file as a colour profile. The file picker is the browser's; the
// test hands the panel's own file input a file the way a pick does.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ColorSettingsPanel } from "../../src/panels/color-settings-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

const originalClick = HTMLInputElement.prototype.click;
afterEach(() => {
  HTMLInputElement.prototype.click = originalClick;
  unmountAll();
});

type H = PanelHarness<unknown>;

const mount = () =>
  mountPanel(ColorSettingsPanel, { id: "paged.color-settings" });

const setting = <T extends HTMLElement>(h: H, name: string) =>
  h.root.querySelector<T>(`[data-setting="${name}"]`)!;

/** Make the next file picker the panel opens "pick" `file`. */
function pickOnClick(file: File): void {
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    if (this.type !== "file") return originalClick.call(this);
    Object.defineProperty(this, "files", { value: [file], configurable: true });
    this.onchange?.(new Event("change") as never);
  };
}

describe("Color settings panel: states", () => {
  test("a new document: no working space, relative colorimetric with BPC, no proofing", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    expect(setting<HTMLSelectElement>(h, "cmyk-profile").value).toBe("");
    expect(setting<HTMLSelectElement>(h, "intent").value).toBe(
      "RelativeColorimetric",
    );
    expect(setting<HTMLInputElement>(h, "bpc").checked).toBe(true);
    expect(setting<HTMLInputElement>(h, "proof-on").checked).toBe(false);
    expect(setting<HTMLInputElement>(h, "paper-white").checked).toBe(false);
    expect(h.sent("requestDocumentMeta").length).toBeGreaterThan(0);
  });
});

describe("Color settings panel: controls", () => {
  test("Intent writes the whole colour-settings triple with the new intent", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    const from = h.mark();
    await h.choose(setting(h, "intent"), "Perceptual");
    expect(h.mutations(from)).toEqual([
      {
        op: "setColorSettings",
        args: {
          cmykProfileName: null,
          rgbPolicy: null,
          intent: "Perceptual",
          bpc: true,
        },
      },
    ] as never);
    expect((await h.client.documentMeta()).renderingIntent).toBe("Perceptual");
    expect(setting<HTMLSelectElement>(h, "intent").value).toBe("Perceptual");
  });

  test("Black-point compensation off writes bpc false", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    const from = h.mark();
    await h.click(setting(h, "bpc"));
    expect(h.mutations(from)).toEqual([
      {
        op: "setColorSettings",
        args: {
          cmykProfileName: null,
          rgbPolicy: null,
          intent: "RelativeColorimetric",
          bpc: false,
        },
      },
    ] as never);
    expect((await h.client.documentMeta()).blackPointCompensation).toBe(false);
  });

  test("Simulate paper white, with a proof device, writes the proof setup", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    pickOnClick(new File([new Uint8Array(132)], "Proof.icc"));
    await h.click(h.root.querySelector('[data-action="add-profile"]')!);
    await h.choose(setting(h, "proof-profile"), "Proof");
    const from = h.mark();
    await h.click(setting(h, "paper-white"));
    expect(h.mutations(from)).toEqual([
      {
        op: "setProofSetup",
        args: { profileName: "Proof", simulatePaperWhite: true, intent: null },
      },
    ] as never);
    expect((await h.client.documentMeta()).proofSimulatePaperWhite).toBe(true);
    expect(setting<HTMLInputElement>(h, "paper-white").checked).toBe(true);
  });

  test("Add profile registers the picked file under its name; it becomes a working space and a proof device", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    pickOnClick(new File([new Uint8Array(132)], "Coated Test.icc"));
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="add-profile"]')!);
    expect(
      h
        .sent("registerColorProfile", from)
        .map((m) => (m.payload as { name: string }).name),
    ).toEqual(["Coated Test"]);
    const options = (name: string) =>
      [...setting<HTMLSelectElement>(h, name).options].map((o) => o.value);
    expect(options("cmyk-profile")).toContain("Coated Test");
    expect(options("proof-profile")).toContain("Coated Test");
  });

  test("choosing the registered profile as the CMYK working space writes it", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    pickOnClick(new File([new Uint8Array(132)], "Coated Test.icc"));
    await h.click(h.root.querySelector('[data-action="add-profile"]')!);
    const from = h.mark();
    await h.choose(setting(h, "cmyk-profile"), "Coated Test");
    expect(h.mutations(from)).toEqual([
      {
        op: "setColorSettings",
        args: {
          cmykProfileName: "Coated Test",
          rgbPolicy: null,
          intent: "RelativeColorimetric",
          bpc: true,
        },
      },
    ] as never);
    expect((await h.client.documentMeta()).cmykProfileName).toBe("Coated Test");
  });

  test("choosing a proof device turns proofing on with it", async () => {
    covers("panel:paged.color-settings");
    const h = await mount();
    pickOnClick(new File([new Uint8Array(132)], "Proof.icc"));
    await h.click(h.root.querySelector('[data-action="add-profile"]')!);
    const from = h.mark();
    await h.choose(setting(h, "proof-profile"), "Proof");
    expect(h.mutations(from)).toEqual([
      {
        op: "setProofSetup",
        args: { profileName: "Proof", simulatePaperWhite: false, intent: null },
      },
    ] as never);
    expect((await h.client.documentMeta()).proofProfileName).toBe("Proof");
    expect(setting<HTMLInputElement>(h, "proof-on").checked).toBe(true);
  });
});

describe("Color settings panel: findings", () => {
  // With no proof device the engine stores no proof setup, so a click on
  // "Simulate output condition" or "Simulate paper white" is undone by
  // the next read: the box unticks itself and nothing says why.
  test.failing(
    "PN-163: the proof options are unavailable until a proof device is chosen",
    async () => {
      covers("panel:paged.color-settings");
      const h = await mount();
      expect(setting<HTMLInputElement>(h, "proof-on").disabled).toBe(true);
      expect(setting<HTMLInputElement>(h, "paper-white").disabled).toBe(true);
    },
  );

  // The list of profiles is built from the registration messages the
  // panel saw while mounted: a profile registered before it opened (or
  // while its tab was closed) is not offered.
  test.failing(
    "PN-158: a profile registered before the panel opened is offered",
    async () => {
      covers("panel:paged.color-settings");
      const h = await mountPanel(ColorSettingsPanel, {
        id: "paged.color-settings",
        scene: async ({ client }) => {
          await client.registerColorProfile("Earlier", new Uint8Array(132));
        },
      });
      expect(
        [...setting<HTMLSelectElement>(h, "proof-profile").options].map(
          (o) => o.value,
        ),
      ).toContain("Earlier");
    },
  );

  // Any bytes are accepted as an ICC profile and made the working space;
  // a file that is not a profile should be refused with a message.
  test.failing(
    "PN-159: a picked file that is not an ICC profile is refused",
    async () => {
      covers("panel:paged.color-settings");
      const h = await mount();
      pickOnClick(new File([new Uint8Array([1, 2, 3, 4])], "notes.icc"));
      await h.click(h.root.querySelector('[data-action="add-profile"]')!);
      expect(
        [...setting<HTMLSelectElement>(h, "cmyk-profile").options].map(
          (o) => o.value,
        ),
      ).not.toContain("notes");
    },
  );
});
