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

// A trustworthy AI assistant (task PX6 of the interaction plan; editor ADR
// 1241; the strategy's Concept G; the specification's §25.1). In the
// running editor, with Claude replaced by a stub of the AI service: a
// request is sent only after the consent card's Send (Cancel sends
// nothing); Claude reads and answers a change set, which the panel previews
// — outlined on the canvas, the model and the undo log unchanged; Approve
// applies it as ONE undo step; the panel's Undo takes exactly that step
// back. Without the service, the deterministic checks propose the same way.

import { expect, test, type Page, type Route } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { aiServiceIsThere, textTurn, toolCallTurn } from "../ai-fixtures";
import { openCanvas, openPanel } from "../fidelity/canvas-driver";
import { selectElements } from "./harness/gesture-kit";
import { historyDepth, undoDepth } from "./harness/history";
import { modelSnapshot } from "./harness/model-dump";
import { loadUxiFixture, UXI_A } from "./harness/uxi-fixtures";

const A = UXI_A;
const SMALL = `storyRange:${A.note.storyId}@0..10`;

interface CanvasGlobal {
  __canvas: {
    objects: {
      get(a: string, p: string): Promise<{ kind: string; value?: unknown }>;
      set(
        a: string,
        p: string,
        v: unknown,
      ): Promise<{ applied: boolean; reason?: string }>;
    };
  };
}

async function size(page: Page, address = SMALL): Promise<unknown> {
  return page.evaluate(async (a) => {
    const v = await (
      globalThis as unknown as CanvasGlobal
    ).__canvas.objects.get(a, "characterFontSize");
    return v.kind === "value" ? v.value : v.kind;
  }, address);
}

/** Fixture A with the note's first ten characters at 6 pt (a caption too
 *  small to read), the note selected. */
async function smallNote(page: Page): Promise<void> {
  await loadUxiFixture(page, "A");
  const r = await page.evaluate(
    (a) =>
      (globalThis as unknown as CanvasGlobal).__canvas.objects.set(
        a,
        "characterFontSize",
        6,
      ),
    SMALL,
  );
  expect(r.applied).toBe(true);
  await selectElements(page, [A.note.id]);
  await openPanel(page, "paged.ai-assistant");
}

/** Stub the AI service: each POST is answered by the next turn. */
async function stubClaude(page: Page, turns: string[]): Promise<unknown[]> {
  const bodies: unknown[] = [];
  await page.route("**/api/ai/v1/messages", async (route: Route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    bodies.push(req.postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: turns.shift() ?? textTurn("Done.", "msg_end"),
    });
  });
  return bodies;
}

const card = (page: Page) => page.locator("[data-ai-assistant]");

test.describe("The assistant proposes, you approve (PX6, ADR 1241)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("Claude's change set is previewed without changing anything, and Approve applies it as ONE undo step @feat:editor-shell.ai-assistant @level:happy @uxi:UXI-MUT-001", async ({
    page,
  }) => {
    covers("panel:paged.ai-assistant");
    await aiServiceIsThere(page);
    await openCanvas(page);
    const bodies = await stubClaude(page, [
      toolCallTurn(
        "read_objects",
        { selector: `story:${A.note.storyId}`, paths: ["characterFontSize"] },
        "msg_read",
      ),
      toolCallTurn(
        "propose_changes",
        {
          summary: "Raise the caption to 8 pt.",
          changes: [
            {
              address: SMALL,
              path: "characterFontSize",
              value: 8,
              reason: "6 pt is too small to read",
            },
          ],
        },
        "msg_propose",
      ),
    ]);
    await smallNote(page);
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);

    await card(page)
      .locator("[data-ai-input]")
      .fill("find all captions smaller than 8 pt and propose corrections");
    await card(page).locator("[data-cockpit-action=ai-ask]").click();
    // Consent first: nothing has been sent.
    const consent = page.locator("[data-ai-consent=ask]");
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("Anthropic");
    await expect(consent.locator("[data-ai-consent-objects]")).toContainText(
      "1 selected object",
    );
    expect(bodies).toHaveLength(0);
    await page.locator("[data-cockpit-action=ai-consent-send]").click();

    const proposal = card(page).locator('[data-ai-proposal="proposed"]');
    await expect(proposal).toBeVisible();
    expect(bodies.length).toBe(2);
    // The mode the proxy rebuilds the request from: read-only tools.
    await expect(proposal.locator("[data-ai-proposal-summary]")).toHaveText(
      "Raise the caption to 8 pt.",
    );
    const item = proposal.locator(`[data-ai-proposal-item="${SMALL}"]`);
    await expect(item.locator("[data-ai-before]")).toHaveText("6");
    await expect(item.locator("[data-ai-after]")).toHaveText("8");
    // The canvas outlines the caption's frame.
    await expect(
      page.locator('[data-preview-targets="assistant"]'),
    ).toHaveAttribute("data-preview-count", "1");
    // Nothing changed before approval.
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
    expect(await size(page)).toBe(6);

    await card(page).locator("[data-cockpit-action=ai-proposal-apply]").click();
    await expect(card(page).locator("[data-ai-applied]")).toContainText(
      "one undo step",
    );
    expect(await size(page)).toBe(8);
    expect(await undoDepth(page)).toBe(history.undo + 1);
    await expect(page.locator("[data-preview-targets]")).toHaveCount(0);

    await card(page).locator("[data-cockpit-action=ai-proposal-undo]").click();
    await expect.poll(() => modelSnapshot(page)).toBe(model);
    expect(await undoDepth(page)).toBe(history.undo);
  });

  test("Cancel on the consent card sends nothing and changes nothing @feat:editor-shell.ai-assistant @level:edge", async ({
    page,
  }) => {
    covers("panel:paged.ai-assistant");
    await aiServiceIsThere(page);
    await openCanvas(page);
    const bodies = await stubClaude(page, []);
    await smallNote(page);
    const model = await modelSnapshot(page);
    await card(page).locator("[data-ai-input]").fill("make it calmer");
    await card(page).locator("[data-cockpit-action=ai-ask]").click();
    await expect(page.locator("[data-ai-consent]")).toBeVisible();
    await page.locator("[data-cockpit-action=ai-consent-cancel]").click();
    await expect(page.locator("[data-ai-consent]")).toHaveCount(0);
    expect(bodies).toHaveLength(0);
    expect(await modelSnapshot(page)).toBe(model);
  });

  test("without an AI service the checks propose on this device: preview changes nothing, Apply is one undo step @feat:editor-shell.ai-assistant @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.ai-assistant");
    await openCanvas(page);
    await smallNote(page);
    await expect(card(page).locator("[data-ai-checks-only]")).toBeVisible();
    const model = await modelSnapshot(page);
    const history = await historyDepth(page);
    await card(page).locator('[data-ai-check="smallText"]').check();
    await card(page).locator("[data-cockpit-action=ai-run-checks]").click();
    const proposal = card(page).locator('[data-ai-proposal="proposed"]');
    await expect(proposal).toBeVisible();
    await expect(
      proposal.locator('[data-ai-proposal-rule="smallText"]'),
    ).toHaveCount(1);
    expect(await modelSnapshot(page)).toBe(model);
    expect(await historyDepth(page)).toEqual(history);
    await card(page).locator("[data-cockpit-action=ai-proposal-apply]").click();
    await expect(card(page).locator("[data-ai-applied]")).toBeVisible();
    expect(await size(page)).toBe(8);
    expect(await undoDepth(page)).toBe(history.undo + 1);
  });
});
