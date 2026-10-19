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

// The golden tests of `paged-node` (layer 4 of the surface conformance
// programme): for every verb of the verb table, its `--help`, a usage error
// (exit 2), an input error (a missing or malformed file) and a success on a
// fixture built in code, each recorded as a normalised transcript in
// test/golden/paged-node/<verb>.<case>.txt. `PAGED_UPDATE_GOLDEN=1` rewrites
// them. The case table is checked against VERBS before anything runs: a new
// verb without its four cases, or a golden file no case writes, fails.
//
// Runs in-process through `main()` (the exit code is main's answer, which the
// bin hands to the process); the `ai` cases that depend on the environment
// spawn src/bin.ts with an environment of their own. Exports are asserted by
// structure (ZIP entries, the PDF header and page count), never by bytes.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";

import { CORE_COMMAND_OPS } from "@paged-media/plugin-sdk";

import { VERBS } from "../src/verbs";
import { cliVersion, engineVersionOnDisk, packageRoot } from "../src/session";
import {
  expectGolden,
  goldenFiles,
  needs,
  normalise,
  pathRules,
  pdfStructure,
  transcript,
  zipEntries,
  type Rule,
  UPDATE_GOLDEN,
} from "../../plugin-sdk/test/golden-kit";
import { cli, FIXTURES, tempDir, writeFixture } from "./helpers";

// The surface-conformance marker (a no-op; the gate reads it statically).
const covers = (..._ids: string[]): void => {};

const GOLDEN = fileURLToPath(new URL("./golden/paged-node/", import.meta.url));
const CLI_ROOT = packageRoot();
const BIN_SRC = join(CLI_ROOT, "src", "bin.ts");
const NP = "--no-plugins";
const NOTES = `--plugins=${join(FIXTURES, "notes-plugin.ts")}`;
const DATA = "--plugins=@paged-media/data";
const MERGE_LANE = join(FIXTURES, "indesign-merge");

/** Whether every wasm artifact the workspace's paged.data bundle declares is
 *  built: its own engine (modules/data/scripts/build-wasm.sh) and DuckDB
 *  (modules/data/scripts/vendor-duckdb.sh). */
function dataEngineBuilt(): boolean {
  try {
    const manifestPath = createRequire(join(CLI_ROOT, "package.json")).resolve(
      "@paged-media/data/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      capabilities?: { wasm?: Array<{ path: string }> };
    };
    const wasm = manifest.capabilities?.wasm ?? [];
    return (
      wasm.length > 0 &&
      wasm.every((a) => existsSync(join(dirname(manifestPath), a.path)))
    );
  } catch {
    return false;
  }
}
const withDataEngine = needs(
  dataEngineBuilt(),
  "paged.data engine",
  "DATA_ENGINE",
  "the paged.data bundle's wasm is not built (modules/data: scripts/build-wasm.sh and scripts/vendor-duckdb.sh, or `moon run data:wasm data:duckdb`)",
);

// ------------------------------------------------------------ the fixture

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
/** A path under the temporary directory. */
const T = (name: string) => join(tmp.dir, name);
let rules: Rule[] = [];

beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
  writeFileSync(
    T("ops.json"),
    JSON.stringify([
      {
        op: "set",
        address: "swatch:Black",
        path: "value",
        value: [0, 0, 0, 70],
      },
    ]),
  );
  writeFileSync(
    T("refused-ops.json"),
    JSON.stringify([
      { op: "set", address: "swatch:Black", path: "space", value: "X" },
    ]),
  );
  writeFileSync(T("bad-op.json"), JSON.stringify([{ op: "move" }]));
  writeFileSync(T("array.json"), "[1]");
  writeFileSync(T("notes.txt"), "not a document");
  writeFileSync(
    T("script.mjs"),
    [
      "export default async (paged) => {",
      '  paged.log("swatches", await paged.query("swatch"));',
      '  return paged.value("swatch:Black", "value");',
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    T("throws.mjs"),
    [
      "export default async (paged) => {",
      '  paged.log("before the throw");',
      '  throw new Error("the script gave up");',
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(T("records.csv"), "title,ink\nFirst,10\nSecond,20\n");
  writeFileSync(
    T("bindings.json"),
    JSON.stringify({
      bindings: [
        { kind: "property", target: "story", path: "content", field: "title" },
      ],
    }),
  );
  rules = [
    ...pathRules(tmp.dir, "<TMP>"),
    ...pathRules(CLI_ROOT, "<CLI>"),
    { from: cliVersion(), to: "<CLI_VERSION>" },
    ...(engineVersionOnDisk()
      ? [{ from: engineVersionOnDisk()!, to: "<ENGINE_VERSION>" }]
      : []),
    { from: /"protocol": \d+/g, to: '"protocol": <PROTOCOL>' },
    { from: /\(protocol \d+\)/g, to: "(protocol <PROTOCOL>)" },
    { from: /"bytes": \d+/g, to: '"bytes": <N>' },
    { from: /\b\d+ bytes\b/g, to: "<N> bytes" },
    {
      from: /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?/g,
      to: "<TIME>",
    },
  ];
});
afterAll(() => tmp.done());

// ------------------------------------------------------------- the cases

interface Run {
  code: number;
  json: any;
  out: string;
  err: string;
}

interface Case {
  /** `help`, `usage…`, `input…` or `ok…`: the class is the prefix. */
  name: string;
  argv: () => string[];
  exit: number;
  /** Replaces stdout in the golden (said so in the transcript) when the
   *  whole output is too large or too volatile to pin. */
  project?: (r: Run) => string;
  /** A `# structure` section: what an export wrote, by shape. */
  structure?: (r: Run) => string;
  /** Assertions beyond the transcript (the file a write saved, …). */
  check?: (r: Run) => Promise<void> | void;
  /** Spawn src/bin.ts with this environment instead of running in-process. */
  spawnEnv?: () => Record<string, string>;
  /** A resource the case needs; it runs in its own test, skipped honestly. */
  needs?: "data-engine";
  /** Runs inside the case (an upstream to stand up, env to set). */
  around?: (run: () => Promise<Run>) => Promise<Run>;
}

/** The case classes and the exit code each must answer (ADR 324 §3: 0 ok,
 *  1 a rejected write or failed check, 2 usage or IO). Every verb has one of
 *  each REQUIRED class; `refused` is optional. */
const CLASS_EXIT = { help: 0, usage: 2, input: 2, ok: 0, refused: 1 } as const;
type CaseClass = keyof typeof CLASS_EXIT;
const REQUIRED: readonly CaseClass[] = ["help", "usage", "input", "ok"];
const classOf = (name: string): CaseClass | undefined =>
  (Object.keys(CLASS_EXIT) as CaseClass[]).find((c) => name.startsWith(c));

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const readBack = async (file: string, address: string, path: string) =>
  (await cli(["get", file, address, path, NP])).json;

/** A fake Messages API: run_script once, then a summary. The `ai` verb's
 *  success path, with no network and no credential. */
const AI_SCRIPT = [
  "const pid = JSON.parse(paged.pages())[0].selfId;",
  "paged.insertTextFrame(pid, [72, 72, 200, 300]);",
  "console.log('framed');",
].join("\n");

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}

function fakeTurn(turn: number): string {
  const start = {
    type: "message_start",
    message: {
      id: `msg_${turn}`,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
  const end = (stop: string) => [
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  if (turn === 1)
    return sse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "run_script",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ source: AI_SCRIPT }),
        },
      },
      { type: "content_block_stop", index: 0 },
      ...end("tool_use"),
    ]);
  return sse([
    start,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Added a text frame." },
    },
    { type: "content_block_stop", index: 0 },
    ...end("end_turn"),
  ]);
}

