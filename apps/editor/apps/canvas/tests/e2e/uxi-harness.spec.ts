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

// The interaction contract's harness, proved (docs/reference/testing.md,
// "Interaction contract harness"): every fixture A–H loads with the ids
// FIXTURES.md names, the slow worker really holds a reply, and the
// history / model / preview probes read what they claim. These are not
// UXI-Txx scenarios; the scenarios are uxi-baseline.spec.ts.

import { expect, test } from "@playwright/test";

import {
  chaosIdle,
  clearChaos,
  delayReply,
  heldReplies,
  openChaosCanvas,
} from "./harness/chaos";
import { idsOfKind } from "./harness/gesture-kit";
import { expectHistoryUnchanged, historyDepth } from "./harness/history";
import {
  clickOn,
  dragStartOnObject,
  engineGestureOpen,
  expectNoGesturePreview,
  movePointerBy,
  releasePointer,
} from "./harness/interaction";
import { modelSnapshot, selectionSnapshot } from "./harness/model-dump";
import {
  focusEditor,
  focusedSide,
  openTwoEditors,
} from "./harness/two-instances";
import {
  loadUxiFixture,
  openUxiFixture,
  openUxiFixtureF,
  UXI_A,
  UXI_B,
  UXI_C,
  UXI_D,
  UXI_E,
  UXI_F,
} from "./harness/uxi-fixtures";

/** Every element id of the open document, by kind. */
async function sceneIds(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: { send(m: unknown): Promise<{ payload: unknown }> };
        };
      }
    ).__canvas;
    const r = (await c.client.send({ kind: "requestSceneTree" })) as {
      payload: {
        roots: Array<{
          id?: { kind: string; id: string } | null;
          children?: unknown[];
        }>;
      };
    };
    const out: string[] = [];
    const walk = (n: {
      id?: { kind: string; id: string } | null;
      children?: unknown[];
    }) => {
      if (n.id) out.push(`${n.id.kind}:${n.id.id}`);
      for (const ch of (n.children ?? []) as typeof r.payload.roots) walk(ch);
    };
    r.payload.roots.forEach(walk);
    return out;
  });
}

