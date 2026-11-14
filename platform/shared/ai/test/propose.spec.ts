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

// Editor ADR 1241 — the proposal loop: reads go through the host's reader,
// the loop ends on the first `propose_changes`, a script tool is refused
// rather than run, and the proxy's request for the mode offers only the
// read-only tools.

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "bun:test";

import {
  MODE_SPECS,
  PROPOSE_TOOLS,
  buildRequest,
  runProposalAgent,
  type AiTransport,
  type ApiCatalog,
  type ProposalReader,
} from "../src";

const CATALOG: ApiCatalog = {
  hostFunctions: [],
  idGrammar: [],
  settablePaths: ["characterFontSize"],
  constraints: [],
  propertySchemas: [],
};

let n = 0;
const use = (name: string, input: unknown) =>
  ({
    type: "tool_use",
    id: `toolu_${++n}`,
    name,
    input,
  }) as unknown as Anthropic.ContentBlock;
const msg = (content: Anthropic.ContentBlock[], stop: Anthropic.StopReason) =>
  ({
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as Anthropic.Message;

function scripted(
  turns: Anthropic.Message[],
): AiTransport & { modes: string[] } {
  const modes: string[] = [];
  return {
    modes,
    async turn(request) {
      modes.push(request.mode);
      const next = turns.shift();
      if (!next) throw new Error("no more turns");
      return next;
    },
  };
}

describe("runProposalAgent", () => {
  it("reads through the host, ends on the proposal, writes nothing", async () => {
    const reads: string[] = [];
    const reader: ProposalReader = {
      async read(selector, paths) {
        reads.push(`${selector}:${paths.join(",")}`);
        return {
          objects: [
            { address: "storyRange:u1@0..9", values: { characterFontSize: 6 } },
          ],
        };
      },
    };
    const transport = scripted([
      msg(
        [
          use("read_objects", {
            selector: "story",
            paths: ["characterFontSize"],
          }),
        ],
        "tool_use",
      ),
      msg(
        [
          use("propose_changes", {
            summary: "Raise the small caption to 8 pt.",
            changes: [
              {
                address: "storyRange:u1@0..9",
                path: "characterFontSize",
                value: 8,
                reason: "6 pt is below 8 pt",
              },
            ],
          }),
        ],
        "tool_use",
      ),
    ]);
    const result = await runProposalAgent({
      transport,
      reader,
      catalog: CATALOG,
      prompt: "captions",
    });
    expect(result.outcome).toBe("proposed");
    expect(result.changes).toEqual([
      {
        address: "storyRange:u1@0..9",
        path: "characterFontSize",
        value: 8,
        reason: "6 pt is below 8 pt",
      },
    ]);
    expect(reads).toEqual(["story:characterFontSize"]);
    expect(transport.modes).toEqual(["propose", "propose"]);
  });

  it("a script tool is answered as refused, never run", async () => {
    const reader: ProposalReader = { read: async () => ({ objects: [] }) };
    const transport = scripted([
      msg(
        [use("run_script", { source: "paged.set('doc','x',1)" })],
        "tool_use",
      ),
      msg(
        [use("propose_changes", { summary: "Nothing.", changes: [] })],
        "tool_use",
      ),
    ]);
    const result = await runProposalAgent({
      transport,
      reader,
      catalog: CATALOG,
      prompt: "x",
    });
    expect(result.outcome).toBe("proposed");
    expect(result.changes).toEqual([]);
  });

  it("the reader's refusal goes back to the model as an error", async () => {
    let answered: unknown = null;
    const reader: ProposalReader = {
      read: async () => ({ refused: "outside the selection" }),
    };
    const transport: AiTransport = {
      async turn(request) {
        const last = request.messages[request.messages.length - 1];
        if (Array.isArray(last?.content)) answered = last.content[0];
        return request.messages.length === 1
          ? msg(
              [
                use("read_objects", {
                  selector: "frame",
                  paths: ["frameBounds"],
                }),
              ],
              "tool_use",
            )
          : msg(
              [use("propose_changes", { summary: "", changes: [] })],
              "tool_use",
            );
      },
    };
    await runProposalAgent({
      transport,
      reader,
      catalog: CATALOG,
      prompt: "x",
    });
    expect(answered).toMatchObject({
      is_error: true,
      content: "outside the selection",
    });
  });

  it("the propose mode's request offers only read_objects, lookup_api and propose_changes", () => {
    const r = buildRequest({
      mode: "propose",
      messages: [{ role: "user", content: "x" }],
      catalog: CATALOG,
    });
    expect((r.tools as Anthropic.Tool[]).map((t) => t.name)).toEqual([
      "read_objects",
      "lookup_api",
      "propose_changes",
    ]);
    expect(PROPOSE_TOOLS).toHaveLength(3);
    expect(MODE_SPECS.propose.tools).toBe("propose");
  });
});
