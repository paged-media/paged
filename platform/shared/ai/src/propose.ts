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

// Editor ADR 1234 — the PROPOSAL loop: Inspect → Propose. The model reads
// the document through the host's object model (`read_objects`, answered
// locally by a reader the host restricts to what the user allowed) and
// answers one change set (`propose_changes`). It has no tool that writes:
// the loop ends with a proposal of ordinary property writes, and the host
// previews it and applies only what the user approves, as one undo step
// through the same object model every panel writes through.

import type Anthropic from "@anthropic-ai/sdk";

import type { AgentRefusal } from "./agent";
import { lookupApi, type ApiCatalog } from "./catalog";
import {
  LOOKUP_API,
  PROPOSE_CHANGES,
  READ_OBJECTS,
  READ_OBJECTS_LIMIT,
  parseToolInput,
  type ProposedChangeInput,
} from "./tools";
import { MODE_SPECS } from "./model";
import type { AiTransport } from "./transport";

/** What the host lets the model read: the objects a selector names, and
 *  their values. A refusal (outside the allowed scope, text the user did not
 *  allow) is answered in words. */
export interface ProposalReader {
  read(
    selector: string,
    paths: readonly string[],
    limit: number,
  ): Promise<
    | { objects: Array<{ address: string; values: Record<string, unknown> }> }
    | { refused: string }
  >;
}

export type ProposalEvent =
  | { type: "turn"; turn: number }
  | { type: "read"; selector: string; count: number }
  | { type: "lookup"; query: string };

export interface ProposalOptions {
  transport: AiTransport;
  reader: ProposalReader;
  catalog: ApiCatalog;
  prompt: string | Anthropic.ContentBlockParam[];
  onEvent?: (event: ProposalEvent) => void;
  signal?: AbortSignal;
}

export interface ProposalResult {
  outcome: "proposed" | "refused" | "turnLimit" | "truncated" | "noProposal";
  summary: string;
  changes: ProposedChangeInput[];
  refusal?: AgentRefusal;
  turns: number;
}

const CLIP = 12_000;
const clip = (text: string) =>
  text.length <= CLIP ? text : `${text.slice(0, CLIP)}\n… (cut)`;

/** Run the read-only proposal loop. Never writes. */
export async function runProposalAgent(
  options: ProposalOptions,
): Promise<ProposalResult> {
  const { transport, reader, catalog, onEvent, signal } = options;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: options.prompt },
  ];
  const cap = MODE_SPECS.propose.maxTurns;
  let summary = "";
  let bad = 0;
  for (let turn = 1; turn <= cap; turn++) {
    signal?.throwIfAborted();
    onEvent?.({ type: "turn", turn });
    const message = await transport.turn(
      { mode: "propose", messages },
      { signal },
    );
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (text) summary = text;
    if (message.stop_reason === "refusal") {
      return {
        outcome: "refused",
        summary,
        changes: [],
        refusal: {
          category: message.stop_details?.category ?? null,
          explanation: message.stop_details?.explanation ?? null,
        },
        turns: turn,
      };
    }
    const uses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    messages.push({ role: "assistant", content: message.content });
    if (uses.length === 0)
      return { outcome: "noProposal", summary, changes: [], turns: turn };
    if (message.stop_reason === "max_tokens")
      return { outcome: "truncated", summary, changes: [], turns: turn };
    const results: Anthropic.ToolResultBlockParam[] = [];
    let anyBad = false;
    for (const use of uses) {
      const input = parseToolInput(use.name, use.input);
      if (!input) {
        anyBad = true;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `Invalid input for ${use.name}. Send the call again with the required fields.`,
        });
        continue;
      }
      if (input.name === PROPOSE_CHANGES) {
        // The proposal ends the loop: nothing more is read or sent.
        return {
          outcome: "proposed",
          summary: input.summary || summary,
          changes: input.changes,
          turns: turn,
        };
      }
      if (input.name === READ_OBJECTS) {
        const answer = await reader.read(
          input.selector,
          input.paths,
          READ_OBJECTS_LIMIT,
        );
        onEvent?.({
          type: "read",
          selector: input.selector,
          count: "objects" in answer ? answer.objects.length : 0,
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          ...("refused" in answer ? { is_error: true } : {}),
          content: clip(
            "refused" in answer
              ? answer.refused
              : JSON.stringify(answer.objects),
          ),
        });
        continue;
      }
      if (input.name === LOOKUP_API) {
        onEvent?.({ type: "lookup", query: input.query });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: clip(lookupApi(catalog, input.query)),
        });
        continue;
      }
      // A script or render tool is not offered in this mode; answer it as
      // refused rather than run it.
      anyBad = true;
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: true,
        content: `${use.name} is not available: proposals are read-only.`,
      });
    }
    bad = anyBad ? bad + 1 : 0;
    messages.push({ role: "user", content: results });
    if (bad > 2)
      return { outcome: "truncated", summary, changes: [], turns: turn };
  }
  return { outcome: "turnLimit", summary, changes: [], turns: cap };
}
