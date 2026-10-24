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

// The fill shapes on phones and tablets (editor ADR 293): below the
// compact breakpoint `form-first` puts the form first with the preview
// folded away, and `field-sheet` shows the canvas with the tapped field in
// a sheet under it; their controls are touch targets of at least 44 px. A
// desktop editor keeps its layout and sizes at every width.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import {
  COMPACT_MAX_WIDTH_PX,
  CockpitLayout,
  REGION_IDS,
  TOUCH_TARGET_PX,
  chromeRegionsOf,
  isCompactWidth,
  type CompactLayout,
  type PanelContribution,
  type RegionId,
  type ResolvedRegion,
  type ShellRegistries,
} from "@paged-media/shell";

import { TemplateFormPanel } from "../../src/panels/template/form-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

const FORM: ResolvedRegion = { kind: "list", items: ["paged.template.form"] };
const ALL: ResolvedRegion = { kind: "all", exclude: [], append: [] };

function chromeFor(compact: CompactLayout | null) {
  if (!compact) return chromeRegionsOf(undefined, undefined);
  const regions = {} as Record<RegionId, ResolvedRegion | null>;
  for (const id of REGION_IDS) regions[id] = ALL;
  regions.form = FORM;
  regions["actions-bar"] = null;
  return chromeRegionsOf(
    regions,
    { rulers: false, titleBar: false, thumbnails: false },
    compact,
  );
}

const realWidth = window.innerWidth;
function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: px,
  });
}
beforeEach(() => setWidth(390));
afterEach(() => {
  unmountAll();
  setWidth(realWidth);
});

/** The smallest side a control declares inline. */
function side(el: Element): number {
  const style = (el as HTMLElement).style;
  return Math.min(
    parseFloat(style.minHeight || style.height || "0"),
    parseFloat(style.minWidth || style.width || "0") ||
      parseFloat(style.minHeight || style.height || "0"),
  );
}

async function field(
  h: PanelHarness<unknown>,
  name: string,
  kind: "text" | "image",
): Promise<unknown> {
  await h.client.setSessionPolicy({ role: "author", overrides: [] });
  const op = kind === "text" ? "insertTextFrame" : "insertFrame";
  const reply = await h.mutate({
    op,
    args: { pageId: h.handle!.pageIds[0], bounds: [100, 40, 160, 300] },
  } as never);
  const id = (reply as { payload: { createdId: unknown } }).payload.createdId;
  await h.mutate({
    op: "setPluginMetadata",
    args: {
      elementId: id,
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: { field: { name, kind, label: name.toUpperCase() } },
      }),
    },
  } as never);
  await h.client.setSessionPolicy({ role: "filler", overrides: [] });
  await h.settle();
  return id;
}

function Canvas() {
  return <div data-test-canvas />;
}

const ZOOM_COMMANDS = [
  "paged.view.zoomOut",
  "paged.view.fitPage",
  "paged.view.zoomIn",
];

/** The cockpit's work area of a fill shape, with the form registered. */
function layout(compact: CompactLayout | null) {
  const contribution: PanelContribution = {
    id: "test.cockpit",
    title: "Cockpit",
    component: () => <CockpitLayout canvasComponent={Canvas} />,
  } as PanelContribution;
  return mountPanel(contribution, {
    chrome: chromeFor(compact),
    role: "filler",
    registries: (r: ShellRegistries) => {
      r.panels.register({
        id: "paged.template.form",
        title: "Form",
        component: TemplateFormPanel,
      } as PanelContribution);
      for (const id of ZOOM_COMMANDS)
        r.commands.register({ id, title: id, handler: () => {} });
    },
  });
}

describe("the compact breakpoint", () => {
  test("is 720 px wide: a phone is compact, a tablet is not", () => {
    expect(COMPACT_MAX_WIDTH_PX).toBe(720);
    expect(isCompactWidth(390)).toBe(true);
    expect(isCompactWidth(719)).toBe(true);
    expect(isCompactWidth(720)).toBe(false);
    expect(isCompactWidth(768)).toBe(false);
    expect(TOUCH_TARGET_PX).toBe(44);
  });
});

