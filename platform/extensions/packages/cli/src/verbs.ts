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

// THE VERB TABLE. `--help`, argument checking and the cli_surface spec are
// all generated from it: a verb exists iff it has a row here.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ObjectOp, ObjectWriteResult } from "@paged-media/plugin-api";
import { normalizeAddress, parseSelector } from "@paged-media/plugin-sdk";

import { flagBool, flagList, flagNumber, flagStr, type OptionSpec, type ParsedArgs } from "./args";
import { applyBindings, dataSession, loadRecords, mergeOnce, readBindings, selectRecord, type MergeFlags } from "./data";
import { CliError, EXIT } from "./errors";
import { baseName, openSession, writeOutput, type CliSession, type SessionOptions } from "./session";
import { describeType, parseCliValue } from "./values";

export interface VerbContext {
  args: ParsedArgs;
  cwd: string;
  session(doc: string | null): Promise<CliSession>;
}

export interface VerbResult {
  /** The JSON printed on stdout. */
  json: unknown;
  /** The `--format text` rendering (default: indented JSON). */
  text?: string;
  /** Exit code (default 0). */
  exit?: number;
}

export interface Verb {
  name: string;
  /** Positionals, `<required>` / `[optional]`. */
  usage: string;
  summary: string;
  min: number;
  max: number;
  options: readonly OptionSpec[];
  /** `host.objects` members this verb reaches (cli_surface spec). */
  reaches: readonly string[];
  run(ctx: VerbContext): Promise<VerbResult>;
}

// ------------------------------------------------------------- options

const OUT: OptionSpec = { name: "out", short: "o", value: "file", help: "write the result here (format from the extension: .paged, .idml, .pdf)" };
const NO_SAVE: OptionSpec = { name: "no-save", help: "apply the change but write nothing (a dry run)" };
const JSON_VALUE: OptionSpec = { name: "json", help: "parse <value> as JSON instead of through the path's schema" };
const LABEL: OptionSpec = { name: "label", value: "text", help: "undo label for the write" };

/** Options every verb accepts (session + output). */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: "plugins", value: "a,b", help: "load exactly these bundles (package names or paths) instead of discovering them" },
  { name: "no-plugins", help: "load no plugin bundles (core objects only)" },
  { name: "font", value: "file.ttf", help: "default font every load lays text out with" },
  { name: "engine-from", value: "dir", help: "resolve @paged-media/canvas-wasm from this directory" },
  { name: "text", help: "human-readable output instead of JSON" },
  { name: "help", short: "h", help: "show help" },
];
/** `--format text|json` — on every verb whose `--format` is not a file format. */
const OUTPUT_FORMAT: OptionSpec = { name: "format", value: "json|text", help: "output style (default json)" };

const MERGE_OPTIONS: readonly OptionSpec[] = [
  { name: "data", value: "x.csv", help: "the records (CSV/TSV/JSON/Parquet/XLSX through paged.data)" },
  { name: "query", value: "sql", help: 'select the records (default SELECT * FROM "data")' },
];

// --------------------------------------------------------------- helpers

/** Values for JSON: Uint8Array → { bytes: n } (never dump binary). */
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return { bytes: v.byteLength };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** An address, or every address a selector matches (in order). */
async function targets(s: CliSession, addrOrSelector: string): Promise<string[]> {
  if (normalizeAddress(addrOrSelector)) return [addrOrSelector];
  if (!parseSelector(addrOrSelector)) throw new CliError(EXIT.usage, `"${addrOrSelector}" is neither an address nor a selector`);
  return s.h.objects.query(addrOrSelector);
}

const writeExit = (r: ObjectWriteResult): number => (r.applied ? EXIT.ok : EXIT.failed);

async function saveIfAsked(s: CliSession, a: ParsedArgs, applied: boolean): Promise<unknown> {
  if (!applied || flagBool(a, "no-save")) return null;
  return s.save(flagStr(a, "out"));
}

