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

// The MCP protocol core of `paged mcp` (Model Context Protocol, JSON-RPC 2.0
// over stdio, one message per line), the TypeScript twin of the engine's
// `paged-mcp` crate (src/lib.rs there): the same protocol revisions, methods,
// error codes and messages, so the two CLIs answer an agent alike. Hand
// written rather than on the MCP TypeScript SDK: the subset is small
// (initialize, ping, tools/list, tools/call, resources/list,
// resources/read), and the SDK's own negotiation and error texts would part
// from the Rust server's.

import { createInterface } from "node:readline";

import {
  INSTRUCTIONS,
  toolJson,
  VIEW_MIME,
  VIEW_URI,
  type Tool,
} from "./tools";

/** Protocol revisions this core speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** What a tool call returns. A tool that fails reports it here (`isError`),
 *  so the model reads the reason; protocol errors are for malformed calls. */
export interface Outcome {
  content: Content[];
  structured?: unknown;
  isError: boolean;
}

export const ok = (text: string): Outcome => ({
  content: [{ type: "text", text }],
  isError: false,
});

/** A JSON result, as text (pretty, keys sorted as serde_json prints them)
 *  and as structured content. */
export const json = (v: unknown): Outcome => ({
  content: [{ type: "text", text: JSON.stringify(sortKeys(v), null, 2) }],
  structured: sortKeys(v),
  isError: false,
});

export const error = (text: string): Outcome => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** serde_json's `Value` keeps object keys sorted; so does this, so a result
 *  reads the same from either CLI. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}

function outcomeJson(o: Outcome): Record<string, unknown> {
  return {
    content: o.content,
    isError: o.isError,
    ...(o.structured !== undefined ? { structuredContent: o.structured } : {}),
  };
}

/** A place the tools run. */
export interface Host {
  /** Who this host is, for `serverInfo`. */
  name(): string;
  version(): string;
  /** The tools this host offers: the catalog, or a subset of it. */
  tools(): Tool[];
  call(tool: string, args: Record<string, unknown>): Promise<Outcome>;
  /** The HTML of VIEW_URI, when the host serves the view. */
  view?(): string | null;
  instructions?(): string;
}

type Msg = Record<string, unknown>;

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const result = (id: unknown, r: unknown) => ({ jsonrpc: "2.0", id, result: r });

/** Answers one JSON-RPC message, or nothing for a notification. */
export async function handle(host: Host, msg: unknown): Promise<Msg | null> {
  const m = (msg ?? {}) as Msg;
  const method = typeof m["method"] === "string" ? m["method"] : null;
  if (method === null) return rpcError(null, -32600, "not a JSON-RPC request");
  if (!("id" in m)) return null;
  const id = m["id"];
  const params = (
    m["params"] && typeof m["params"] === "object" ? m["params"] : {}
  ) as Msg;
  const view = host.view?.() ?? null;
  switch (method) {
    case "initialize": {
      const asked = params["protocolVersion"];
      const version =
        PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
      return result(id, {
        protocolVersion: version,
        capabilities: {
          tools: { listChanged: false },
          ...(view !== null ? { resources: { listChanged: false } } : {}),
        },
        serverInfo: { name: host.name(), version: host.version() },
        instructions: host.instructions?.() ?? INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: host.tools().map(toolJson) });
    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string")
        return rpcError(id, -32602, "tools/call needs a name");
      if (!host.tools().some((t) => t.name === name))
        return rpcError(id, -32602, `no tool ${name}`);
      const args = (
        params["arguments"] && typeof params["arguments"] === "object"
          ? params["arguments"]
          : {}
      ) as Record<string, unknown>;
      let out: Outcome;
      try {
        out = await host.call(name, args);
      } catch (err) {
        out = error(err instanceof Error ? err.message : String(err));
      }
      return result(id, outcomeJson(out));
    }
    case "resources/list":
      return result(id, {
        resources:
          view !== null
            ? [
                {
                  uri: VIEW_URI,
                  name: "paged",
                  mimeType: VIEW_MIME,
                  description: "Pages, history and changes of a paged document",
                },
              ]
            : [],
      });
    case "resources/read":
      if (params["uri"] === VIEW_URI && view !== null)
        return result(id, {
          contents: [{ uri: VIEW_URI, mimeType: VIEW_MIME, text: view }],
        });
      return rpcError(id, -32002, "no such resource");
    default:
      return rpcError(id, -32601, `no method ${method}`);
  }
}

/** The stdio transport: one JSON-RPC message per line in, one per line out,
 *  answered in order. Resolves when the input ends. */
export async function serveStdio(
  host: Host,
  input: NodeJS.ReadableStream = process.stdin,
  write: (line: string) => void = (l) => void process.stdout.write(l),
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let reply: Msg | null;
    try {
      reply = await handle(host, JSON.parse(line));
    } catch (err) {
      reply = rpcError(
        null,
        -32700,
        `parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (reply) write(`${JSON.stringify(reply)}\n`);
  }
}
