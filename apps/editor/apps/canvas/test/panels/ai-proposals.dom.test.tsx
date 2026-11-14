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

// Editor ADR 1241 — the assistant proposes, you approve. On the real
// engine: the deterministic checks find text smaller than 8 pt and propose
// raising it; the proposal changes nothing (no write, the undo log as it
// was); Apply writes the approved items as ONE undo step, and the panel's
// Undo takes exactly that step back. A request for Claude sends nothing
// until the user sends it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import {
  AIAssistant,
  resetAiAvailability,
  setAiAvailability,
} from "@paged-media/shell";

import { textScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  unmountAll();
  resetAiAvailability();
  globalThis.fetch = realFetch;
});

type H = PanelHarness<{ storyId: string; text: string }>;

async function sizeAt(h: H, storyId: string, s: number, e: number) {
  const v = await h.objects.registry.get(
    `storyRange:${storyId}@${s}..${e}`,
    "characterFontSize",
  );
  return v.kind === "value" ? v.value : v.kind;
}

/** Settle until `found` answers something (the checks read the engine in
 *  many round trips). */
async function until(h: H, found: () => unknown): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (found()) return;
    await h.settle();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

async function undoLen(h: H): Promise<number> {
  return (await h.client.undoLog(0)).undoLen;
}

/** The text scene with its first five characters at 6 pt. */
async function smallCaption() {
  const h = (await mountPanel(AIAssistant, {
    id: "paged.ai-assistant",
    scene: textScene,
  })) as H;
  const { storyId } = h.scene;
  const r = await h.objects.registry.set(
    `storyRange:${storyId}@0..5`,
    "characterFontSize",
    6,
  );
  expect(r.applied).toBe(true);
  await h.settle();
  return h;
}

describe("the assistant proposes, you approve [editor-shell.ai-assistant]", () => {
  test("the checks propose raising small text; nothing changes before Apply; Apply is one undo step @uxi:UXI-MUT-001", async () => {
    covers("panel:paged.ai-assistant");
    setAiAvailability("unavailable");
    const h = await smallCaption();
    const { storyId } = h.scene;
    // Without an AI service the checks are what the panel offers.
    expect(h.root.querySelector("[data-ai-checks-only]")).not.toBeNull();
    const before = await undoLen(h);
    const from = h.mark();
    await h.click(
      h.root.querySelector('[data-cockpit-action="ai-run-checks"]')!,
    );
    await until(h, () => h.root.querySelector('[data-ai-proposal="proposed"]'));
    const items = [...h.root.querySelectorAll("[data-ai-proposal-item]")];
    expect(items.length).toBe(1);
    expect(items[0]!.getAttribute("data-ai-proposal-rule")).toBe("smallText");
    expect(items[0]!.querySelector("[data-ai-before]")?.textContent).toBe("6");
    expect(items[0]!.querySelector("[data-ai-after]")?.textContent).toBe("8");
    // The preview changed nothing.
    expect(h.mutations(from)).toEqual([]);
    expect(await undoLen(h)).toBe(before);
    expect(await sizeAt(h, storyId, 0, 5)).toBe(6);

    await h.click(
      h.root.querySelector('[data-cockpit-action="ai-proposal-apply"]')!,
    );
    await until(h, () => h.root.querySelector("[data-ai-applied]"));
    expect(await sizeAt(h, storyId, 0, 5)).toBe(8);
    expect(await undoLen(h)).toBe(before + 1);
    expect(h.root.querySelector("[data-ai-applied]")?.textContent).toContain(
      "one undo step",
    );

    await h.click(
      h.root.querySelector('[data-cockpit-action="ai-proposal-undo"]')!,
    );
    await h.settle();
    expect(await sizeAt(h, storyId, 0, 5)).toBe(6);
    expect(await undoLen(h)).toBe(before);
  });

  test("an unticked item is not applied; Discard changes nothing", async () => {
    covers("panel:paged.ai-assistant");
    setAiAvailability("unavailable");
    const h = await smallCaption();
    const before = await undoLen(h);
    await h.click(
      h.root.querySelector('[data-cockpit-action="ai-run-checks"]')!,
    );
    await until(h, () => h.root.querySelector('[data-ai-proposal="proposed"]'));
    const box = h.root.querySelector<HTMLInputElement>(
      "[data-ai-proposal-item] input[type=checkbox]",
    )!;
    await h.click(box);
    const apply = h.root.querySelector<HTMLButtonElement>(
      '[data-cockpit-action="ai-proposal-apply"]',
    )!;
    expect(apply.disabled).toBe(true);
    await h.click(
      h.root.querySelector('[data-cockpit-action="ai-proposal-discard"]')!,
    );
    expect(h.root.querySelector("[data-ai-proposal]")).toBeNull();
    expect(await undoLen(h)).toBe(before);
  });

  test("a request for Claude waits for consent: nothing is sent before Send, and Cancel sends nothing", async () => {
    covers("panel:paged.ai-assistant");
    setAiAvailability("available");
    const sent: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response("", { status: 503 });
    }) as typeof fetch;
    const h = await smallCaption();
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask the AI Assistant" }),
      "find all captions smaller than 8 pt",
    );
    await h.click(h.view.getByRole("button", { name: "Ask Claude" }));
    await h.settle();
    const consent = h.root.querySelector("[data-ai-consent]")!;
    expect(consent.getAttribute("role")).toBe("dialog");
    expect(consent.textContent).toContain(
      "find all captions smaller than 8 pt",
    );
    expect(consent.textContent).toContain("Anthropic");
    expect(sent.filter((u) => u.includes("/api/ai/v1/messages"))).toEqual([]);
    // Text is the user's to withhold.
    await h.click(h.root.querySelector("[data-ai-allow-text]")!);
    expect(
      h.root
        .querySelector("[data-ai-consent-text]")
        ?.getAttribute("data-ai-consent-text"),
    ).toBe("off");
    await h.click(h.view.getByRole("button", { name: "Cancel" }));
    expect(h.root.querySelector("[data-ai-consent]")).toBeNull();
    expect(sent.filter((u) => u.includes("/api/ai/v1/messages"))).toEqual([]);
  });
});
