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

// Script (paged.script-editor): a Boa script run through executeScript on
// the real engine, its console output and error in the log; and the Ask
// bar, which hands a request to the editor agent (no AI service here) only
// after the consent card's Send (editor ADR 1241, amended 2026-11-14).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { resetAiAvailability, setAiAvailability } from "@paged-media/shell";

import { ScriptEditorPanel } from "../../src/panels/script-editor";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

const realFetch = globalThis.fetch;
let restoreUrl: (() => void) | null = null;
afterEach(() => {
  unmountAll();
  resetAiAvailability();
  globalThis.fetch = realFetch;
  restoreUrl?.();
  restoreUrl = null;
});

/** The AI service, stubbed: every request to Claude is recorded (its
 *  first message's text) and answered 503, so the run ends at once. The
 *  page gets an origin, which the proxy's URL is resolved against. */
function stubClaude(): Array<{ url: string; prompt: string }> {
  const dom = (
    window as unknown as { happyDOM?: { setURL(url: string): void } }
  ).happyDOM;
  const was = window.location.href;
  dom?.setURL("https://editor.test/");
  restoreUrl = () => dom?.setURL(was);
  const sent: Array<{ url: string; prompt: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body =
      input instanceof Request
        ? await input.clone().text()
        : typeof init?.body === "string"
          ? init.body
          : "";
    if (url.includes("/api/ai/v1/messages")) {
      const json = JSON.parse(body || "{}") as {
        messages?: Array<{ content: unknown }>;
      };
      const content = json.messages?.[0]?.content;
      sent.push({
        url,
        prompt: typeof content === "string" ? content : JSON.stringify(content),
      });
    }
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "ai_unavailable", message: "stubbed: no service" },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return sent;
}

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ScriptEditorPanel, {
    id: "paged.script-editor",
    scene: richScene,
  });

const source = (h: H) =>
  h.root.querySelector<HTMLTextAreaElement>("[data-script-source]")!;
const log = (h: H) => h.root.querySelector("[data-script-log]")!;
const runButton = (h: H) =>
  h.root.querySelector<HTMLButtonElement>('[data-action="run"]')!;

