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

// The loop against the real engine, with the model replaced by a script of
// canned turns. What is asserted is the loop's contract: tools run locally,
// results (errors, overset) go back, refusals and bad inputs stop safely.

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { complete, runAgent, type AiTransport, type ApiCatalog, type TurnRequest } from "../src";
import { headlessEngine } from "./engine-fixture";

const CATALOG: ApiCatalog = {
  hostFunctions: [{ name: "paged.insertTextFrame", params: "(pageId, [t,l,b,r])", returns: "string | null", kind: "author", summary: "Create a text frame." }],
  idGrammar: [],
  settablePaths: ["characterFontSize"],
  constraints: [],
  propertySchemas: [{ addressKind: "storyRange", path: "characterFontSize", type: { kind: "length", unit: "pt" } }],
};

type Block = Anthropic.ContentBlock;
let n = 0;
const toolUse = (name: string, input: unknown): Block => ({ type: "tool_use", id: `toolu_${++n}`, name, input, caller: { type: "direct" } }) as unknown as Block;
const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
const msg = (content: Block[], stop_reason: Anthropic.StopReason, extra: Partial<Anthropic.Message> = {}): Anthropic.Message =>
  ({
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
    ...extra,
  }) as unknown as Anthropic.Message;

/** A transport that plays canned turns and records what it was sent. */
function scripted(turns: Anthropic.Message[]): AiTransport & { seen: TurnRequest[] } {
  const seen: TurnRequest[] = [];
  return {
    seen,
    async turn(request) {
      seen.push({ mode: request.mode, messages: structuredClone(request.messages) });
      const next = turns.shift();
      if (!next) throw new Error("no more canned turns");
      return next;
    },
  };
}

const OVERFLOW = `
const page = JSON.parse(paged.pages())[0].selfId;
const ok = paged.batch([
  { op: "insertTextFrame", args: { pageId: page, bounds: [72, 72, 84, 200] } },
  { op: "bindCreated", args: { handle: "t" } },
  { op: "insertText", args: { storyId: "$h:t", offset: 0, text: "Far too much text for a frame this small, which will certainly overflow." } },
]);
console.log("batch", ok);`;

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("runAgent", () => {
  it("runs scripts locally, reports overset back, and ends on the summary", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const transport = scripted([
      msg([text("Adding the frame."), toolUse("run_script", { source: OVERFLOW })], "tool_use"),
      msg([toolUse("run_script", { source: "throw new Error('deliberate')" })], "tool_use"),
      msg([text("Added a text frame; its text is overset.")], "end_turn"),
    ]);
    const events: string[] = [];
    const result = await runAgent({ transport, engine, catalog: CATALOG, mode: "script", prompt: "add a frame", onEvent: (e) => events.push(e.type) });

    expect(result.outcome).toBe("done");
    expect(result.summary).toBe("Added a text frame; its text is overset.");
    expect(result.scripts).toHaveLength(2);
    expect(result.scripts[0]!.run.error).toBeNull();
    expect(result.turns).toBe(3);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 60, cacheReadTokens: 240 });

    // Turn 2 saw the first script's result: no error, one overset story.
    const firstResult = (transport.seen[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(firstResult.is_error).toBe(false);
    const report = JSON.parse(firstResult.content as string);
    expect(report.error).toBeNull();
    expect(report.oversetStories).toHaveLength(1);
    expect(report.output.join("\n")).toContain("batch true");

    // Turn 3 saw the thrown error, flagged as an error result.
    const second = (transport.seen[2]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(second.is_error).toBe(true);
    expect(JSON.parse(second.content as string).error).toContain("deliberate");

    // Assistant turns go back verbatim (thinking blocks must not be edited).
    expect(transport.seen[1]!.messages[1]).toEqual({ role: "assistant", content: [text("Adding the frame."), expect.objectContaining({ type: "tool_use" })] });
    expect(events).toContain("scriptResult");
  });

  it("answers lookup_api from the catalog and render_page honestly without a rasteriser", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const transport = scripted([
      msg([toolUse("lookup_api", { query: "fontsize" }), toolUse("render_page", { page: 1 })], "tool_use"),
      msg([text("Done.")], "end_turn"),
    ]);
    await runAgent({ transport, engine, catalog: CATALOG, mode: "assist", prompt: "look" });
    const [lookup, render] = transport.seen[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(lookup!.content).toContain("storyRange.characterFontSize");
    expect(render!.is_error).toBe(true);
  });

  it("stops on a refusal without running the cut-off tool call", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const transport = scripted([
      msg([toolUse("run_script", { source: OVERFLOW })], "refusal", {
        stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
      } as Partial<Anthropic.Message>),
    ]);
    const result = await runAgent({ transport, engine, catalog: CATALOG, mode: "script", prompt: "x" });
    expect(result.outcome).toBe("refused");
    expect(result.refusal).toEqual({ category: "cyber", explanation: "declined" });
    expect(result.scripts).toHaveLength(0);
  });

  it("never runs a tool input truncated at max_tokens", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const transport = scripted([msg([toolUse("run_script", { source: "paged.insertPage()" })], "max_tokens")]);
    const result = await runAgent({ transport, engine, catalog: CATALOG, mode: "script", prompt: "x" });
    expect(result.outcome).toBe("truncated");
    expect(result.scripts).toHaveLength(0);
  });

  it("returns invalid tool input as an error result and gives up after repeated bad turns", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const bad = () => msg([toolUse("run_script", { src: "oops" })], "tool_use");
    const transport = scripted([bad(), bad(), bad(), bad()]);
    const result = await runAgent({ transport, engine, catalog: CATALOG, mode: "script", prompt: "x" });
    expect(result.outcome).toBe("truncated");
    expect(result.scripts).toHaveLength(0);
    const first = (transport.seen[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(first.is_error).toBe(true);
  });

  it("stops at the mode's turn cap", async () => {
    const { engine, host } = await headlessEngine();
    dispose = () => host.dispose();
    const loopTurn = () => msg([toolUse("run_script", { source: "console.log(1)" })], "tool_use");
    const transport = scripted(Array.from({ length: 10 }, loopTurn));
    const result = await runAgent({ transport, engine, catalog: CATALOG, mode: "assist", prompt: "x", maxTurns: 3 });
    expect(result.outcome).toBe("turnLimit");
    expect(result.turns).toBe(3);
  });
});