const kv = (rows: Array<[string, unknown]>): string =>
  rows.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(plain(v))}`).join("\n");

// ----------------------------------------------------------------- verbs

const get: Verb = {
  name: "get",
  usage: "<doc> <address|selector> [path]",
  summary: "read one property, or every property of an object (all matches of a selector)",
  min: 2,
  max: 3,
  options: [OUTPUT_FORMAT],
  reaches: ["get", "getAll", "query"],
  async run({ args, session }) {
    const [doc, target, path] = args.positionals as [string, string, string | undefined];
    const s = await session(doc);
    const list = await targets(s, target);
    const results: Array<Record<string, unknown>> = [];
    let refused = false;
    for (const address of list) {
      if (path !== undefined) {
        const v = await s.h.objects.get(address, path);
        if (v.kind === "refused") refused = true;
        results.push({ address, path, ...(v.kind === "value" ? { value: plain(v.value) } : { result: v }) });
      } else {
        const all = await s.h.objects.getAll(address);
        const values: Record<string, unknown> = {};
        const unavailable: Record<string, unknown> = {};
        for (const [p, v] of Object.entries(all)) {
          if (v.kind === "value") values[p] = plain(v.value);
          else unavailable[p] = v.kind === "refused" ? `${v.code}: ${v.reason}` : v.kind;
        }
        if (Object.keys(values).length === 0 && Object.keys(all).length === 0) {
          refused = true;
          results.push({ address, result: { kind: "refused", code: "unknownAddress", reason: "no schema rows for this address" } });
        } else results.push({ address, values, ...(Object.keys(unavailable).length ? { unavailable } : {}) });
      }
    }
    if (list.length === 0) refused = true;
    const single = normalizeAddress(target) !== null;
    return {
      json: single ? results[0] : { selector: target, results },
      text: results
        .map((r) =>
          "value" in r ? `${r["address"]} ${r["path"]} = ${JSON.stringify(r["value"])}` : "values" in r ? `${r["address"]}\n${kv(Object.entries(r["values"] as object)).replace(/^/gm, "  ")}` : `${r["address"]}: ${JSON.stringify(r["result"])}`,
        )
        .join("\n"),
      exit: refused ? EXIT.failed : EXIT.ok,
    };
  },
};

const set: Verb = {
  name: "set",
  usage: "<doc> <address|selector> <path> <value>",
  summary: "set one property (value parsed through the path's schema); a selector sets every match in ONE undo step; saves in place unless -o / --no-save",
  min: 4,
  max: 4,
  options: [OUT, NO_SAVE, JSON_VALUE, LABEL, OUTPUT_FORMAT],
  reaches: ["set", "batch", "schema", "query"],
  async run({ args, session }) {
    const [doc, target, path, raw] = args.positionals as [string, string, string, string];
    const s = await session(doc);
    const list = await targets(s, target);
    if (list.length === 0) throw new CliError(EXIT.failed, `"${target}" matches nothing`);
    const ops: ObjectOp[] = [];
    for (const address of list) {
      const parsed = parseCliValue(await s.h.objects.schema(address), address, path, raw, flagBool(args, "json"));
      if (!parsed.ok) throw new CliError(EXIT.failed, parsed.reason);
      ops.push({ op: "set", address, path, value: parsed.value });
    }
    const label = flagStr(args, "label");
    const result = await s.h.objects.batch(ops, label ? { label } : undefined);
    const saved = await saveIfAsked(s, args, result.applied);
    return {
      json: { targets: list, path, value: plain(ops[0] && (ops[0] as { value: unknown }).value), result: plain(result), saved },
      text: result.applied
        ? `set ${path} on ${list.length} object(s) (${result.undoSteps} undo step)${saved ? `; saved ${(saved as { path: string }).path}` : ""}`
        : `refused: ${result.code}: ${result.reason}`,
      exit: writeExit(result),
    };
  },
};

const query: Verb = {
  name: "query",
  usage: "<doc> <selector>",
  summary: 'list the addresses a selector matches (kind, [name=…], [label.<key>=…], "page:#1 > frame", plugin kinds)',
  min: 2,
  max: 2,
  options: [{ name: "limit", value: "n", help: "at most n results" }, OUTPUT_FORMAT],
  reaches: ["query"],
  async run({ args, session }) {
    const [doc, selector] = args.positionals as [string, string];
    if (!parseSelector(selector)) throw new CliError(EXIT.usage, `"${selector}" is not a selector`);
    const s = await session(doc);
    const limit = flagStr(args, "limit");
    const addresses = await s.h.objects.query(selector, limit !== undefined ? { limit: flagNumber(args, "limit", 0) } : undefined);
    return { json: { selector, addresses }, text: addresses.join("\n") };
  },
};

const schema: Verb = {
  name: "schema",
  usage: "<doc> [kind|address]",
  summary: "the property schema of a kind or an object; without one: every kind and typed command",
  min: 1,
  max: 2,
  options: [OUTPUT_FORMAT],
  reaches: ["schema", "kinds", "commands"],
  async run({ args, session }) {
    const [doc, what] = args.positionals as [string, string | undefined];
    const s = await session(doc);
    if (what === undefined) {
      const kinds = await s.h.objects.kinds();
      const commands = await s.h.objects.commands();
      return {
        json: { kinds, commands },
        text: [...kinds.map((k) => `${k.kind.padEnd(28)} ${k.owner.padEnd(18)} ${k.addressForm}`), ...commands.map((c) => `command ${c.id} (${c.owner})`)].join("\n"),
      };
    }
    const rows = await s.h.objects.schema(what);
    if (rows.length === 0) throw new CliError(EXIT.failed, `no kind or object "${what}" (see \`paged schema <doc>\`)`);
    return {
      json: { of: what, rows },
      text: rows.map((r) => `${r.path.padEnd(32)} ${describeType(r.type)}${r.access && r.access !== "readWrite" ? ` [${r.access}]` : ""}`).join("\n"),
    };
  },
};