/** Replace the editor's source the way a user does (select all, type). */
async function write(h: H, text: string) {
  await h.user.clear(source(h));
  // user-event reads { and [ as key descriptors: escape them.
  await h.user.type(
    source(h),
    text.replace(/[{[]/g, (c) => c + c),
  );
}

describe("Script editor panel", () => {
  test("opens on the example and the log's hint", async () => {
    covers("panel:paged.script-editor");
    const h = await mount();
    expect(source(h).value).toContain("paged.set(");
    expect(log(h).textContent).toBe("Cmd-Enter to run. Output appears here.");
    expect(runButton(h).disabled).toBe(false);
  });

  test("Run sends the source as one executeScript, the write lands, the output shows", async () => {
    covers("panel:paged.script-editor");
    const h = await mount();
    const address = `rectangle:${String(h.scene.rect.id)}`;
    const script = `paged.set("${address}", "frameStrokeWeight", 4); console.log("weight set");`;
    await write(h, script);
    const from = h.mark();
    await h.click(runButton(h));
    const sent = h.sent("executeScript", from);
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as { source: string }).source).toBe(script);
    expect(await h.get(address, "frameStrokeWeight")).toEqual({
      type: "length",
      value: 4,
    });
    expect(log(h).textContent).toContain("weight set");
    expect(log(h).querySelector("[data-script-error]")).toBeNull();
  });

  test("Cmd or Ctrl and Enter in the source runs it", async () => {
    covers("panel:paged.script-editor");
    const h = await mount();
    await write(h, 'console.log("from the keyboard");');
    const from = h.mark();
    await h.user.keyboard("{Control>}{Enter}{/Control}");
    await h.settle();
    expect(h.sent("executeScript", from)).toHaveLength(1);
    expect(log(h).textContent).toContain("from the keyboard");
  });

  test("a script that throws shows its error, and nothing else is written", async () => {
    covers("panel:paged.script-editor");
    const h = await mount();
    await write(h, 'throw new Error("boom");');
    const from = h.mark();
    await h.click(runButton(h));
    expect(log(h).querySelector("[data-script-error]")?.textContent).toContain(
      "boom",
    );
    expect(h.mutations(from)).toEqual([]);
  });

  test("Ask is disabled until there is a request", async () => {
    covers("panel:paged.script-editor");
    setAiAvailability("available");
    const h = await mount();
    const ask = h.root.querySelector<HTMLButtonElement>('[data-action="ask"]')!;
    expect(ask.disabled).toBe(true);
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask Claude to write a script" }),
      "make the frame red",
    );
    await h.settle();
    expect(ask.disabled).toBe(false);
  });

  test("Ask the service refuses: the request and a worded error in the log, no script run", async () => {
    covers("panel:paged.script-editor");
    // The probe said yes; the request itself fails (no proxy behind it).
    setAiAvailability("available");
    const h = await mount();
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask Claude to write a script" }),
      "make the frame red",
    );
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="ask"]')!);
    await h.click(h.view.getByRole("button", { name: "Send to Claude" }));
    await h.settle();
    expect(log(h).querySelector("[data-script-note]")?.textContent).toBe(
      "You: make the frame red",
    );
    const error =
      log(h).querySelector("[data-script-error]")?.textContent ?? "";
    expect(error.length).toBeGreaterThan(2);
    expect(error).not.toContain("{");
    expect(h.sent("executeScript", from)).toEqual([]);
  });

  test("Ask waits at the consent card: nothing is sent before Send, Cancel sends nothing, every request asks again", async () => {
    covers("panel:paged.script-editor");
    setAiAvailability("available");
    const sent = stubClaude();
    const h = await mount();
    const input = () =>
      h.view.getByRole("textbox", { name: "Ask Claude to write a script" });
    const card = () => h.root.querySelector("[data-ai-consent]");
    await write(h, 'console.log("mine");\nconsole.log("two");');
    await h.user.type(input(), "make the frame red");
    await h.click(h.root.querySelector('[data-action="ask"]')!);
    await h.settle();

    // The assistant's card, listing what would leave the device.
    expect(card()?.getAttribute("data-ai-consent")).toBe("script");
    expect(card()?.getAttribute("role")).toBe("dialog");
    const listed = card()!.querySelector("[data-ai-consent-scope]")!;
    expect(listed.textContent).toContain("make the frame red");
    expect(listed.querySelector("[data-ai-consent-script]")?.textContent).toBe(
      "the script in the Script panel (2 lines)",
    );
    expect(
      listed.querySelector("[data-ai-consent-document]")?.textContent,
    ).toContain("pictures of its pages");
    expect(card()!.textContent).toContain("Anthropic");
    expect(sent).toEqual([]);
    expect(log(h).querySelector("[data-script-note]")).toBeNull();

    // Cancel: nothing sent, the request is still in the field.
    await h.click(h.view.getByRole("button", { name: "Cancel" }));
    await h.settle();
    expect(card()).toBeNull();
    expect(sent).toEqual([]);
    expect(input()).toHaveProperty("value", "make the frame red");

    // Asked again, it asks again; the script can stay here.
    await h.click(h.root.querySelector('[data-action="ask"]')!);
    expect(card()).not.toBeNull();
    expect(sent).toEqual([]);
    await h.click(h.root.querySelector("[data-ai-send-script]")!);
    expect(
      card()!
        .querySelector("[data-ai-consent-script]")
        ?.getAttribute("data-ai-consent-script"),
    ).toBe("off");
    await h.click(h.view.getByRole("button", { name: "Send to Claude" }));
    await h.settle();
    expect(card()).toBeNull();
    // Send sends this request, as listed: the words, not the script.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.prompt).toBe("make the frame red");

    // The next request asks again; sent with the script, the script goes.
    await h.user.type(input(), "and the stroke");
    await h.click(h.root.querySelector('[data-action="ask"]')!);
    await h.settle();
    expect(card()).not.toBeNull();
    expect(sent).toHaveLength(1);
    await h.click(h.view.getByRole("button", { name: "Send to Claude" }));
    await h.settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.prompt).toContain("and the stroke");
    expect(sent[1]!.prompt).toContain('console.log("mine");');
  });

  test("the untouched example script is not offered to Claude", async () => {
    covers("panel:paged.script-editor");
    setAiAvailability("available");
    const sent = stubClaude();
    const h = await mount();
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask Claude to write a script" }),
      "make the frame red",
    );
    await h.click(h.root.querySelector('[data-action="ask"]')!);
    await h.settle();
    expect(
      h.root
        .querySelector("[data-ai-consent-script]")
        ?.getAttribute("data-ai-consent-script"),
    ).toBe("off");
    await h.click(h.view.getByRole("button", { name: "Send to Claude" }));
    await h.settle();
    expect(sent.map((s) => s.prompt)).toEqual(["make the frame red"]);
  });

  // UX audit F-25 (fixed): with no AI service, Ask says so up front.
  test("PN-352 (UX F-25): with no AI service, Ask says so before a request is typed", async () => {
    covers("panel:paged.script-editor");
    setAiAvailability("unavailable");
    const h = await mount();
    await h.user.type(
      h.view.getByRole("textbox", { name: "Ask Claude to write a script" }),
      "make the frame red",
    );
    await h.settle();
    const ask = h.root.querySelector<HTMLButtonElement>('[data-action="ask"]')!;
    expect(ask.disabled).toBe(true);
    expect(
      h.root.querySelector("[data-script-ai-unavailable]")?.textContent,
    ).toContain("not available");
  });
});
