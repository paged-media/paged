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

// The panels' browser-only behaviour, one flow each: what the component
// lane (test/panels, happy-dom) cannot see because it has no layout, no
// pointer capture and no canvas. Documents are built in code (the test
// kit's gesture fixture); the private corpus is never read.
//
//   · Color Wheel: a pointer drag on the wheel changes the colour, and Add
//     to Swatches lands the palette as ONE undo step.
//   · Gradients: dragging a stop on the ramp moves it (the location the
//     engine stores follows the pointer).
//   · Layers: a real HTML5 drag-and-drop reorders the layers.
//   · Properties and the canvas: a click on a frame on the canvas routes
//     Properties to it, and a stroke weight typed there lands in the model.

import { expect, test, type Page } from "@playwright/test";
import {
  browserGestures,
  covers,
  GESTURE_TARGETS,
  type BrowserPage,
} from "@paged-media/test-kit";

import { openCanvas, openPanel } from "../fidelity/canvas-driver";
import { loadGestureFixture } from "./harness/gesture-kit";
import { mutate } from "./harness/ui";

interface CanvasGlobal {
  __canvas: {
    client: {
      collection: (name: string) => Promise<Array<Record<string, unknown>>>;
      undo: () => Promise<unknown>;
      send: (
        m: unknown,
      ) => Promise<{ kind: string; payload: { value: unknown } }>;
    };
  };
}

const collection = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.collection(n),
    name,
  );

const read = (page: Page, address: string, path: string) =>
  page.evaluate(
    async ([a, p]) =>
      (
        await (globalThis as unknown as CanvasGlobal).__canvas.client.send({
          kind: "requestGet",
          payload: { address: a, path: p },
        })
      ).payload.value,
    [address, path] as const,
  );

test.beforeEach(async ({ page }) => {
  await openCanvas(page);
  await loadGestureFixture(page, "targets");
});

test("Color Wheel: dragging on the wheel changes the colour; Add to Swatches is one undo step", async ({
  page,
}) => {
  covers("panel:paged.color-wheel");
  await openPanel(page, "paged.color-wheel");
  const wheel = page.locator("[data-wheel-disc]");
  await expect(wheel).toBeVisible();
  const hex = page.locator("[data-color-wheel] input").first();
  const before = await hex.inputValue();
  const box = (await wheel.boundingBox())!;
  // From the centre (white) out towards the rim.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(hex).not.toHaveValue(before);

  const swatchesBefore = (await collection(page, "swatches")).length;
  await page.locator("[data-wheel-add-palette]").click();
  await expect
    .poll(async () => (await collection(page, "swatches")).length)
    .toBeGreaterThan(swatchesBefore);
  await page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
  );
  await expect
    .poll(async () => (await collection(page, "swatches")).length)
    .toBe(swatchesBefore);
});

test("Gradients: dragging a stop along the ramp moves it in the model", async ({
  page,
}) => {
  covers("panel:paged.gradients");
  await mutate(page, {
    op: "createGradient",
    args: {
      spec: {
        name: "Ramp",
        kind: "Linear",
        stops: [
          { stopColor: "Color/Black", locationPct: 0 },
          { stopColor: "Color/Gray", locationPct: 100 },
        ],
      },
    },
  });
  const gradient = (await collection(page, "gradients")).find(
    (g) => g.name === "Ramp",
  )!;
  await openPanel(page, "paged.gradients");
  // The only gradient is the one the editor opens on.
  const ramp = page.locator('[data-gradient-ramp="ready"]');
  await expect(ramp).toBeVisible();
  const stop = ramp.locator('[data-ramp-stop="1"]');
  const track = (await ramp.boundingBox())!;
  const knob = (await stop.boundingBox())!;
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.5, knob.y + knob.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const detail = await page.evaluate(
        (id) =>
          (
            globalThis as unknown as {
              __canvas: {
                client: {
                  gradientDetail: (id: string) => Promise<{
                    stops: Array<{ locationPct: number }>;
                  } | null>;
                };
              };
            }
          ).__canvas.client.gradientDetail(id),
        String(gradient.selfId),
      );
      return Math.round(detail?.stops[1]?.locationPct ?? 100);
    })
    .toBeLessThan(80);
});

async function twoLayers(page: Page): Promise<string[]> {
  await mutate(page, { op: "layerInsert", args: { position: 0, name: "Top" } });
  await mutate(page, {
    op: "layerInsert",
    args: { position: 1, name: "Bottom" },
  });
  await openPanel(page, "paged.layers");
  return (await collection(page, "layers")).map((l) => String(l.selfId));
}

const layerRow = (page: Page, id: string) =>
  page.locator(`[data-panel-host="paged.layers"] [data-list-row="${id}"]`);

test("Layers: dragging a layer row onto another reorders the layers", async ({
  page,
}) => {
  covers("panel:paged.layers", "command:paged.layers.reorder");
  const before = await twoLayers(page);
  expect(before).toHaveLength(2);
  await layerRow(page, before[0]).dragTo(layerRow(page, before[1]));
  await expect
    .poll(async () =>
      (await collection(page, "layers")).map((l) => String(l.selfId)),
    )
    .toEqual([before[1], before[0]]);
});

const layerAction = (page: Page, id: string, command: string) =>
  layerRow(page, id).locator(`[data-list-action="${command}"]`);

interface LayerRow {
  selfId: string;
  name: string | null;
  visible: boolean;
  locked: boolean;
  printable: boolean;
}