const batch: Verb = {
  name: "batch",
  usage: "<doc> <ops.json>",
  summary: "apply a list of ObjectOps ({op:set|create|delete, …}) as ONE undo step, then save",
  min: 2,
  max: 2,
  options: [OUT, NO_SAVE, LABEL, OUTPUT_FORMAT],
  reaches: ["batch"],
  async run({ args, session, cwd }) {
    const [doc, opsPath] = args.positionals as [string, string];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolve(cwd, opsPath), "utf8"));
    } catch (err) {
      throw new CliError(EXIT.usage, `cannot read ${opsPath}: ${(err as Error).message}`);
    }
    const file = (Array.isArray(parsed) ? { ops: parsed } : parsed) as { ops?: unknown; label?: string };
    if (!Array.isArray(file.ops)) throw new CliError(EXIT.usage, `${opsPath}: expected an array of ops or { "ops": [ … ] }`);
    for (const [i, op] of (file.ops as unknown[]).entries()) {
      const o = op as { op?: unknown };
      if (typeof o !== "object" || o === null || !["set", "create", "delete", "invoke"].includes(String(o.op))) {
        throw new CliError(EXIT.usage, `${opsPath}: ops[${i}].op must be set | create | delete | invoke`);
      }
    }
    const s = await session(doc);
    const label = flagStr(args, "label") ?? file.label;
    const result = await s.h.objects.batch(file.ops as ObjectOp[], label ? { label } : undefined);
    const saved = await saveIfAsked(s, args, result.applied);
    return {
      json: { ops: (file.ops as unknown[]).length, result: plain(result), saved },
      text: result.applied
        ? `applied ${(file.ops as unknown[]).length} op(s) in ${result.undoSteps} undo step${saved ? `; saved ${(saved as { path: string }).path}` : ""}`
        : `refused${result.index !== undefined ? ` at ops[${result.index}]` : ""}: ${result.code}: ${result.reason}`,
      exit: writeExit(result),
    };
  },
};