describe("document mode", () => {
  it("builds a multi-page document from a blank page", async () => {
    const { host } = await headlessEngine();
    dispose = () => host.dispose();
    await host.newBlank(595, 842);
    const engine = { runScript: (src: string) => host.runScript(src) };
    const FOUNDATION = `
const h = paged.createParagraphStyle({ name: "Headline" });
if (!h || !paged.setStyleProperty("paragraph", h, "characterFontSize", 40)) throw new Error("style");
console.log(h);`;
    const PAGES = `
const first = JSON.parse(paged.pages())[0].selfId;
const second = paged.insertPage(first);
if (!second) throw new Error("insertPage");
for (const [page, text] of [[first, "Spring collection"], [second, "Prices and order form"]]) {
  const ok = paged.batch([
    { op: "insertTextFrame", args: { pageId: page, bounds: [72, 72, 200, 523] } },
    { op: "bindCreated", args: { handle: "t" } },
    { op: "insertText", args: { storyId: "$h:t", offset: 0, text } },
    { op: "applyStyle", args: { storyId: "$h:t", start: 0, end: text.length, style: JSON.parse(paged.paragraphStyles()).find(s => s.name === "Headline").selfId, scope: "paragraph" } },
  ]);
  if (!ok) throw new Error("page " + page);
}
console.log(JSON.parse(paged.pages()).length);`;
    const transport = scripted([
      msg([toolUse("run_script", { source: FOUNDATION })], "tool_use"),
      msg([toolUse("run_script", { source: PAGES })], "tool_use"),
      msg([text("Built a two-page spring catalogue.")], "end_turn"),
    ]);
    const result = await runAgent({ transport, engine, catalog: CATALOG, mode: "document", prompt: "a two-page spring catalogue" });
    expect(result.outcome).toBe("done");
    expect(result.scripts.map((x) => x.run.error)).toEqual([null, null]);
    expect(result.scripts[1]!.run.output.at(-1)).toBe("[log] 2");
    expect(transport.seen[0]!.mode).toBe("document");
  });
});

describe("complete", () => {
  it("returns the text, or the refusal", async () => {
    expect(await complete(scripted([msg([text("A crisp headline")], "end_turn")]), "headline")).toEqual({ text: "A crisp headline" });
    const refused = await complete(
      scripted([msg([], "refusal", { stop_details: { type: "refusal", category: null, explanation: null } } as Partial<Anthropic.Message>)]),
      "x",
    );
    expect(refused.refusal).toEqual({ category: null, explanation: null });
  });
});