describe("form-first below the breakpoint", () => {
  test("the form comes first and the preview folds away behind a 44 px toggle", async () => {
    covers("panel:paged.template.form");
    const h = await layout("form-first");
    const root = h.root;
    const shape = root.querySelector("[data-cockpit-layout]")!;
    expect(shape.getAttribute("data-compact-layout")).toBe("form-first");
    const toggle = root.querySelector<HTMLButtonElement>(
      "[data-preview-toggle]",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Show preview");
    expect(parseFloat(toggle.style.minHeight)).toBeGreaterThanOrEqual(44);
    // The form column follows the toggle; the preview is hidden.
    expect(root.querySelector("[data-form-column]")).not.toBeNull();
    const pane = root.querySelector<HTMLElement>("[data-preview-pane]")!;
    expect(pane.style.display).toBe("none");
    await h.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("Hide preview");
    expect(pane.style.display).not.toBe("none");
  });

  test("at 720 px and wider the form is a column beside the preview", async () => {
    covers("panel:paged.template.form");
    setWidth(1024);
    const h = await layout("form-first");
    expect(h.root.querySelector("[data-preview-toggle]")).toBeNull();
    expect(h.root.querySelector("[data-form-column]")).not.toBeNull();
    expect(h.root.querySelector("[data-cockpit-main]")).not.toBeNull();
  });
});

describe("field-sheet below the breakpoint", () => {
  test("the canvas carries 44 px zoom buttons and the form is a sheet", async () => {
    covers("panel:paged.template.form");
    const h = await layout("field-sheet");
    const root = h.root;
    expect(
      root
        .querySelector("[data-cockpit-layout]")!
        .getAttribute("data-compact-layout"),
    ).toBe("field-sheet");
    expect(root.querySelector("[data-field-sheet]")).not.toBeNull();
    expect(root.querySelector("[data-form-column]")).toBeNull();
    const zoom = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-touch-zoom-command]"),
    ];
    expect(zoom.map((b) => b.dataset.touchZoomCommand)).toEqual(ZOOM_COMMANDS);
    for (const b of zoom) expect(side(b)).toBeGreaterThanOrEqual(44);
  });

  test("a desktop editor at phone width keeps its layout and has no zoom buttons", async () => {
    const h = await layout(null);
    expect(
      h.root
        .querySelector("[data-cockpit-layout]")!
        .hasAttribute("data-compact-layout"),
    ).toBe(false);
    expect(h.root.querySelector("[data-touch-zoom]")).toBeNull();
    expect(h.root.querySelector("[data-field-sheet]")).toBeNull();
  });
});

describe("the form as a field sheet", () => {
  const mount = () =>
    mountPanel(TemplateFormPanel, {
      id: "paged.template.form",
      chrome: chromeFor("field-sheet"),
      role: "filler",
    });

  test("asks for a tap until a field is selected, then shows that field at 44 px", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    const id = await field(h, "headline", "text");
    await field(h, "subline", "text");
    const sheet = h.root.querySelector("[data-template-form-sheet]")!;
    expect(sheet.textContent).toContain("Tap a field on the page");
    expect(h.root.querySelector('[data-field-input="headline"]')).toBeNull();
    const all = h.root.querySelector<HTMLButtonElement>("[data-sheet-all]")!;
    expect(side(all)).toBeGreaterThanOrEqual(44);

    await h.select([id as never]);
    const input = h.root.querySelector<HTMLInputElement>(
      '[data-field-input="headline"]',
    )!;
    expect(input).not.toBeNull();
    expect(h.root.querySelector('[data-field-input="subline"]')).toBeNull();
    expect(parseFloat(input.style.minHeight)).toBeGreaterThanOrEqual(44);
    // 16 px: a phone does not zoom the page into the field.
    expect(input.style.fontSize).toBe("16px");
    await h.act(async () => {
      input.focus();
      await h.user.type(input, "Ada{Enter}");
    });
    const rows = await h.client.templateFields();
    expect(rows.find((r) => r.field.name === "headline")!.value).toEqual({
      kind: "text",
      text: "Ada",
    });

    const done = h.root.querySelector<HTMLButtonElement>("[data-sheet-done]")!;
    expect(side(done)).toBeGreaterThanOrEqual(44);
    await h.click(done);
    expect(h.root.querySelector('[data-field-input="headline"]')).toBeNull();

    await h.click(all);
    expect(
      h.root.querySelector('[data-field-input="headline"]'),
    ).not.toBeNull();
    expect(h.root.querySelector('[data-field-input="subline"]')).not.toBeNull();
  });

  test("a picture field offers the camera and the library as 44 px inputs", async () => {
    covers("panel:paged.template.form");
    const h = await mount();
    const id = await field(h, "photo", "image");
    await h.select([id as never]);
    const camera = h.root.querySelector<HTMLLabelElement>(
      '[data-field-picture-input="camera"]',
    )!;
    const library = h.root.querySelector<HTMLLabelElement>(
      '[data-field-picture-input="library"]',
    )!;
    expect(camera.textContent).toContain("Take photo");
    expect(library.textContent).toContain("Choose picture");
    for (const label of [camera, library])
      expect(side(label)).toBeGreaterThanOrEqual(44);
    const cameraInput = camera.querySelector("input")!;
    expect(cameraInput.accept).toBe("image/*");
    expect(cameraInput.getAttribute("capture")).toBe("environment");
    expect(library.querySelector("input")!.hasAttribute("capture")).toBe(false);
    expect(h.root.querySelector('[data-field-replace="photo"]')).toBeNull();
  });

  test("a wide fill shape keeps the desktop form and its Replace button", async () => {
    covers("panel:paged.template.form");
    setWidth(1280);
    const h = await mount();
    const id = await field(h, "photo", "image");
    expect(h.root.querySelector("[data-template-form-sheet]")).toBeNull();
    await h.select([id as never]);
    expect(h.root.querySelector('[data-field-replace="photo"]')).not.toBeNull();
    expect(h.root.querySelector("[data-field-picture-input]")).toBeNull();
  });
});