const run: Verb = {
  name: "run",
  usage: "<doc> <script.js> [-- args…]",
  summary: "run a JS module with `paged` = host.objects + typed commands (global, and the default export's argument); saves when it wrote",
  min: 2,
  max: 2,
  options: [OUT, NO_SAVE, OUTPUT_FORMAT],
  reaches: ["query", "get", "getAll", "set", "batch", "schema", "kinds", "commands", "invoke", "onDidChange"],
  async run({ args, session, cwd }) {
    const [doc, script] = args.positionals as [string, string];
    const file = resolve(cwd, script);
    if (!existsSync(file)) throw new CliError(EXIT.usage, `no script ${script}`);
    const s = await session(doc);
    const o = s.h.objects;
    let writes = 0;
    const logs: string[] = [];
    const track = (r: ObjectWriteResult): ObjectWriteResult => {
      if (r.applied && r.undoSteps > 0) writes++;
      return r;
    };
    const paged = {
      query: o.query.bind(o),
      get: o.get.bind(o),
      getAll: o.getAll.bind(o),
      /** The plain value of (address, path); throws when it is not a value. */
      async value(address: string, path: string): Promise<unknown> {
        const v = await o.get(address, path);
        if (v.kind !== "value") throw new Error(`${address} ${path}: ${v.kind === "refused" ? `${v.code}: ${v.reason}` : v.kind}`);
        return v.value;
      },
      set: async (address: string, path: string, value: unknown, opts?: { label?: string }) => track(await o.set(address, path, value, opts)),
      batch: async (ops: readonly ObjectOp[], opts?: { label?: string }) => track(await o.batch(ops, opts)),
      schema: o.schema.bind(o),
      kinds: o.kinds.bind(o),
      commands: o.commands.bind(o),
      invoke: async (command: string, cmdArgs: unknown) => {
        writes++; // a command may write; save to be safe
        return o.invoke(command, cmdArgs);
      },
      onDidChange: o.onDidChange.bind(o),
      undo: () => s.driver.document.undo(),
      redo: () => s.driver.document.redo(),
      async export(format: string, out: string) {
        const done = await s.exportBytes(format);
        writeOutput(resolve(cwd, out), done.bytes);
        return { path: resolve(cwd, out), bytes: done.bytes.byteLength };
      },
      save: (out?: string) => s.save(out),
      plugins: s.plugins.map((p) => p.id),
      args: args.rest,
      log: (...parts: unknown[]) => void logs.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(plain(p)))).join(" ")),
    };
    const g = globalThis as { paged?: unknown };
    const prev = g.paged;
    g.paged = paged;
    let result: unknown;
    try {
      const mod = (await import(`${pathToFileURL(file).href}?run=${Date.now()}`)) as { default?: unknown };
      if (typeof mod.default === "function") result = await (mod.default as (p: typeof paged) => unknown)(paged);
    } catch (err) {
      throw new CliError(EXIT.failed, `${script}: ${err instanceof Error ? err.message : String(err)}`, { logs });
    } finally {
      g.paged = prev;
    }
    const saved = await saveIfAsked(s, args, writes > 0 || flagStr(args, "out") !== undefined);
    return { json: { result: plain(result) ?? null, logs, writes, saved }, text: [...logs, ...(result !== undefined ? [JSON.stringify(plain(result))] : [])].join("\n") };
  },
};

const exportVerb: Verb = {
  name: "export",
  usage: "<doc>",
  summary: "export through core (pdf, idml, paged) or a plugin exporter (its id or extension)",
  min: 1,
  max: 1,
  options: [
    { name: "format", value: "pdf|idml|paged|<exporter>", help: "the output format (default: from -o's extension)" },
    { ...OUT, help: "the output file (required)" },
    { name: "pdf-standard", value: "pdf17|pdfx4", help: "PDF standard (default pdf17)" },
    { name: "pages", value: "a-b", help: "PDF page range (1-based, inclusive)" },
  ],
  reaches: [],
  async run({ args, session, cwd }) {
    const [doc] = args.positionals as [string];
    const out = flagStr(args, "out");
    if (!out) throw new CliError(EXIT.usage, "export needs -o <file>");
    const format = flagStr(args, "format") ?? out.split(".").pop()!;
    const pdf: Record<string, unknown> = {};
    const std = flagStr(args, "pdf-standard");
    if (std) pdf["standard"] = std;
    const pages = flagStr(args, "pages");
    if (pages) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(pages);
      if (!m) throw new CliError(EXIT.usage, `--pages: "${pages}" is not a-b`);
      pdf["pageFrom"] = Number(m[1]);
      pdf["pageTo"] = Number(m[2] ?? m[1]);
    }
    const s = await session(doc);
    const done = await s.exportBytes(format, { pdf });
    const path = resolve(cwd, out);
    writeOutput(path, done.bytes);
    return {
      json: { path, format: done.format, bytes: done.bytes.byteLength, diagnostics: done.diagnostics, ...(done.lost ? { lost: done.lost } : {}) },
      text: `wrote ${path} (${done.format}, ${done.bytes.byteLength} bytes)`,
    };
  },
};

