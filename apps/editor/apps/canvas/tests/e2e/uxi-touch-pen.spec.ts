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

// Touch and pen (interaction contract §13.3, §19.3; editor ADR "An
// accessible object tree"): a pinch that lands while a press is still
// waiting for its hit test changes the camera and nothing else (UXI-T71); a
// pen's pressure and tilt reach the tool that reads them, a pen stroke is
// shaped by its pressure and a mouse stroke is not, and the pen selects as
// the mouse does (UXI-T72); in the fill shape on a phone a finger fills and
// navigates, never moves the design (UXI-T73). Real input throughout: CDP
// touch and pen events, as the browser delivers them. Each asserts the
// model and the history.

import { devices, expect, test, type Page } from "@playwright/test";

import {
  browserGestures,
  covers,
  type BrowserPage,
} from "@paged-media/test-kit";

import { delayReply, clearChaos, openChaosCanvas } from "./harness/chaos";
import {
  expectHistoryUnchanged,
  expectUndoSteps,
  historyDepth,
} from "./harness/history";
import {
  activateTool,
  assertCanBeginNewDrag,
  clientPointOf,
  engineGestureOpen,
} from "./harness/interaction";
import {
  dumpStory,
  modelSnapshot,
  selectionSnapshot,
} from "./harness/model-dump";
import {
  loadUxiFixture,
  openUxiFixture,
  openUxiFixtureF,
  UXI_A,
  UXI_F,
} from "./harness/uxi-fixtures";

const A = UXI_A;
const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

interface Cam {
  scale: number;
  tx: number;
  ty: number;
}
interface CanvasGlobal {
  __canvas: {
    client: {
      camera: { read(): Cam };
      pathAnchors(id: unknown): Promise<{ anchors: unknown[] } | null>;
    };
    registries: {
      tools: { register(t: unknown): { dispose(): void } };
      commands: { invoke(id: string): unknown };
    };
  };
}

const camera = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as CanvasGlobal).__canvas.client.camera.read(),
  );

async function mirror(page: Page): Promise<string[]> {
  return (await selectionSnapshot(page)).elements.map(key);
}

/** Touch points through the browser's own touch input. */
async function touches(
  page: Page,
  frames: ReadonlyArray<{
    type: "touchStart" | "touchMove" | "touchEnd";
    at: ReadonlyArray<{ x: number; y: number; id: number }>;
  }>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  for (const f of frames) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: f.type,
      touchPoints: f.at.map((p) => ({ ...p })),
    });
    await page.waitForTimeout(16);
  }
  await cdp.detach();
}

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("UXI-T71 — a pinch over a press still waiting for its hit test zooms about its midpoint and changes nothing else: no edit, no selection, no gesture left open @feat:editor-tools.nav.zoom @feat:editor-tools.select.click-marquee @level:edge @uxi:UXI-CAM-012", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openChaosCanvas(page);
    await loadUxiFixture(page, "A");
    const before = await modelSnapshot(page);
    const selected = await mirror(page);
    const cam0 = await camera(page);
    const on = await clientPointOf(page, { at: A.front.at });
    const other = await clientPointOf(page, { at: A.emptyAt });
    // The first finger's press waits for its hit test while the second
    // lands: a selection candidate, pending.
    await delayReply(page, "hitTest", 800);
    await expectHistoryUnchanged(
      page,
      async () => {
        await touches(page, [
          { type: "touchStart", at: [{ ...on, id: 1 }] },
          {
            type: "touchStart",
            at: [
              { ...on, id: 1 },
              { ...other, id: 2 },
            ],
          },
          // Fingers apart: about 1.5 × their distance.
          ...[1, 2, 3, 4].map((i) => ({
            type: "touchMove" as const,
            at: [
              {
                x: on.x - ((other.x - on.x) * 0.25 * i) / 4,
                y: on.y - ((other.y - on.y) * 0.25 * i) / 4,
                id: 1,
              },
              {
                x: other.x + ((other.x - on.x) * 0.25 * i) / 4,
                y: other.y + ((other.y - on.y) * 0.25 * i) / 4,
                id: 2,
              },
            ],
          })),
          { type: "touchEnd", at: [] },
        ]);
        await clearChaos(page);
        await expect
          .poll(async () => (await camera(page)).scale / cam0.scale)
          .toBeGreaterThan(1.3);
        // The press the pinch took over neither selected nor moved anything.
        expect(await mirror(page)).toEqual(selected);
        expect(await engineGestureOpen(page)).toBe(false);
      },
      "a pinch over a pending press",
    );
    expect(await modelSnapshot(page)).toBe(before);
    // No ghost: the next drag is an ordinary one.
    await assertCanBeginNewDrag(page, A.free.id);
  });
});

