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
// bar, which hands a request to the editor agent (no AI service here).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { resetAiAvailability, setAiAvailability } from "@paged-media/shell";

import { ScriptEditorPanel } from "../../src/panels/script-editor";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(() => {
  unmountAll();
  resetAiAvailability();
});

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