const apply: Verb = {
  name: "apply",
  usage: "<doc>",
  summary: "apply data bindings (bindings.json) for one record of --data, then save",
  min: 1,
  max: 1,
  options: [
    ...MERGE_OPTIONS,
    { name: "bindings", value: "b.json", help: '{ "bindings": [ { "kind": "property", "target", "path", "field" } | session kinds: variable, image, visibility, barcode, table, rule ] }' },
    { name: "record", value: "n", help: "the record to apply (0-based, default 0)" },
    OUT,
    NO_SAVE,
    OUTPUT_FORMAT,
  ],
  reaches: ["batch", "query", "schema"],
  async run({ args, session, cwd }) {
    const [doc] = args.positionals as [string];
    const data = flagStr(args, "data");
    const bindingsPath = flagStr(args, "bindings");
    if (!data || !bindingsPath) throw new CliError(EXIT.usage, "apply needs --data <file> and --bindings <b.json>");
    const file = readBindings(resolve(cwd, bindingsPath));
    const s = await session(doc);
    const ds = await dataSession(s);
    const { query: sql, total } = await loadRecords(ds, resolve(cwd, data), flagStr(args, "query") ?? file.query);
    const record = flagNumber(args, "record", file.record ?? 0);
    const report = await applyBindings(s, ds, file, sql, record);
    const saved = await saveIfAsked(s, args, true);
    return { json: { records: total, ...report, saved }, text: `applied record ${record} of ${total ?? "?"}${saved ? `; saved ${(saved as { path: string }).path}` : ""}` };
  },
};

const merge: Verb = {
  name: "merge",
  usage: "<template>",
  summary: "Data Merge: template + records → merged document(s) in --out, as pdf | idml | paged",
  min: 1,
  max: 1,
  options: [
    ...MERGE_OPTIONS,
    { name: "out", value: "dir", help: "output directory (required)" },
    { name: "format", value: "pdf|idml|paged", help: "output format (default paged)" },
    { name: "per-record", help: "one document per record instead of one merged document" },
    { name: "records-per-page", value: "single|multiple", help: "Data Merge layout (default single)" },
    { name: "arrange", value: "rows|columns", help: "multiple records: fill rows or columns first (default rows)" },
    { name: "row-spacing", value: "pt", help: "multiple records: spacing between rows" },
    { name: "column-spacing", value: "pt", help: "multiple records: spacing between columns" },
    { name: "remove-blank-lines", help: "drop lines whose only content is an empty field" },
    { name: "image-base", value: "dir", help: "where relative image fields resolve (default: the data file's directory)" },
    { name: "image-field", value: "rectId=@field", repeat: true, help: "an image placeholder rectangle and its field" },
  ],
  reaches: [],
  async run({ args, session, cwd }) {
    const [template] = args.positionals as [string];
    const data = flagStr(args, "data");
    const outDir = flagStr(args, "out");
    if (!data || !outDir) throw new CliError(EXIT.usage, "merge needs --data <file> and --out <dir>");
    const format = (flagStr(args, "format") ?? "paged").toLowerCase();
    if (!["pdf", "idml", "paged"].includes(format)) throw new CliError(EXIT.usage, `--format: "${format}" is not pdf | idml | paged`);
    const rpp = flagStr(args, "records-per-page") ?? "single";
    const arrange = flagStr(args, "arrange") ?? "rows";
    if (rpp !== "single" && rpp !== "multiple") throw new CliError(EXIT.usage, `--records-per-page: "${rpp}" is not single | multiple`);
    if (arrange !== "rows" && arrange !== "columns") throw new CliError(EXIT.usage, `--arrange: "${arrange}" is not rows | columns`);
    const imageFields: Record<string, string> = {};
    for (const f of flagList(args, "image-field")) {
      const m = /^([^=]+)=(.+)$/.exec(f);
      if (!m) throw new CliError(EXIT.usage, `--image-field: "${f}" is not rectId=@field`);
      imageFields[m[1]!] = m[2]!;
    }
    const dataPath = resolve(cwd, data);
    const flags: MergeFlags = {
      recordsPerPage: rpp,
      arrange,
      rowSpacing: flagNumber(args, "row-spacing", 0),
      columnSpacing: flagNumber(args, "column-spacing", 0),
      removeBlankLines: flagBool(args, "remove-blank-lines"),
      imageBase: resolve(cwd, flagStr(args, "image-base") ?? dirname(dataPath)),
      ...(Object.keys(imageFields).length ? { imageFields } : {}),
    };
    const s = await session(template);
    const ds = await dataSession(s);
    const { query: sql, total } = await loadRecords(ds, dataPath, flagStr(args, "query"));
    const dir = resolve(cwd, outDir);
    const stem = baseName(template);
    const outputs: Array<Record<string, unknown>> = [];
    if (!flagBool(args, "per-record")) {
      const r = await mergeOnce(ds, flags);
      const done = await s.exportBytes(format);
      const path = join(dir, `${stem}-merged.${format}`);
      writeOutput(path, done.bytes);
      outputs.push({ path, pages: r.pages.length, records: r.records.length, overset: r.overset, bytes: done.bytes.byteLength });
    } else {
      const n = total ?? 0;
      const width = String(Math.max(n, 1)).length;
      for (let i = 0; i < n; i++) {
        const q = await selectRecord(ds, sql, i);
        const r = await mergeOnce(ds, flags, q);
        const done = await s.exportBytes(format);
        const path = join(dir, `${stem}-${String(i + 1).padStart(width, "0")}.${format}`);
        writeOutput(path, done.bytes);
        outputs.push({ path, record: i, pages: r.pages.length, overset: r.overset, bytes: done.bytes.byteLength });
        // Back to the template for the next record (the merge's own undo steps).
        for (let u = 0; u < r.mutateCalls; u++) await s.driver.document.undo();
      }
    }
    return {
      json: { records: total, format, outputs },
      text: outputs.map((o) => `${o["path"]} (${o["pages"]} page(s))`).join("\n"),
    };
  },
};