async function withFakeAnthropic(run: () => Promise<Run>): Promise<Run> {
  let turn = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(fakeTurn(++turn), {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const keys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
  ] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${server.port}`;
  delete process.env["ANTHROPIC_AUTH_TOKEN"];
  try {
    const r = await run();
    expect(turn).toBe(2);
    return r;
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    server.stop(true);
  }
}

/** The environment of a run with no Anthropic credential anywhere: no key,
 *  no token, an empty home (no `ant auth login` profile). */
function noCredentialEnv(): Record<string, string> {
  const home = T("empty-home");
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env["PATH"] ?? "",
  };
  for (const k of ["TMPDIR", "TEMP", "TMP", "SystemRoot"])
    if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

const CASES: Record<string, Case[]> = {
  // The bare binary: help, no verb, version, an unknown verb.
  root: [
    { name: "help", argv: () => ["--help"], exit: 0 },
    { name: "usage-no-verb", argv: () => [], exit: 2 },
    { name: "usage-unknown-verb", argv: () => ["nope"], exit: 2 },
    { name: "input-unknown-option", argv: () => ["get", "--bogus"], exit: 2 },
    {
      name: "ok-version",
      argv: () => ["--version"],
      exit: 0,
      check: (r) => {
        expect(r.json).toEqual({
          cli: cliVersion(),
          engine: engineVersionOnDisk(),
        });
      },
    },
  ],
  get: [
    { name: "help", argv: () => ["get", "--help"], exit: 0 },
    { name: "usage", argv: () => ["get", fx.paged], exit: 2 },
    {
      name: "input-missing-doc",
      argv: () => ["get", T("missing.paged"), "swatch:Black", "value", NP],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => ["get", fx.paged, "swatch:Black", "value", NP],
      exit: 0,
    },
    {
      name: "ok-every-property-text",
      argv: () => ["get", fx.paged, "swatch:Black", "--format", "text", NP],
      exit: 0,
    },
    {
      name: "refused",
      argv: () => ["get", fx.paged, "page:#9", "index", NP],
      exit: 1,
    },
  ],
  set: [
    { name: "help", argv: () => ["set", "--help"], exit: 0 },
    {
      name: "usage",
      argv: () => ["set", fx.paged, "swatch:Black", "value"],
      exit: 2,
    },
    {
      name: "input-not-a-document",
      argv: () => ["set", T("notes.txt"), "swatch:Black", "value", "[0,0,0,1]"],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => [
        "set",
        fx.paged,
        "rectangle:urect",
        "frameStrokeWeight",
        "2mm",
        "-o",
        T("set.paged"),
        NP,
      ],
      exit: 0,
      async check() {
        const got = await readBack(
          T("set.paged"),
          "rectangle:urect",
          "frameStrokeWeight",
        );
        expect(got.value).toBeCloseTo((2 * 72) / 25.4, 3);
      },
    },
    {
      name: "refused-value",
      argv: () => [
        "set",
        fx.paged,
        "rectangle:urect",
        "frameStrokeWeight",
        "thick",
        "--no-save",
        NP,
      ],
      exit: 1,
    },
  ],
  create: [
    { name: "help", argv: () => ["create", "--help"], exit: 0 },
    { name: "usage", argv: () => ["create", fx.paged], exit: 2 },
    {
      name: "input-props-not-an-object",
      argv: () => ["create", fx.paged, "swatch", T("array.json"), NP],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => [
        "create",
        fx.paged,
        "swatch",
        '{"name":"Brand","space":"CMYK","value":[100,0,0,0]}',
        "-o",
        T("create.paged"),
        NP,
      ],
      exit: 0,
      async check(r) {
        const [made] = r.json.created as string[];
        expect(
          (await readBack(T("create.paged"), made!, "value")).value,
        ).toEqual([100, 0, 0, 0]);
      },
    },
  ],
  delete: [
    { name: "help", argv: () => ["delete", "--help"], exit: 0 },
    { name: "usage", argv: () => ["delete", fx.paged], exit: 2 },
    {
      name: "input-missing-doc",
      argv: () => ["delete", T("missing.paged"), "rectangle:urect", NP],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => [
        "delete",
        fx.paged,
        "rectangle:urect",
        "-o",
        T("delete.paged"),
        NP,
      ],
      exit: 0,
      async check() {
        const left = await cli(["query", T("delete.paged"), "rectangle", NP]);
        expect(left.json.addresses).toEqual([]);
      },
    },
    {
      name: "refused-matches-nothing",
      argv: () => ["delete", fx.paged, "swatch[name=Nope]", "--no-save", NP],
      exit: 1,
    },
  ],
  query: [
    { name: "help", argv: () => ["query", "--help"], exit: 0 },
    { name: "usage", argv: () => ["query", fx.paged], exit: 2 },
    {
      name: "usage-not-a-selector",
      argv: () => ["query", fx.paged, "[[", NP],
      exit: 2,
    },
    {
      name: "input-missing-doc",
      argv: () => ["query", T("missing.paged"), "swatch", NP],
      exit: 2,
    },
    { name: "ok", argv: () => ["query", fx.paged, "swatch", NP], exit: 0 },
    {
      name: "ok-text",
      argv: () => [
        "query",
        fx.paged,
        "page:#1 > frame",
        "--format",
        "text",
        NP,
      ],
      exit: 0,
    },
  ],
  schema: [
    { name: "help", argv: () => ["schema", "--help"], exit: 0 },
    { name: "usage", argv: () => ["schema"], exit: 2 },
    {
      name: "input-missing-doc",
      argv: () => ["schema", T("missing.paged"), NP],
      exit: 2,
    },
    { name: "ok", argv: () => ["schema", fx.paged, "layer", NP], exit: 0 },
    {
      name: "ok-text",
      argv: () => ["schema", fx.paged, "swatch", "--format", "text", NP],
      exit: 0,
    },
    {
      name: "refused-unknown-kind",
      argv: () => ["schema", fx.paged, "nokind", NP],
      exit: 1,
    },
  ],
  batch: [
    { name: "help", argv: () => ["batch", "--help"], exit: 0 },
    { name: "usage", argv: () => ["batch", fx.paged], exit: 2 },
    {
      name: "input-missing-ops",
      argv: () => ["batch", fx.paged, T("missing.json"), NP],
      exit: 2,
    },
    {
      name: "input-bad-op",
      argv: () => ["batch", fx.paged, T("bad-op.json"), NP],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => [
        "batch",
        fx.paged,
        T("ops.json"),
        "-o",
        T("batch.paged"),
        NP,
      ],
      exit: 0,
      async check() {
        expect(
          (await readBack(T("batch.paged"), "swatch:Black", "value")).value,
        ).toEqual([0, 0, 0, 70]);
      },
    },
    {
      name: "refused",
      argv: () => ["batch", fx.paged, T("refused-ops.json"), "--no-save", NP],
      exit: 1,
    },
  ],
  commands: [
    { name: "help", argv: () => ["commands", "--help"], exit: 0 },
    { name: "usage", argv: () => ["commands", "a.paged", "b.paged"], exit: 2 },
    {
      name: "input-missing-doc",
      argv: () => ["commands", T("missing.paged"), NP],
      exit: 2,
    },
    // The CLI's own command: one row, stable. Core's (one per wire op) are
    // asserted against the generated list instead of pinned here.
    {
      name: "ok",
      argv: () => ["commands", "--owner", "paged.ai", NP],
      exit: 0,
      async check() {
        const core = await cli(["commands", "--owner", "core", NP]);
        expect(
          (core.json.commands as Array<{ id: string }>).map((c) => c.id),
        ).toEqual(CORE_COMMAND_OPS.map((op) => `core.${op}`));
      },
    },
  ],
  invoke: [
    { name: "help", argv: () => ["invoke", "--help"], exit: 0 },
    { name: "usage", argv: () => ["invoke", fx.paged], exit: 2 },
    {
      name: "input-args-not-an-object",
      argv: () => [
        "invoke",
        fx.paged,
        "core.duplicatePage",
        T("array.json"),
        NP,
      ],
      exit: 2,
    },
    {
      name: "usage-unknown-command",
      argv: () => ["invoke", fx.paged, "core.nope", "{}", NP],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => [
        "invoke",
        fx.paged,
        "core.duplicatePage",
        '{"page":"page:#1"}',
        "-o",
        T("dup.paged"),
        NP,
      ],
      exit: 0,
      async check() {
        const pages = await cli(["query", T("dup.paged"), "page", NP]);
        expect(pages.json.addresses).toHaveLength(2);
      },
    },
  ],
  run: [
    { name: "help", argv: () => ["run", "--help"], exit: 0 },
    { name: "usage", argv: () => ["run", fx.paged], exit: 2 },
    {
      name: "input-missing-script",
      argv: () => ["run", fx.paged, T("missing.mjs"), NP],
      exit: 2,
    },
    {
      name: "ok",
      argv: () => ["run", fx.paged, T("script.mjs"), NP],
      exit: 0,
    },
    {
      name: "refused-script-throws",
      argv: () => ["run", fx.paged, T("throws.mjs"), NP],
      exit: 1,
    },
  ],
  ai: [
    { name: "help", argv: () => ["ai", "--help"], exit: 0 },
    { name: "usage", argv: () => ["ai"], exit: 2 },
    {
      name: "usage-new-needs-out",
      argv: () => ["ai", "--new", "a4", "a flyer", NP],
      exit: 2,
    },
    {
      name: "usage-new-size",
      argv: () => ["ai", "--new", "huge", "a flyer", "--no-save", NP],
      exit: 2,
    },
    {
      name: "usage-empty-brief",
      argv: () => ["ai", fx.paged, "  ", "--no-save", NP],
      exit: 2,
    },
    {
      name: "usage-max-turns",
      argv: () => [
        "ai",
        fx.paged,
        "a flyer",
        "--max-turns",
        "many",
        "--no-save",
        NP,
      ],
      exit: 2,
    },
    {
      name: "input-missing-doc",
      argv: () => ["ai", T("missing.paged"), "a flyer", NP],
      exit: 2,
    },
    {
      name: "input-no-credential",
      argv: () => ["ai", fx.paged, "a flyer", "--no-save", NP],
      exit: 2,
      spawnEnv: noCredentialEnv,
    },
    {
      name: "ok",
      argv: () => ["ai", fx.paged, "add a text frame", "-o", T("ai.paged"), NP],
      exit: 0,
      around: withFakeAnthropic,
      async check(r) {
        expect(r.json.outcome).toBe("done");
        const frames = await cli(["query", T("ai.paged"), "textFrame", NP]);
        expect(frames.json.addresses).toHaveLength(2);
      },
    },
  ],
  export: [
    { name: "help", argv: () => ["export", "--help"], exit: 0 },
    { name: "usage", argv: () => ["export"], exit: 2 },
    { name: "usage-no-out", argv: () => ["export", fx.paged, NP], exit: 2 },
    {
      name: "input-not-a-document",
      argv: () => ["export", T("notes.txt"), "-o", T("x.pdf"), NP],
      exit: 2,
    },
    {
      name: "input-unknown-format",
      argv: () => ["export", fx.paged, "-o", T("x.docx"), NP],
      exit: 2,
    },
    {
      name: "ok-pdf",
      argv: () => ["export", fx.paged, "-o", T("out.pdf"), NP],
      exit: 0,
      structure: () => json(pdfStructure(readFileSync(T("out.pdf")))),
    },
    {
      name: "ok-idml",
      argv: () => ["export", fx.paged, "-o", T("out.idml"), NP],
      exit: 0,
      structure: () => zipEntries(readFileSync(T("out.idml"))).join("\n"),
    },
    {
      name: "ok-paged",
      argv: () => ["export", fx.idml, "-o", T("out.paged"), NP],
      exit: 0,
      structure: () => zipEntries(readFileSync(T("out.paged"))).join("\n"),
    },
  ],
  apply: [
    { name: "help", argv: () => ["apply", "--help"], exit: 0 },
    { name: "usage", argv: () => ["apply"], exit: 2 },
    { name: "usage-no-data", argv: () => ["apply", fx.paged, NP], exit: 2 },
    {
      name: "input-missing-bindings",
      argv: () => [
        "apply",
        fx.paged,
        "--data",
        T("records.csv"),
        "--bindings",
        T("missing.json"),
        NP,
      ],
      exit: 2,
    },
    {
      name: "input-no-data-bundle",
      argv: () => [
        "apply",
        fx.paged,
        "--data",
        T("records.csv"),
        "--bindings",
        T("bindings.json"),
        NP,
      ],
      exit: 2,
    },
    {
      name: "ok",
      needs: "data-engine",
      argv: () => [
        "apply",
        fx.paged,
        "--data",
        T("records.csv"),
        "--bindings",
        T("bindings.json"),
        "--record",
        "1",
        "-o",
        T("applied.paged"),
        DATA,
      ],
      exit: 0,
      async check() {
        const got = await cli([
          "get",
          T("applied.paged"),
          "story",
          "content",
          NP,
        ]);
        expect(got.json.results[0].value).toBe("Second");
      },
    },
  ],
  merge: [
    { name: "help", argv: () => ["merge", "--help"], exit: 0 },
    { name: "usage", argv: () => ["merge"], exit: 2 },
    { name: "usage-no-data", argv: () => ["merge", fx.paged, NP], exit: 2 },
    {
      name: "usage-format",
      argv: () => [
        "merge",
        fx.paged,
        "--data",
        T("records.csv"),
        "--out",
        T("merged"),
        "--format",
        "docx",
        NP,
      ],
      exit: 2,
    },
    {
      name: "input-missing-template",
      argv: () => [
        "merge",
        T("missing.idml"),
        "--data",
        T("records.csv"),
        "--out",
        T("merged"),
        NP,
      ],
      exit: 2,
    },
    {
      name: "ok",
      needs: "data-engine",
      argv: () => [
        "merge",
        join(MERGE_LANE, "long-record-set.idml"),
        "--data",
        join(MERGE_LANE, "long-record-set.csv"),
        "--out",
        T("merged"),
        "--format",
        "idml",
        "--records-per-page",
        "multiple",
        "--arrange",
        "columns",
        "--row-spacing",
        "6",
        "--column-spacing",
        "12",
        DATA,
      ],
      exit: 0,
      structure: () =>
        zipEntries(readFileSync(T("merged/long-record-set-merged.idml")))
          .filter((n) => n.startsWith("Spreads/") || n === "designmap.xml")
          .join("\n"),
    },
  ],
  plugins: [
    { name: "help", argv: () => ["plugins", "--help"], exit: 0 },
    { name: "usage", argv: () => ["plugins", "a.paged", "b.paged"], exit: 2 },
    {
      name: "input-missing-doc",
      argv: () => ["plugins", T("missing.paged"), NP],
      exit: 2,
    },
    {
      name: "input-plugin-not-installed",
      argv: () => ["plugins", "--plugins=@paged-media/not-installed"],
      exit: 2,
    },
    { name: "ok", argv: () => ["plugins", NP], exit: 0 },
    {
      name: "ok-with-a-bundle",
      argv: () => ["plugins", NOTES, "--format", "text"],
      exit: 0,
    },
  ],
  describe: [
    { name: "help", argv: () => ["describe", "--help"], exit: 0 },
    { name: "usage", argv: () => ["describe", "a.paged", "b.paged"], exit: 2 },
    {
      name: "input-missing-doc",
      argv: () => ["describe", T("missing.paged"), NP],
      exit: 2,
    },
    // The whole document is every kind's schema; the golden pins its
    // outline (kinds, command count, verbs) and the check its contents.
    {
      name: "ok",
      argv: () => ["describe", NP],
      exit: 0,
      project: (r) =>
        json({
          engine: r.json.engine,
          protocol: r.json.protocol,
          plugins: r.json.plugins,
          kinds: (r.json.kinds as Array<{ kind: string }>).map((k) => k.kind),
          verbs: (r.json.verbs as Array<{ name: string; usage: string }>).map(
            (v) => `${v.name} ${v.usage}`,
          ),
        }),
      check: (r) => {
        expect(r.json.commands.length).toBeGreaterThan(CORE_COMMAND_OPS.length);
        for (const k of r.json.kinds as Array<{ schema: unknown[] }>)
          expect(Array.isArray(k.schema)).toBe(true);
        expect(
          (r.json.verbs as Array<{ name: string }>).map((v) => v.name),
        ).toEqual(VERBS.map((v) => v.name));
      },
    },
  ],
};

// --------------------------------------------------------------- running

const goldenName = (verb: string, c: Case) => `${verb}.${c.name}.txt`;

async function execute(c: Case): Promise<Run> {
  const argv = c.argv();
  if (c.spawnEnv) {
    const p = spawnSync(process.execPath, [BIN_SRC, ...argv], {
      encoding: "utf8",
      cwd: CLI_ROOT,
      env: c.spawnEnv(),
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(p.stdout);
    } catch {
      /* text */
    }
    // The bin writes the engine's console to stderr; only the verb's own
    // output is the contract.
    return { code: p.status ?? -1, json: parsed, out: p.stdout, err: "" };
  }
  return cli(argv);
}

/** The case's structure section; a file the run did not write says so. */
function structureOf(c: Case, r: Run): string {
  try {
    return c.structure!(r);
  } catch (err) {
    return `(unreadable: ${(err as Error).message})`;
  }
}

async function runCase(verb: string, c: Case): Promise<void> {
  const argv = c.argv();
  const r = await (c.around ? c.around(() => execute(c)) : execute(c));
  const shown = c.project ? c.project(r) : r.out;
  const text = normalise(
    transcript({
      argv: ["paged-node", ...argv],
      code: r.code,
      out: c.project ? `(projected)\n${shown}` : shown,
      err: r.err,
      ...(c.structure ? { extra: structureOf(c, r) } : {}),
    }),
    rules,
  );
  expectGolden(join(GOLDEN, goldenName(verb, c)), text);
  expect(r.code, `${verb} ${c.name}: ${r.out}${r.err}`).toBe(c.exit);
  await c.check?.(r);
}

async function runVerb(verb: string): Promise<void> {
  for (const c of CASES[verb]!) if (!c.needs) await runCase(verb, c);
}

const theCase = (verb: string, name: string): Case =>
  CASES[verb]!.find((c) => c.name === name)!;

// ------------------------------------------------------------ the tests

describe("paged-node — the case table is the verb table", () => {
  it("every verb has a help, a usage error, an input error and a success", () => {
    covers("cli:paged-node");
    expect(VERBS.map((v) => v.name)).not.toContain("root");
    expect(Object.keys(CASES).sort()).toEqual(
      ["root", ...VERBS.map((v) => v.name)].sort(),
    );
    for (const [verb, cases] of Object.entries(CASES)) {
      for (const cls of REQUIRED)
        expect(
          cases.some((c) => classOf(c.name) === cls),
          `${verb} has no ${cls} case`,
        ).toBe(true);
      for (const c of cases) {
        const cls = classOf(c.name);
        expect(cls, `${verb}.${c.name} names no class`).toBeDefined();
        expect(
          c.exit,
          `${verb}.${c.name}: a ${cls} case exits ${CLASS_EXIT[cls!]}`,
        ).toBe(CLASS_EXIT[cls!]);
      }
      expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    }
  });
});

describe("paged-node golden transcripts", () => {
  it("the bare binary: help, no verb, an unknown verb or option, --version", async () => {
    covers("cli:paged-node");
    await runVerb("root");
  });
  it("get", async () => {
    covers("cli:paged-node get");
    await runVerb("get");
  });
  it("set", async () => {
    covers("cli:paged-node set");
    await runVerb("set");
  });
  it("create", async () => {
    covers("cli:paged-node create");
    await runVerb("create");
  });
  it("delete", async () => {
    covers("cli:paged-node delete");
    await runVerb("delete");
  });
  it("query", async () => {
    covers("cli:paged-node query");
    await runVerb("query");
  });
  it("schema", async () => {
    covers("cli:paged-node schema");
    await runVerb("schema");
  });
  it("batch", async () => {
    covers("cli:paged-node batch");
    await runVerb("batch");
  });
  it("commands", async () => {
    covers("cli:paged-node commands");
    await runVerb("commands");
  });
  it("invoke", async () => {
    covers("cli:paged-node invoke");
    await runVerb("invoke");
  });
  it("run", async () => {
    covers("cli:paged-node run");
    await runVerb("run");
  });
  it("ai (the model is a local fake; no network, no credential)", async () => {
    covers("cli:paged-node ai");
    await runVerb("ai");
  });
  it("export (structure: ZIP entries, the PDF header and page count)", async () => {
    covers("cli:paged-node export");
    await runVerb("export");
  });
  it("apply: argument and input errors", async () => {
    covers("cli:paged-node apply");
    await runVerb("apply");
  });
  withDataEngine("apply: one record's fields into the document", async () => {
    covers("cli:paged-node apply");
    await runCase("apply", theCase("apply", "ok"));
  });
  it("merge: argument and input errors", async () => {
    covers("cli:paged-node merge");
    await runVerb("merge");
  });
  withDataEngine("merge: 57 records into one document", async () => {
    covers("cli:paged-node merge");
    await runCase("merge", theCase("merge", "ok"));
  });
  it("plugins", async () => {
    covers("cli:paged-node plugins");
    await runVerb("plugins");
  });
  it("describe", async () => {
    covers("cli:paged-node describe");
    await runVerb("describe");
  });
});

// Findings: the goldens pin today's output; these say what it should be.
// Each fails for its reason until the product is fixed (then it is flipped
// to a plain test, and its golden is updated).
describe("paged-node findings", () => {
  test.failing(
    "NCLI-1: export --help names --option repeatable once, not twice",
    async () => {
      covers("cli:paged-node export");
      const r = await cli(["export", "--help"]);
      const line = r.out.split("\n").find((l) => l.includes("--option"))!;
      expect(line.match(/\(repeatable\)/g)).toHaveLength(1);
    },
  );

  test.failing(
    "NCLI-2: schema --format text names an open record's shape, as commands does",
    async () => {
      covers("cli:paged-node schema");
      const r = await cli([
        "schema",
        fx.paged,
        "swatch",
        "--format",
        "text",
        NP,
      ]);
      const line = r.out.split("\n").find((l) => l.startsWith("color "))!;
      expect(line).toMatch(/SwatchColorSpec \(JSON, checked by core\)/);
    },
  );
});

// Last, so an update run has written every golden before it is checked.
describe("paged-node golden files", () => {
  it("every golden file is a case's, and every case has its golden", () => {
    covers("cli:paged-node");
    const expected = Object.entries(CASES)
      .flatMap(([verb, cases]) => cases.map((c) => goldenName(verb, c)))
      .sort();
    if (UPDATE_GOLDEN)
      for (const stale of goldenFiles(GOLDEN))
        if (!expected.includes(stale)) rmSync(join(GOLDEN, stale));
    expect(goldenFiles(GOLDEN)).toEqual(expected);
  });
});
