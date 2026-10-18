/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// Scripts that call Claude: paged.ai.complete as a typed host command,
// reached from a real Boa script through the protocol-71 host bridge, with
// the model replaced by a stub backend.

import { afterEach, describe, expect, it } from "vitest";

import { aiObjectModel, AI_COMPLETE_PER_MINUTE } from "../src";
import { headlessEngine } from "./engine-fixture";

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("paged.ai.complete", () => {
  it("a script awaits Claude's text and writes it into the document", async () => {
    const { host } = await headlessEngine();
    dispose = () => host.dispose();
    const prompts: string[] = [];
    host.objects.register({ plugin: "paged.ai", model: aiObjectModel(async (p) => (prompts.push(p), { text: "Spring into tea" })) });
    const run = await host.runScript(`
      const page = JSON.parse(paged.pages())[0].selfId;
      const before = new Set(JSON.parse(paged.stories()).map(s => s.selfId));
      paged.insertTextFrame(page, [72, 72, 200, 523]);
      const story = JSON.parse(paged.stories()).map(s => s.selfId).find(id => !before.has(id));
      const headline = JSON.parse(await paged.invoke("paged.ai.complete", { prompt: "A four-word headline for a spring tea sale" }));
      if (!paged.insertText(story, 0, headline)) throw new Error("insertText");
      console.log(headline);`);
    expect(run.error).toBeNull();
    expect(run.output).toContain("[log] Spring into tea");
    expect(prompts).toEqual(["A four-word headline for a spring tea sale"]);
    expect(run.hostRounds).toBe(1);
    const text = await host.runScript(`console.log(JSON.parse(paged.stories()).map(s => s.characterCount).join())`);
    expect(text.output[0]).toBe(`[log] ${"Spring into tea".length}`);
  });

  it("a refusal or a bad argument rejects the script's promise with a code", async () => {
    const { host } = await headlessEngine();
    dispose = () => host.dispose();
    host.objects.register({ plugin: "paged.ai", model: aiObjectModel(async () => ({ text: "", refusal: { category: "cyber", explanation: null } })) });
    const refused = await host.runScript(`try { await paged.invoke("paged.ai.complete", { prompt: "x" }); } catch (e) { console.log(String(e.message)); }`);
    expect(refused.output.join()).toMatch(/refused: Claude declined/);
    const bad = await host.runScript(`try { await paged.invoke("paged.ai.complete", { text: "x" }); } catch (e) { console.log(String(e.message)); }`);
    expect(bad.output.join()).toMatch(/invalidValue/);
  });

  it("limits calls per minute", async () => {
    let t = 0;
    const model = aiObjectModel(async () => ({ text: "ok" }), () => t);
    const handler = model.commands![0]!.handler;
    for (let i = 0; i < AI_COMPLETE_PER_MINUTE; i++) await handler({ objects: {} as never }, { prompt: "x" });
    await expect(handler({ objects: {} as never }, { prompt: "x" })).rejects.toThrow(/rateLimited/);
    t += 61_000;
    await expect(handler({ objects: {} as never }, { prompt: "x" })).resolves.toBe("ok");
  });
});
