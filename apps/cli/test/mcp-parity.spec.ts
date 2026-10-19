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

// `paged mcp` (src/mcp/) against the engine's Rust `paged mcp`
// (engine/core/crates/paged-mcp and paged-cli/src/mcp.rs):
//
// - PARITY: the tool list this CLI answers is the one the Rust CLI answers,
//   name for name, schema for schema, read from the Rust CLI's own recorded
//   `tools/list` (paged-cli/tests/golden/paged.mcp/tools-list.txt, which its
//   golden test writes); the whole catalog against tool-catalog.txt.
// - The protocol core answers as the Rust one: version negotiation, no
//   answer to a notification, the error codes.
// - A stdio session through the bin: every store tool, the engine tools and
//   lookup_api, against a library on disk.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  handle,
  PROTOCOL_VERSIONS,
  sortKeys,
  type Host,
} from "../src/mcp/protocol";
import { DiskLibrary, loadRepositoryWasm } from "../src/mcp/library";
import {
  catalog,
  ENGINE,
  REFERENCE,
  select,
  STORE,
  toolJson,
} from "../src/mcp/tools";
import { tempDir, writeFixture } from "./helpers";

// The surface-conformance marker (a no-op; the gate reads it statically).
const covers = (..._ids: string[]): void => {};

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GOLDEN = join(
  REPO,
  "engine/core/crates/paged-cli/tests/golden/paged.mcp",
);
const ENGINE_DIR = join(REPO, "engine/core/packages/canvas-wasm");
const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

/** The stdout of a Rust CLI golden transcript. */
function goldenStdout(file: string): string {
  const text = readFileSync(join(GOLDEN, file), "utf8");
  const start = text.indexOf("--- stdout\n") + "--- stdout\n".length;
  return text.slice(start, text.indexOf("\n--- stderr", start));
}

describe("paged mcp — the tools are the Rust CLI's", () => {
  it("tools/list equals the Rust `paged mcp`'s, tool for tool and schema for schema", () => {
    covers("cli:paged-node mcp");
    const rust = JSON.parse(goldenStdout("tools-list.txt")) as {
      result: { tools: Array<{ name: string }> };
    };
    const ours = sortKeys(select(STORE, REFERENCE, ENGINE).map(toolJson));
    expect(ours).toEqual(rust.result.tools);
    expect(rust.result.tools.map((t) => t.name)).toEqual([
      ...STORE.slice(0, 10),
      ...ENGINE,
      ...REFERENCE,
    ]);
  });

  it("the whole catalog (paged.server's tools too) equals paged-mcp's", () => {
    covers("cli:paged-node mcp");
    // tool-catalog.txt is the catalog itself, as paged-mcp declares it.
    expect(sortKeys(catalog().map(toolJson))).toEqual(
      JSON.parse(readFileSync(join(GOLDEN, "tool-catalog.txt"), "utf8")),
    );
  });
});

