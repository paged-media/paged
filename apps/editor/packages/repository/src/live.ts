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

// The editor tab's end of paged.server's live relay: a model's engine tools
// (run a script, render a page, save) arrive here over a WebSocket and run in
// this tab, where the person sees them. Main thread.
//
// A browser cannot put a bearer token on a WebSocket, so the token is traded
// first for a one-minute ticket (POST /v1/live), which the socket's URL carries.

export interface LiveCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** The agent calling: `agent:<client>`. */
  agent: string;
  /** The model's run (its MCP session): its branches are `agent/<run>/…`. */
  run: string;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** An MCP `CallToolResult`. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError: boolean;
}

export type LiveState = "connecting" | "open" | "closed";

export interface LiveConnection {
  readonly session: string;
  close(): void;
}

export async function connectLive(
  server: string,
  token: string,
  info: { document: string; title: string },
  handle: (call: LiveCall) => Promise<ToolResult>,
  onState: (state: LiveState, why?: string) => void,
): Promise<LiveConnection> {
  server = server.replace(/\/$/, "");
  onState("connecting");
  const resp = await fetch(`${server}/v1/live`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(info),
  });
  if (!resp.ok) {
    onState("closed", `the server refused (${resp.status})`);
    throw new Error(`the server refused the connection (${resp.status})`);
  }
  const { session, url } = (await resp.json()) as {
    session: string;
    url: string;
  };
  const ws = new WebSocket(`${server.replace(/^http/, "ws")}${url}`);
  let alive: ReturnType<typeof setInterval> | undefined;
  ws.onopen = () => {
    onState("open");
    ws.send(JSON.stringify({ type: "hello", ...info }));
    alive = setInterval(
      () => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'),
      30_000,
    );
  };
  ws.onclose = (e) => {
    clearInterval(alive);
    onState("closed", e.reason || undefined);
  };
  ws.onmessage = async (e) => {
    let msg: { type?: string } & Partial<LiveCall>;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type !== "call" || !msg.id) return;
    let result: ToolResult;
    try {
      result = await handle(msg as LiveCall);
    } catch (err) {
      result = {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "result", id: msg.id, result }));
  };
  return {
    session,
    close: () => ws.close(1000, "disconnected in the editor"),
  };
}