const plugins: Verb = {
  name: "plugins",
  usage: "[doc]",
  summary: "the discovered bundles, their versions and object kinds",
  min: 0,
  max: 1,
  options: [OUTPUT_FORMAT],
  reaches: ["kinds"],
  async run({ args, session }) {
    const s = await session(args.positionals[0] ?? null);
    const kinds = await s.h.objects.kinds();
    const list = s.plugins.map((p) => ({
      id: p.id,
      source: p.source,
      version: p.version,
      kinds: kinds.filter((k) => k.owner === p.id).map((k) => k.kind),
    }));
    return {
      json: { engine: s.engineVersion, protocol: s.protocol, plugins: list, problems: s.pluginProblems },
      text: [
        `engine @paged-media/canvas-wasm@${s.engineVersion} (protocol ${s.protocol})`,
        ...list.map((p) => `${p.id} ${p.version ?? ""} (${p.source})${p.kinds.length ? ` kinds: ${p.kinds.join(", ")}` : ""}`),
        ...s.pluginProblems.map((p) => `! ${p.source}: ${p.error}`),
      ].join("\n"),
    };
  },
};

const describe: Verb = {
  name: "describe",
  usage: "[doc]",
  summary: "kinds × schemas × typed commands × verbs, as one JSON document (for agents and the docs)",
  min: 0,
  max: 1,
  options: [],
  reaches: ["kinds", "schema", "commands"],
  async run({ args, session }) {
    const s = await session(args.positionals[0] ?? null);
    const kinds = await s.h.objects.kinds();
    const out = [];
    for (const k of kinds) out.push({ ...k, schema: await s.h.objects.schema(k.kind) });
    return {
      json: {
        engine: s.engineVersion,
        protocol: s.protocol,
        plugins: s.plugins.map((p) => ({ id: p.id, version: p.version })),
        kinds: out,
        commands: await s.h.objects.commands(),
        verbs: VERBS.map((v) => ({ name: v.name, usage: v.usage, summary: v.summary, reaches: v.reaches })),
      },
    };
  },
};

export const VERBS: readonly Verb[] = [get, set, query, schema, batch, run, exportVerb, apply, merge, plugins, describe];

export function sessionOptions(args: ParsedArgs, cwd: string): SessionOptions {
  const plugins = flagBool(args, "no-plugins")
    ? []
    : flagStr(args, "plugins") !== undefined
      ? flagStr(args, "plugins")!.split(",").map((x) => x.trim()).filter(Boolean)
      : undefined;
  const font = flagStr(args, "font");
  const engineFrom = flagStr(args, "engine-from");
  return { cwd, ...(plugins ? { plugins } : {}), ...(font ? { font } : {}), ...(engineFrom ? { engineFrom } : {}) };
}

export { openSession, basename };