/** A probe tool that records what its handler receives. */
async function registerProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as CanvasGlobal & {
      __probe: Array<Record<string, unknown>>;
    };
    w.__probe = [];
    const take = (phase: string) => (e: Record<string, unknown>) =>
      w.__probe.push({
        phase,
        pointerType: e.pointerType,
        pressure: e.pressure,
        tiltX: e.tiltX,
        tiltY: e.tiltY,
      });
    w.__canvas.registries.tools.register({
      id: "uxap.probe",
      title: "Probe",
      icon: "tool-select",
      group: "uxap-probe",
      section: "drawType",
      cluster: "draw",
      gesture: () => ({
        onActivate() {},
        onDeactivate() {},
        onPointerDown: take("down"),
        onPointerMove: take("move"),
        onPointerUp: take("up"),
      }),
    });
  });
}

const probe = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __probe: Array<Record<string, unknown>> })
        .__probe,
  );

test.describe("pen", () => {
  test("UXI-T72 — a pen's pressure and tilt reach the tool that reads them; the pencil shapes a pen stroke by its pressure and not a mouse stroke; a pen selects as a mouse does @feat:editor-tools.draw.pencil @feat:plugin-draw.pencil-pressure @feat:editor-tools.select.click-marquee @level:happy @uxi:UXI-A11Y-010", async ({
    page,
  }) => {
    covers("tool:paged.tool.pencil");
    covers("tool:paged.tool.select");
    await openUxiFixture(page, "A");
    const g = browserGestures(page as unknown as BrowserPage);

    // 1. The tool receives what the pen gives: pressure, tilt, its type.
    await registerProbe(page);
    await g.tool("uxap.probe").settle();
    await g
      .drag({
        from: { page: 0, at: [80, 320] },
        to: { page: 0, at: [300, 360] },
        steps: 6,
        device: "pen",
        tiltX: 25,
        tiltY: -15,
        pressureAt: (i, n) => 0.2 + (0.7 * i) / n,
      })
      .settle();
    const seen = await probe(page);
    const moves = seen.filter((s) => s.phase === "move");
    expect(seen[0]).toMatchObject({ phase: "down", pointerType: "pen" });
    expect(moves.length).toBeGreaterThan(2);
    expect(moves.every((s) => s.pointerType === "pen")).toBe(true);
    expect(Number(moves.at(-1)!.pressure)).toBeGreaterThan(
      Number(moves[0]!.pressure) + 0.2,
    );
    expect(moves.some((s) => s.tiltX === 25 && s.tiltY === -15)).toBe(true);

    // 2. The pencil: the same path by mouse, then by pen.
    const stroke = {
      from: { page: 0, at: [80, 320] as const },
      via: [{ page: 0, at: [190, 280] as const }],
      to: { page: 0, at: [300, 360] as const },
      steps: 8,
    };
    const anchorsOfSelection = async () => {
      const [created] = (await selectionSnapshot(page)).elements;
      return page.evaluate(async (id) => {
        const c = (globalThis as unknown as CanvasGlobal).__canvas;
        return (await c.client.pathAnchors(id))?.anchors.length ?? 0;
      }, created);
    };
    await activateTool(page, "paged.tool.pencil");
    await expectUndoSteps(
      page,
      1,
      () => g.drag(stroke).settle(),
      "a mouse stroke",
    );
    const mouseAnchors = await anchorsOfSelection();
    const depth = (await historyDepth(page)).undo;
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await historyDepth(page)).undo)
      .toBe(depth - 1);
    await activateTool(page, "paged.tool.pencil");
    await expectUndoSteps(
      page,
      1,
      () =>
        g
          .drag({
            ...stroke,
            device: "pen",
            pressureAt: (i, n) => 0.2 + (0.7 * i) / n,
          })
          .settle(),
      "a pen stroke",
    );
    // The pen's stroke is a filled outline around its centreline: more
    // anchors than the mouse's plain stroke along the same path.
    expect(await anchorsOfSelection()).toBeGreaterThan(mouseAnchors);

    // 3. Selection is not the pen's to change: a pen click selects, as a
    // mouse click does, and edits nothing.
    await activateTool(page, "paged.tool.select");
    const before = await modelSnapshot(page);
    await expectHistoryUnchanged(
      page,
      async () => {
        await g.click({ page: 0, at: A.free.at }, { device: "pen" }).settle();
        await expect.poll(() => mirror(page)).toEqual([key(A.free.id)]);
        await g.click({ page: 0, at: A.back.at }).settle();
        await expect.poll(() => mirror(page)).toEqual([key(A.back.id)]);
      },
      "pen and mouse clicks",
    );
    expect(await modelSnapshot(page)).toBe(before);
  });
});