const layerById = async (page: Page, id: string) =>
  ((await collection(page, "layers")) as unknown as LayerRow[]).find(
    (l) => String(l.selfId) === id,
  ) ?? null;

const undo = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.undo(),
  );

test("Layers: New layer, then each row action changes the model, and one undo takes each back", async ({
  page,
}) => {
  covers(
    "panel:paged.layers",
    "command:paged.layers.add",
    "command:paged.layers.toggleVisible",
    "command:paged.layers.toggleLocked",
    "command:paged.layers.togglePrintable",
    "command:paged.layers.rename",
    "command:paged.layers.remove",
  );
  await openPanel(page, "paged.layers");
  const before = (await collection(page, "layers")).map((l) =>
    String(l.selfId),
  );
  await page
    .locator('[data-panel-host="paged.layers"] [data-action="add-layer"]')
    .click();
  await expect
    .poll(async () => (await collection(page, "layers")).length)
    .toBe(before.length + 1);
  const id = (await collection(page, "layers"))
    .map((l) => String(l.selfId))
    .find((x) => !before.includes(x))!;
  expect((await layerById(page, id))?.name).toBe("Layer");
  await expect(layerRow(page, id)).toBeVisible();

  // The three toggles: one click flips the flag, one undo restores it.
  for (const [command, flag] of [
    ["paged.layers.toggleVisible", "visible"],
    ["paged.layers.toggleLocked", "locked"],
    ["paged.layers.togglePrintable", "printable"],
  ] as const) {
    const was = (await layerById(page, id))![flag];
    await layerAction(page, id, command).click();
    await expect
      .poll(async () => (await layerById(page, id))?.[flag])
      .toBe(!was);
    await undo(page);
    await expect
      .poll(async () => (await layerById(page, id))?.[flag])
      .toBe(was);
  }

  // Rename: double-click the name, type, Enter.
  await layerRow(page, id).locator("[data-list-row-select]").dblclick();
  const input = layerRow(page, id).locator("[data-list-rename]");
  await expect(input).toHaveValue("Layer");
  await input.fill("Renamed");
  await input.press("Enter");
  await expect
    .poll(async () => (await layerById(page, id))?.name)
    .toBe("Renamed");
  await expect(layerRow(page, id)).toContainText("Renamed");
  await undo(page);
  await expect
    .poll(async () => (await layerById(page, id))?.name)
    .toBe("Layer");

  // Delete: the layer and its row go; one undo brings both back.
  await layerAction(page, id, "paged.layers.remove").click();
  await expect.poll(() => layerById(page, id)).toBeNull();
  await expect(layerRow(page, id)).toHaveCount(0);
  await undo(page);
  await expect
    .poll(async () => (await layerById(page, id))?.name)
    .toBe("Layer");
  await expect(layerRow(page, id)).toBeVisible();
});

test("Layers: Move selection here puts the frame clicked on the canvas on the layer", async ({
  page,
}) => {
  covers("panel:paged.layers", "command:paged.layers.assignSelection");
  const [destination] = await twoLayers(page);
  const frame = `rectangle:${GESTURE_TARGETS.frame.id.id}`;
  const itemLayer = async () =>
    ((await read(page, frame, "itemLayer")) as { value?: unknown } | null)
      ?.value ?? null;
  const was = await itemLayer();
  const move = layerAction(page, destination, "paged.layers.assignSelection");
  // Nothing selected: nothing to move.
  await expect(move).toBeDisabled();
  const g = browserGestures(page as unknown as BrowserPage);
  const [x, y] = GESTURE_TARGETS.frame.at;
  await g.tool("paged.tool.select").click([x, y]);
  await expect(move).toBeEnabled();
  await move.click();
  await expect.poll(itemLayer).toBe(destination);
  await undo(page);
  await expect.poll(itemLayer).toBe(was);
});

// Finding PN-358 (fixed): at the right dock's default width (1280 × 720
// window) each layer row's four toggles are glyph buttons (named by their
// label), so the name column keeps its width.
test("PN-358: at the dock's default width every layer row shows its name", async ({
  page,
}) => {
  covers("panel:paged.layers");
  const ids = await twoLayers(page);
  for (const id of ids) {
    const name = layerRow(page, id).locator("[data-list-row-select]");
    const box = await name.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(40);
  }
});

test("Properties follows a click on the canvas, and its stroke weight writes the clicked frame", async ({
  page,
}) => {
  covers("panel:paged.properties");
  await openPanel(page, "paged.properties");
  const props = page.locator("[data-properties-panel]");
  await expect(props).toHaveAttribute("data-inspector-kind", "none");
  const g = browserGestures(page as unknown as BrowserPage);
  const [x, y] = GESTURE_TARGETS.frame.at;
  await g.tool("paged.tool.select").click([x, y]);
  await expect(props).toHaveAttribute("data-inspector-kind", "frame");
  await expect(page.locator("[data-selection-label]")).toHaveText(
    "Frame · 1 frame",
  );
  const weight = page
    .locator('[data-property-field="frameStrokeWeight"] input')
    .first();
  await weight.click();
  await weight.fill("6");
  await weight.press("Enter");
  await expect
    .poll(() =>
      read(
        page,
        `rectangle:${GESTURE_TARGETS.frame.id.id}`,
        "frameStrokeWeight",
      ),
    )
    .toEqual({ type: "length", value: 6 });
});
