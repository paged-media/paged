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

// Properties as an inspector (track FI2, editor ADR 1217): search finds a
// property by its label, a synonym or a keyword and opens the section that
// holds it (a collapsed sub-section too); sections are grouped and open
// as the user left them, per kind; a multi-selection states its scope, and
// a section that applies to part of it says "Applies to 1 of 2" and edits
// that part only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { PropertiesPanel } from "../../src/panels/properties-panel";
import { imageScene, type ImageScene } from "./support/frames";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

beforeEach(() => localStorage.clear());
afterEach(() => {
  unmountAll();
  localStorage.clear();
});

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(PropertiesPanel, { id: "paged.properties", scene: richScene });

const search = (h: PanelHarness<unknown>) =>
  h.root.querySelector<HTMLInputElement>("[data-inspector-search-input]")!;
const section = (h: PanelHarness<unknown>, id: string) =>
  h.root.querySelector<HTMLElement>(`[data-inspector-section="${id}"]`);
const visible = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-inspector-section]")]
    .filter((s) => !s.hidden)
    .map((s) => s.getAttribute("data-inspector-section"));
const isOpen = (h: PanelHarness<unknown>, id: string) =>
  section(h, id)?.getAttribute("data-section-open") === "true";

async function find(h: PanelHarness<unknown>, query: string) {
  const input = search(h);
  await h.user.clear(input);
  if (query !== "") await h.user.type(input, query);
}

describe("UXI-PNL-001 — Properties search finds a property by its words", () => {
  test("a synonym finds its section and hides the rest; clearing restores", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(visible(h)).toEqual(["object", "stroke"]);
    await find(h, "border");
    expect(visible(h)).toEqual(["stroke"]);
    expect(section(h, "stroke")!.hasAttribute("data-search-match")).toBe(true);
    await find(h, "");
    expect(visible(h)).toEqual(["object", "stroke"]);
  });

  test("a field label is found and marked, and Enter goes to its field", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    await find(h, "weight");
    expect(visible(h)).toEqual(["stroke"]);
    const hit = h.root.querySelector("[data-search-hit]");
    expect(hit?.textContent).toMatch(/weight/i);
    await h.user.type(search(h), "{Enter}");
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(document.activeElement).not.toBe(search(h));
  });

  test("a match inside a collapsed sub-section opens it while the query lasts", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    const dashes = () =>
      h.root.querySelector<HTMLElement>('[data-section="Dashes & arrows"]');
    // Collapsed by default: its fields are not rendered.
    expect(
      dashes()
        ?.querySelector("[data-section-toggle]")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    await find(h, "arrow");
    expect(dashes()!.hasAttribute("data-search-match")).toBe(true);
    expect(
      dashes()!
        .querySelector("[data-section-toggle]")!
        .getAttribute("aria-expanded"),
    ).toBe("true");
    await find(h, "");
    expect(
      dashes()!
        .querySelector("[data-section-toggle]")!
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("no match says so; Escape clears the query", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect]);
    await find(h, "zzzz");
    expect(visible(h)).toEqual([]);
    expect(
      h.root.querySelector("[data-inspector-no-match]")?.textContent,
    ).toContain("zzzz");
    await h.user.type(search(h), "{Escape}");
    expect(search(h).value).toBe("");
    expect(visible(h)).toEqual(["object", "stroke"]);
  });
});

describe("UXI-PNL-001 — progressive disclosure, remembered per kind", () => {
  test("in text the stroke is advanced and collapsed; the choice is remembered for that kind", async () => {
    covers("panel:paged.properties", "setting:paged.inspector.disclosure.v1");
    let h: H = await mount();
    await h.select([h.scene.textFrame]);
    await h.caret(h.scene.storyId, 2);
    expect(isOpen(h, "character")).toBe(true);
    expect(isOpen(h, "stroke")).toBe(false);
    await h.click(h.root.querySelector('[data-section-header="stroke"]')!);
    expect(isOpen(h, "stroke")).toBe(true);
    // A frame's stroke is common: open, whatever text's says.
    await h.click(h.root.querySelector('[data-section-header="character"]')!);
    expect(isOpen(h, "character")).toBe(false);
    unmountAll();
    h = await mount();
    await h.select([h.scene.textFrame]);
    await h.caret(h.scene.storyId, 2);
    expect(isOpen(h, "stroke")).toBe(true);
    expect(isOpen(h, "character")).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("paged.inspector.disclosure.v1")!),
    ).toEqual({ text: { stroke: true, character: false } });
  });

  test("a stored value that is not the shape reads as nothing stored", async () => {
    covers("panel:paged.properties", "setting:paged.inspector.disclosure.v1");
    localStorage.setItem("paged.inspector.disclosure.v1", '{"text":7}');
    const h = await mount();
    await h.select([h.scene.textFrame]);
    await h.caret(h.scene.storyId, 2);
    expect(isOpen(h, "stroke")).toBe(false);
    expect(isOpen(h, "character")).toBe(true);
  });

  test("sections are grouped Text and Frame when both apply", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    await h.caret(h.scene.storyId, 2);
    expect(
      [...h.root.querySelectorAll("[data-inspector-group]")].map((g) =>
        g.getAttribute("data-inspector-group"),
      ),
    ).toEqual(["text", "frame"]);
  });
});

describe("UXI-PNL-010 — a multi-selection states its scope", () => {
  test("the scope header counts the kinds and lists the objects", async () => {
    covers("panel:paged.properties");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.oval, h.scene.textFrame]);
    expect(
      h.root.querySelector("[data-inspector-scope-label]")?.textContent,
    ).toBe("3 objects · 1 rectangle, 1 ellipse, 1 text frame");
    await h.click(h.root.querySelector("[data-inspector-scope-toggle]")!);
    const rows = h.root.querySelectorAll("[data-inspector-scope-list] li");
    expect(rows).toHaveLength(3);
    await h.click(rows[1]!.querySelector("[data-select-only]")!);
    expect(h.root.querySelector("[data-inspector-scope]")).toBeNull();
  });

  test("@uxi:UXI-SEL-017 — a section for part of the selection says Applies to 1 of 2 and edits that part", async () => {
    covers("panel:paged.properties");
    const h = (await mountPanel(PropertiesPanel, {
      id: "paged.properties",
      scene: imageScene,
    })) as PanelHarness<ImageScene>;
    await h.select([h.scene.imageFrame, h.scene.oval]);
    const fitting = section(h, "fitting")!;
    expect(fitting.getAttribute("data-applies-count")).toBe("1");
    expect(fitting.querySelector("[data-applies-to]")?.textContent).toContain(
      "Applies to 1 of 2",
    );
    // The section's controls address the image frame only.
    const from = h.mark();
    const select = fitting.querySelector<HTMLSelectElement>("select");
    if (select) {
      const option = [...select.options].find(
        (o) => !o.disabled && o.value !== select.value,
      );
      if (option) {
        await h.choose(select, option.value);
        const sent = JSON.stringify(h.mutations(from));
        expect(sent).toContain(String(h.scene.imageFrame.id));
        expect(sent).not.toContain(`"${String(h.scene.oval.id)}"`);
      }
    }
    await h.click(fitting.querySelector("[data-select-compatible]")!);
    expect(section(h, "fitting")!.hasAttribute("data-applies-count")).toBe(
      false,
    );
  });
});