test.describe("interaction contract harness", () => {
  test("AC-UXI-HARNESS-1 — fixtures A–E load with the ids FIXTURES.md names @feat:editor-tools.gesture-lifecycle @level:happy", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    let ids = await sceneIds(page);
    for (const ref of [
      UXI_A.back.id,
      UXI_A.front.id,
      UXI_A.locked.id,
      UXI_A.free.id,
      UXI_A.note.id,
    ]) {
      expect(ids, "fixture A").toContain(`${ref.kind}:${ref.id}`);
    }

    await loadUxiFixture(page, "B");
    ids = await sceneIds(page);
    for (const ref of [UXI_B.group, UXI_B.path.id, UXI_B.text.id]) {
      expect(ids, "fixture B").toContain(`${ref.kind}:${ref.id}`);
    }

    await loadUxiFixture(page, "C");
    ids = await sceneIds(page);
    for (const ref of [UXI_C.first.id, UXI_C.second.id]) {
      expect(ids, "fixture C").toContain(`${ref.kind}:${ref.id}`);
    }
    // One story through both frames.
    const chain = await page.evaluate(async (storyId) => {
      const c = (
        globalThis as unknown as {
          __canvas: { client: { frameChain(s: string): Promise<unknown[]> } };
        }
      ).__canvas;
      return (await c.client.frameChain(storyId)).length;
    }, UXI_C.storyId);
    expect(chain, "fixture C threads two frames").toBe(2);

    await loadUxiFixture(page, "D");
    const pages = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __canvas: { handle?: { pageIds?: string[] } };
          }
        ).__canvas.handle?.pageIds?.length ?? 0,
    );
    expect(pages, "fixture D has twenty pages").toBe(UXI_D.pageCount);
    ids = await sceneIds(page);
    expect(ids).toContain(`rectangle:${UXI_D.rotated(7).id}`);
    expect(ids).toContain(`rectangle:${UXI_D.image(11)!.id}`);
    const guides = await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              collection(n: string): Promise<Array<{ guides?: unknown[] }>>;
            };
          };
        }
      ).__canvas;
      const spreads = await c.client.collection("spreads");
      return spreads.reduce((n, s) => n + (s.guides?.length ?? 0), 0);
    });
    expect(guides, "fixture D: two ruler guides a page").toBe(
      2 * UXI_D.pageCount,
    );

    await loadUxiFixture(page, "E");
    ids = await sceneIds(page);
    expect(ids).toContain(`rectangle:${UXI_E.image.id.id}`);
    expect(ids).toContain(`polygon:${UXI_E.vector.id.id}`);
  });

  test("AC-UXI-HARNESS-2 — fixture F is a template a filler cannot move @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    await openUxiFixtureF(page);
    const fields = await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              templateFields(): Promise<{ field: { name: string } }[]>;
            };
          };
        }
      ).__canvas;
      return (await c.client.templateFields()).map((f) => f.field.name);
    });
    expect(fields).toEqual([UXI_F.field.name]);
    const model = await modelSnapshot(page);
    // The engine refuses a filler's move of the design frame.
    const refused = await page.evaluate(async (id) => {
      const c = (
        globalThis as unknown as {
          __canvas: { client: { send(m: unknown): Promise<{ kind: string }> } };
        }
      ).__canvas;
      const r = await c.client.send({
        kind: "beginGesture",
        payload: { nodes: [id], gesture: { kind: "translate" }, anchor: null },
      });
      return r.kind;
    }, UXI_F.design.id);
    expect(refused).toBe("gestureFailed");
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("AC-UXI-HARNESS-3 — fixture G mounts two editors, each with its own focus @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    const two = await openTwoEditors(page);
    await focusEditor(two, "left");
    expect(await focusedSide(two)).toBe("left");
    await focusEditor(two, "right");
    expect(await focusedSide(two)).toBe("right");
  });

  test("AC-UXI-HARNESS-4 — fixture H holds a hit-test reply until its delay runs out @feat:editor-tools.select.click-marquee @level:edge", async ({
    page,
  }) => {
    await openChaosCanvas(page);
    await loadUxiFixture(page, "A");
    await delayReply(page, "hitTest", 1500);
    await clickOn(page, UXI_A.free.id);
    // The click's hit tests are held: nothing is selected yet.
    await expect.poll(() => heldReplies(page)).toBeGreaterThan(0);
    expect((await selectionSnapshot(page)).elements).toEqual([]);
    await chaosIdle(page);
    await expect
      .poll(async () => (await selectionSnapshot(page)).elements)
      .toEqual([UXI_A.free.id]);
    await clearChaos(page);
  });

  test("AC-UXI-HARNESS-5 — the probes: an open drag shows in the engine, a released one leaves no preview; history reads the undo log @feat:editor-tools.gesture-lifecycle @level:gesture", async ({
    page,
  }) => {
    await openUxiFixture(page, "A");
    expect(await idsOfKind(page, "rectangle")).toContain(UXI_A.free.id.id);
    const depth = await historyDepth(page);
    // A marquee from empty page space draws its preview while held.
    await dragStartOnObject(page, { at: UXI_A.emptyAt });
    await movePointerBy(page, 60, 40);
    await expect(page.locator('[data-gesture-preview="marquee"]')).toHaveCount(
      1,
    );
    await expectHistoryUnchanged(page, () => releasePointer(page));
    await expectNoGesturePreview(page);
    // A move drag holds a gesture open in the engine until released.
    await dragStartOnObject(page, UXI_A.free.id);
    await movePointerBy(page, 30, 20);
    await expect.poll(() => engineGestureOpen(page)).toBe(true);
    await releasePointer(page);
    await expect.poll(() => engineGestureOpen(page)).toBe(false);
    await expect
      .poll(async () => (await historyDepth(page)).undo)
      .toBe(depth.undo + 1);
  });
});
