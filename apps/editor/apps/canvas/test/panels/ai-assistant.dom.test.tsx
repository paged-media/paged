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

// AI Assistant (paged.ai-assistant, the shell's AIAssistant): Ask about
// the open document (with what it found wrong), or build a new one from a
// brief. There is no AI service in this lane: a request fails, and the
// panel must say so in words.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import {
  AIAssistant,
  resetAiAvailability,
  setAiAvailability,
} from "@paged-media/shell";

import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { structureIdml } from "./support/structure";

afterEach(() => {
  unmountAll();
  resetAiAvailability();
});

type H = PanelHarness<unknown>;

const panel = (h: H) =>
  h.root.querySelector<HTMLElement>("[data-ai-assistant]")!;
const view = (h: H) => panel(h).getAttribute("data-ai-assistant-view");

describe("AI Assistant panel", () => {
  test("no document: only the brief is offered", async () => {
    covers("panel:paged.ai-assistant");
    const h = await mountPanel(AIAssistant, {
      id: "paged.ai-assistant",
      document: "none",
    });
    expect(view(h)).toBe("brief");
    expect(h.root.querySelector("[data-new-from-brief]")).not.toBeNull();
    expect(h.view.getByRole("textbox", { name: "Brief" })).toBeTruthy();
  });

  test("a document: Ask, with a diagnosis of what the document has wrong", async () => {
    covers("panel:paged.ai-assistant");
    // The structure fixture has an image whose file is missing.
    const h = await mountPanel(AIAssistant, {
      id: "paged.ai-assistant",
      document: structureIdml(),
    });
    expect(view(h)).toBe("ask");
    expect(h.root.querySelector("[data-ai-diagnosis]")?.textContent).toContain(
      "missing image",
    );
    expect(
      h.view.getByRole("textbox", { name: "Ask the AI Assistant" }),
    ).toBeTruthy();
  });

  test("Ask is disabled until there is a request", async () => {
    covers("panel:paged.ai-assistant");
    setAiAvailability("available");
    const h = await mountPanel(AIAssistant, {
      id: "paged.ai-assistant",
      scene: richScene,
    });
    const ask = h.view.getByRole("button", {
      name: "Ask Claude",
    }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask the AI Assistant" }),
      "make this calmer",
    );
    await h.settle();
    expect(ask.disabled).toBe(false);
  });

  test("a request the service refuses ends in a worded error, and Done clears it", async () => {
    covers("panel:paged.ai-assistant");
    // The probe said yes; the request itself fails (no proxy behind it).
    setAiAvailability("available");
    const h = await mountPanel(AIAssistant, {
      id: "paged.ai-assistant",
      scene: richScene,
    });
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask the AI Assistant" }),
      "make this calmer",
    );
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "Ask Claude" }));
    await h.settle();
    expect(panel(h).getAttribute("data-ai-assistant-state")).toBe("error");
    const error = h.root.querySelector("[data-ai-error]")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent!.length).toBeGreaterThan(2);
    expect(error.textContent).not.toContain("{");
    // Nothing reached the document.
    expect(h.mutations(from)).toEqual([]);
    expect(h.sent("executeScript", from)).toEqual([]);
    await h.click(h.view.getByRole("button", { name: "Done" }));
    expect(h.root.querySelector("[data-ai-error]")).toBeNull();
  });

  // UX audit F-25 (fixed): with no AI service the panel says so up front.
  test("PN-355 (UX F-25): with no AI service, the panel says so before a request is made", async () => {
    covers("panel:paged.ai-assistant");
    setAiAvailability("unavailable");
    const h = await mountPanel(AIAssistant, {
      id: "paged.ai-assistant",
      scene: richScene,
    });
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask the AI Assistant" }),
      "make this calmer",
    );
    await h.settle();
    const ask = h.view.getByRole("button", {
      name: "Ask Claude",
    }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(
      h.root.querySelector("[data-ai-unavailable]")?.textContent,
    ).toContain("not available");
  });
});
