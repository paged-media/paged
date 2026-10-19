/*
 * This file is part of paged (https://paged.media).
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

// How one model turn reaches Claude. Two implementations of one interface:
//
// - direct: the caller holds an Anthropic credential (the CLI, a server).
//   Builds the full request locally.
// - proxy: the editor in a browser. The key lives on the same-origin proxy
//   (`/api/ai`), which rebuilds system prompt, tools, model and caps from the
//   mode; the client sends only the conversation.

import Anthropic from "@anthropic-ai/sdk";

import type { ApiCatalog } from "./catalog";
import { DEFAULT_MODEL, MODE_SPECS, type AiMode } from "./model";
import { buildRequest } from "./request";

export interface TurnRequest {
  mode: AiMode;
  messages: Anthropic.MessageParam[];
}

export interface TurnHooks {
  /** Each streamed text delta of the reply. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AiTransport {
  turn(request: TurnRequest, hooks?: TurnHooks): Promise<Anthropic.Message>;
}

/** The header the proxy reads the mode from. */
export const MODE_HEADER = "x-paged-ai-mode";

async function streamTurn(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  hooks: TurnHooks | undefined,
): Promise<Anthropic.Message> {
  const stream = client.messages.stream(params, { signal: hooks?.signal });
  if (hooks?.onText) stream.on("text", hooks.onText);
  return stream.finalMessage();
}

export interface DirectTransportOptions {
  catalog: ApiCatalog;
  /** An existing client; else one is built from `apiKey` or, with neither,
   *  from the environment (ANTHROPIC_API_KEY or an `ant auth login`
   *  profile). */
  client?: Anthropic;
  apiKey?: string;
  model?: string;
}

export function createDirectTransport(
  options: DirectTransportOptions,
): AiTransport {
  const client =
    options.client ??
    new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  return {
    turn: (request, hooks) =>
      streamTurn(
        client,
        buildRequest({
          ...request,
          catalog: options.catalog,
          model: options.model,
        }),
        hooks,
      ),
  };
}

export interface ProxyTransportOptions {
  /** Absolute base URL of the proxy, e.g. `https://play.paged.media/api/ai`
   *  (the SDK appends `/v1/messages`). */
  baseURL: string;
  /** Extra headers on every call, e.g. the Turnstile token. Read per call,
   *  so a fresh token can be supplied each time. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** For tests: the fetch the client uses. */
  fetch?: typeof fetch;
}

export function createProxyTransport(
  options: ProxyTransportOptions,
): AiTransport {
  return {
    async turn(request, hooks) {
      const client = new Anthropic({
        baseURL: options.baseURL,
        // The proxy holds the real key and ignores this one.
        apiKey: "paged-proxy",
        dangerouslyAllowBrowser: true,
        // The proxy owns retries against Anthropic; a client retry would
        // double-count against the rate limit.
        maxRetries: 0,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        defaultHeaders: {
          [MODE_HEADER]: request.mode,
          ...(options.headers ? await options.headers() : {}),
        },
      });
      // Only model, max_tokens and messages matter here: the proxy rebuilds
      // the rest from the mode.
      return streamTurn(
        client,
        {
          model: DEFAULT_MODEL,
          max_tokens: MODE_SPECS[request.mode].maxTokens,
          messages: request.messages,
        },
        hooks,
      );
    },
  };
}