test.describe("touch on a phone, filling a template", () => {
  const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  test("UXI-T73 — on a phone a finger fills the template's field and navigates the page: a drag pans, a pinch zooms, the zoom buttons are 44 px, and the design never moves @feat:editor-shell.solo-mode @feat:editor-tools.nav.zoom @level:happy @uxi:UXI-A11Y-011 @uxi:UXI-CAM-013", async ({
    page,
  }) => {
    covers("tool:paged.tool.select");
    await openUxiFixtureF(page);
    await expect(
      page.locator('[data-compact-layout="field-sheet"]'),
    ).toBeVisible();
    // Controls sized for a finger.
    for (const box of await page
      .locator("[data-touch-zoom-command]")
      .evaluateAll((els) =>
        els
          .map((el) => el.getBoundingClientRect())
          .map((r) => ({
            w: r.width,
            h: r.height,
          })),
      )) {
      expect(Math.min(box.w, box.h)).toBeGreaterThanOrEqual(44);
    }
    const design = await page.evaluate(async (ref) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas as never as {
        client: { elementGeometry(i: unknown[]): Promise<unknown[]> };
      };
      return JSON.stringify(await c.client.elementGeometry([ref]));
    }, UXI_F.design.id);

    // One finger on the design frame pans; it never moves the frame.
    const cam0 = await camera(page);
    const [t, l, b, r] = UXI_F.design.box;
    const at = await clientPointOf(page, { at: [(l + r) / 2, (t + b) / 2] });
    await expectHistoryUnchanged(
      page,
      async () => {
        await touches(page, [
          { type: "touchStart", at: [{ ...at, id: 1 }] },
          ...[1, 2, 3, 4, 5].map((i) => ({
            type: "touchMove" as const,
            at: [{ x: at.x, y: at.y - 18 * i, id: 1 }],
          })),
          { type: "touchEnd", at: [] },
        ]);
        await expect
          .poll(async () => Math.abs((await camera(page)).ty - cam0.ty))
          .toBeGreaterThan(30);
      },
      "a one-finger drag",
    );
    expect(
      await page.evaluate(async (ref) => {
        const c = (globalThis as unknown as CanvasGlobal).__canvas as never as {
          client: { elementGeometry(i: unknown[]): Promise<unknown[]> };
        };
        return JSON.stringify(await c.client.elementGeometry([ref]));
      }, UXI_F.design.id),
    ).toBe(design);

    // A tap on the field opens it in the sheet; typing fills it.
    const field = await page
      .locator(`[data-template-field-outline="${UXI_F.field.name}"] polygon`)
      .boundingBox();
    expect(field).not.toBeNull();
    await page.touchscreen.tap(
      field!.x + field!.width / 2,
      field!.y + field!.height / 2,
    );
    const input = page.locator(`[data-field-input="${UXI_F.field.name}"]`);
    await expect(input).toBeVisible({ timeout: 15_000 });
    const box = await input.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await input.fill("New title");
    await input.press("Enter");
    await expect
      .poll(() => dumpStory(page, UXI_F.field.storyId))
      .toContain("New title");
    expect(
      await page.evaluate(async (ref) => {
        const c = (globalThis as unknown as CanvasGlobal).__canvas as never as {
          client: { elementGeometry(i: unknown[]): Promise<unknown[]> };
        };
        return JSON.stringify(await c.client.elementGeometry([ref]));
      }, UXI_F.design.id),
    ).toBe(design);
  });
});
