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

// ADR 225 — this tab's end of the live relay: a model's engine tools, sent by
// paged.server, run here through the editor's own doors. Scripts run through
// the Script panel's undoable path, renders through the editor's page
// snapshot, and saves become an agent's version on its own branch, never main.
// The person sees every call in the Library panel and, while "Ask before each
// change" is on (the default), allows or declines each one that changes the
// document.
//
// A MODULE-SCOPE STORE (like library-document.ts): the connection outlives the
// panel being closed and reopened.

import { canvasScriptEngine, commitSave, currentLibraryDocument, getLibrary } from "@paged-media/shell";
import { accessToken, connectLive, type LiveCall, type LiveConnection, type LiveState, type ToolResult } from "@paged-media/repository";
import type { CanvasClient } from "@paged-media/client";

export interface LiveEntry {
  id: string;
  tool: string;
  summary: string;
  ts: number;
  outcome: "pending" | "done" | "declined" | "failed";
}

interface Pending {
  call: LiveCall;
  resolve: (allowed: boolean) => void;
}

const CHANGES = new Set(["run_script", "save_document"]);

let connection: LiveConnection | null = null;
let state: LiveState = "closed";
let reason: string | undefined;
let ask = true;
let log: LiveEntry[] = [];
let pending: Pending[] = [];
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const l of listeners) l();
}

export const live = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  version: () => version,
  state: () => state,
  reason: () => reason,
  session: () => connection?.session ?? null,
  log: () => log,
  pending: () => pending.map((p) => p.call),
  ask: () => ask,
  setAsk(v: boolean) {
    ask = v;
    changed();
  },
  answer(id: string, allowed: boolean) {
    const p = pending.find((x) => x.call.id === id);
    if (!p) return;
    pending = pending.filter((x) => x !== p);
    p.resolve(allowed);
    changed();
  },
};

function note(call: LiveCall, outcome: LiveEntry["outcome"]): void {
  const source = typeof call.args.source === "string" ? call.args.source : "";
  const summary = source ? source.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "" : JSON.stringify(call.args).slice(0, 80);
  const existing = log.find((e) => e.id === call.id);
  if (existing) existing.outcome = outcome;
  else log = [{ id: call.id, tool: call.tool, summary, ts: Date.now(), outcome }, ...log].slice(0, 25);
  changed();
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function handle(client: CanvasClient, call: LiveCall): Promise<ToolResult> {
  note(call, "pending");
  if (CHANGES.has(call.tool) && ask) {
    const allowed = await new Promise<boolean>((resolve) => {
      pending = [...pending, { call, resolve }];
      changed();
    });
    if (!allowed) {
      note(call, "declined");
      return text("The person declined this change in the editor.", true);
    }
  }
  const engine = canvasScriptEngine(client);
  try {
    let result: ToolResult;
    switch (call.tool) {
      case "open_document": {
        const doc = currentLibraryDocument();
        result = {
          content: [{ type: "text", text: `This tab has ${doc?.name ?? "an unsaved document"} open; engine tools act on it.` }],
          structuredContent: { document: doc?.remote?.repo ?? doc?.name ?? null, open: doc?.name ?? null },
          isError: false,
        };
        break;
      }
      case "run_script": {
        const run = await engine.runScript(String(call.args.source ?? ""));
        result = {
          content: [{ type: "text", text: [...run.output, ...(run.error ? [`error: ${run.error}`] : [])].join("\n") || "(no output)" }],
          structuredContent: { output: run.output, error: run.error ?? null },
          isError: Boolean(run.error),
        };
        break;
      }
      case "render_page": {
        const page = Number(call.args.page ?? 1) || 1;
        const png = engine.renderPage ? await engine.renderPage(page) : null;
        result = png
          ? { content: [{ type: "image", data: b64(png), mimeType: "image/png" }], isError: false }
          : text(`There is no page ${page}.`, true);
        break;
      }
      case "save_document": {
        const library = getLibrary();
        if (!library) return text("This editor keeps no library.", true);
        const bytes = await client.exportPaged();
        if (!currentLibraryDocument()) await commitSave(bytes.slice(), "document");
        const doc = currentLibraryDocument();
        if (!doc) return text("The document could not be kept in the library.", true);
        const message = String(call.args.message ?? "Claude's edit");
        const saved = await library.saveAgent(doc.id, bytes, { agent: call.agent, client: "mcp", run: call.run }, message);
        result = {
          content: [{ type: "text", text: `Kept as a version on ${saved.branch}. The person merges it from the Library panel; main has not moved.` }],
          structuredContent: { ref: saved.branch, at: saved.head },
          isError: false,
        };
        break;
      }
      default:
        result = text(`This tab does not run ${call.tool}.`, true);
    }
    note(call, result.isError ? "failed" : "done");
    return result;
  } catch (err) {
    note(call, "failed");
    return text(err instanceof Error ? err.message : String(err), true);
  }
}

/** Connects this tab to `server` for the signed-in person. */
export async function connect(server: string, client: CanvasClient): Promise<void> {
  if (connection) return;
  const token = await accessToken(server);
  if (!token) throw new Error("Sign in to the server first.");
  const doc = currentLibraryDocument();
  connection = await connectLive(
    server,
    token,
    { document: doc?.remote?.repo ?? "", title: doc?.name ?? document.title },
    (call) => handle(client, call),
    (s, why) => {
      state = s;
      reason = why;
      if (s === "closed") {
        connection = null;
        for (const p of pending) p.resolve(false);
        pending = [];
      }
      changed();
    },
  );
  changed();
}

export function disconnect(): void {
  connection?.close();
}