describe("paged mcp — the protocol core", () => {
  const host: Host = {
    name: () => "test",
    version: () => "0",
    tools: () => select(STORE, REFERENCE),
    call: async (tool, args) => ({
      content: [{ type: "text", text: "" }],
      structured: { tool, args },
      isError: false,
    }),
    view: () => "<p>view</p>",
  };
  const rpc = (method: string, params: unknown = {}) =>
    handle(host, { jsonrpc: "2.0", id: 1, method, params });

  it("negotiates a version it speaks, else offers its newest", async () => {
    covers("cli:paged-node mcp");
    const a = (await rpc("initialize", {
      protocolVersion: "2025-06-18",
    })) as any;
    expect(a.result.protocolVersion).toBe("2025-06-18");
    expect(a.result.capabilities.resources).toBeDefined();
    const b = (await rpc("initialize", {
      protocolVersion: "1999-01-01",
    })) as any;
    expect(b.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("answers no notification, and errors as the Rust core does", async () => {
    covers("cli:paged-node mcp");
    expect(
      await handle(host, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeNull();
    const call = (await rpc("tools/call", {
      name: "history",
      arguments: { document: "d" },
    })) as any;
    expect(call.result.structuredContent.args.document).toBe("d");
    expect(
      ((await rpc("tools/call", { name: "run_script" })) as any).error.code,
    ).toBe(-32602);
    expect(((await rpc("no/such")) as any).error).toEqual({
      code: -32601,
      message: "no method no/such",
    });
    expect(
      ((await rpc("resources/read", { uri: "ui://other" })) as any).error.code,
    ).toBe(-32002);
    expect(await handle(host, { id: 3 })).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "not a JSON-RPC request" },
    });
  });
});

describe("paged mcp — a stdio session over a library", () => {
  let tmp: ReturnType<typeof tempDir>;
  let replies: any[] = [];
  beforeAll(async () => {
    tmp = tempDir();
    const fx = await writeFixture(tmp.dir);
    const lib = new DiskLibrary(
      join(tmp.dir, "lib"),
      await loadRepositoryWasm(ENGINE_DIR),
    );
    lib.import("brochure", readFileSync(fx.paged), "brochure.paged");
    const call = (id: number, name: string, args: unknown) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
    // The branch name is the run's (agent/<run>/try): later calls name it
    // through the reply, so the session runs in two halves.
    const first = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      call(2, "list_documents", {}),
      call(3, "describe_document", { document: "brochure" }),
      call(4, "read_part", { document: "brochure", path: "designmap.xml" }),
      call(5, "history", { document: "brochure" }),
      call(6, "lookup_api", { query: "paged.set" }),
      call(7, "open_document", { document: "brochure" }),
      call(8, "run_script", {
        source: "console.log(paged.query('swatch').length)",
      }),
      call(9, "render_page", { page: 1 }),
      call(10, "save_document", { message: "an agent's save" }),
      call(11, "create_branch", { document: "brochure", name: "try" }),
      call(12, "no_such_tool", {}),
      "{bad",
    ];
    const run = (lines: string[]) => {
      const p = spawnSync(
        process.execPath,
        [BIN, "mcp", "--library", join(tmp.dir, "lib"), "--no-plugins"],
        {
          input: `${lines.join("\n")}\n`,
          encoding: "utf8",
        },
      );
      expect(p.status, p.stderr).toBe(0);
      return p.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    };
    replies = run(first);
    const branch = replies.find((r) => r.id === 11).result.structuredContent
      .ref as string;
    replies.push(
      ...run([
        call(13, "commit_parts", {
          document: "brochure",
          branch,
          message: "a note",
          parts: [{ path: "notes/agent.txt", text: "hello" }],
        }),
        call(14, "diff", { document: "brochure", from: "main", to: branch }),
        call(15, "propose_change", {
          document: "brochure",
          branch,
          title: "A note",
        }),
        call(16, "list_changes", { document: "brochure" }),
        call(17, "download_link", { document: "brochure", ref: branch }),
      ]),
    );
  }, 180_000);
  afterAll(() => tmp.done());
  const reply = (id: number) => replies.find((r) => r.id === id);
  const structured = (id: number) => reply(id).result.structuredContent;

  it("initializes, and is silent on the notification", () => {
    covers("cli:paged-node mcp");
    expect(reply(1).result.serverInfo.name).toBe("paged (local)");
    expect(replies.filter((r) => r.id === undefined)).toHaveLength(0);
  });

  it("serves the library: documents, parts, history", () => {
    covers("cli:paged-node mcp");
    expect(structured(2).documents.map((d: any) => d.name)).toEqual([
      "brochure",
    ]);
    expect(
      structured(3).parts.some((p: any) => p.path === "designmap.xml"),
    ).toBe(true);
    expect(structured(3).refs.main).toBe(structured(3).version);
    expect(reply(4).result.content[0].text).toContain("<Document");
    expect(structured(5).versions[0].agent).toBe(false);
  });

  it("runs the engine: a script, a page as a PNG, a save onto an agent branch", () => {
    covers("cli:paged-node mcp");
    expect(structured(7).loaded.pages).toBe(1);
    expect(reply(8).result.isError).toBe(false);
    expect(structured(8).result.output.join("\n")).toMatch(/\d+/);
    const image = reply(9).result.content[0];
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe(
      "PNG",
    );
    expect(structured(10).ref).toMatch(/^agent\/local-[0-9a-f]+\/edit-/);
  });

  it("writes parts on an agent branch, compares, and proposes it", () => {
    covers("cli:paged-node mcp");
    expect(structured(11).ref).toMatch(/^agent\/local-[0-9a-f]+\/try$/);
    expect(structured(13).at).toMatch(/^[0-9a-f]{64}$/);
    expect(structured(14)).toEqual([
      { path: "notes/agent.txt", change: "added" },
    ]);
    expect(structured(15).change_request.status).toBe("open");
    expect(structured(16)).toHaveLength(1);
    expect(structured(17).url).toMatch(/^file:\/\/.*\.paged$/);
  });

  it("looks up the API, and errors as the Rust CLI does", () => {
    covers("cli:paged-node mcp");
    expect(structured(6).results[0].section).toBe("hostFunctions");
    expect(reply(12).error).toEqual({
      code: -32602,
      message: "no tool no_such_tool",
    });
    const parse = replies.find((r) => r.id === null);
    expect(parse.error.code).toBe(-32700);
  });
});
