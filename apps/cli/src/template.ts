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

// `paged template` — fill and check templates on a server (the editor's
// docs/composable-editor.md §9; plan task F6). The same engine messages the
// browser's template form sends (engine ADR 1001):
//
//   paged template fields <doc>                      the fields, their kinds, constraints and values
//   paged template kinds                             the module field kinds the loaded modules offer
//   paged template fill <template> --values <json> -o <out>
//                                                    fill as a filler; write .paged, .idml or .pdf
//   paged template check <template> <filled>         is <filled> the template with only its fields changed?
//   paged template ingest <doc> -o <out>             open a tagged document as a template (engine ADR 1002)
//
// `fill` runs in a filler session, so a value the template does not permit
// is refused here as it is in the browser. `check` refills the template with
// the submission's own field values and compares the two documents element
// by element and story by story: any other difference is a change the
// template did not allow. The template, not the submission, is the authority.
//
// A module field (a sheet's cell, a doc's block; plan G2) is read and written
// by the module that owns its kind, through `host.objects`, after the session
// takes the filler role, so the engine checks the module's writes as it
// checks its own. A module value is plain JSON; a picture is
// `{ "$file": "<path>" }`.

import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { flagBool, flagStr, type OptionSpec } from "./args";
import { CliError, EXIT } from "./errors";
import { pendingContent, pendingLine } from "./module-content";
import type { CliSession } from "./session";
import type { Verb } from "./verbs";

interface Reply {
  kind: string;
  payload: Record<string, unknown> & {
    error?: { kind: string; details?: Record<string, unknown> };
    problems?: { name: string; problem: string }[];
  };
}

interface FieldRow {
  field: {
    name: string;
    kind: string;
    module?: { kind: string; def?: unknown } | null;
    constraints?: { allowedStyles?: string[]; breaks?: string | null } | null;
    members?: string[];
  };
  targetId: string;
  storyId?: string | null;
  value?: {
    kind: string;
    text?: string;
    uri?: string;
    visible?: boolean;
    value?: unknown;
  } | null;
}

interface FieldValue {
  name: string;
  value: unknown;
}

const moduleRef = (r: FieldRow) =>
  r.field.module
    ? {
        name: r.field.name,
        targetId: r.targetId,
        kind: r.field.module.kind,
        def: r.field.module.def ?? null,
      }
    : null;

const send = (s: CliSession, kind: string, payload?: unknown): Promise<Reply> =>
  s.driver.editor.client.send(
    (payload === undefined ? { kind } : { kind, payload }) as never,
  ) as unknown as Promise<Reply>;

/** The template's fields; a module field's value comes from its module
 *  (`{ kind: "module", value }`), or is null when the module is not
 *  loaded. */
async function fields(s: CliSession): Promise<FieldRow[]> {
  const rows = (await s.driver.editor.client.collection(
    "templateFields" as never,
  )) as FieldRow[];
  for (const row of rows) {
    const ref = moduleRef(row);
    if (!ref) continue;
    try {
      const { value } = await s.h.objects.readTemplateField(ref);
      row.value = value === null ? null : { kind: "module", value };
    } catch {
      row.value = null;
    }
  }
  return rows;
}

/** A module value as its module takes it: the wire's wrapped text or
 *  visibility unwrapped, a `{ "$file" }` picture read from disk. */
function moduleValue(cwd: string, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o["kind"] === "module") return o["value"];
    if (o["kind"] === "text" && typeof o["text"] === "string") return o["text"];
    if (o["kind"] === "visible" && typeof o["visible"] === "boolean")
      return o["visible"];
    if (typeof o["$file"] === "string") {
      const path = resolve(cwd, o["$file"]);
      return {
        name: basename(path),
        bytes: new Uint8Array(readFileSync(path)),
      };
    }
  }
  return v;
}

function refusal(reply: Reply): string {
  const e = reply.payload.error;
  if (!e) return `the engine answered ${reply.kind}`;
  const d = e.details ?? {};
  if (e.kind === "notPermitted")
    return `not permitted: ${d["permission"]} on ${d["target"]}`;
  if (e.kind === "locked") return `${d["node"]} is locked`;
  if (typeof d["what"] === "string") return d["what"] as string;
  return e.kind;
}

/** Fill `values` in a filler session; throws what the engine or a module
 *  refused. */
async function fill(
  s: CliSession,
  values: readonly FieldValue[],
  cwd: string,
): Promise<void> {
  const role = await send(s, "setSessionPolicy", {
    policy: { role: "filler" },
  });
  if (role.kind !== "sessionPolicyApplied")
    throw new CliError(
      EXIT.failed,
      `the engine did not take the session role (${role.kind})`,
    );
  const rows = await fields(s);
  const modules = new Map(
    rows.flatMap((r) => {
      const ref = moduleRef(r);
      return ref ? [[r.field.name, ref] as const] : [];
    }),
  );
  // Engine ADR 1017: a text given to an alternates field names the member
  // to show.
  const alternates = new Set(
    rows.filter((r) => r.field.kind === "alternates").map((r) => r.field.name),
  );
  const engine = values
    .filter((v) => !modules.has(v.name))
    .map((v) => {
      const o = v.value as { kind?: string; text?: string } | null;
      return alternates.has(v.name) &&
        o?.kind === "text" &&
        typeof o.text === "string"
        ? { name: v.name, value: { kind: "alternate", member: o.text } }
        : v;
    });
  if (engine.length > 0) {
    const reply = await send(s, "setTemplateFields", { values: engine });
    if (reply.kind === "templateFieldsRefused")
      throw new CliError(EXIT.failed, "values do not fit their fields", {
        problems: reply.payload.problems ?? [],
      });
    if (reply.kind !== "mutationApplied")
      throw new CliError(EXIT.failed, `fill refused: ${refusal(reply)}`);
  }
  const problems: { name: string; problem: string }[] = [];
  // In the template's field order, whatever order the values came in: a
  // module's writes may depend on the order (a sheet counts its writes), and
  // `check` refills in this order too.
  const rank = new Map(rows.map((r, i) => [r.field.name, i]));
  const ordered = [...values].sort(
    (a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0),
  );
  for (const v of ordered) {
    const ref = modules.get(v.name);
    if (!ref) continue;
    try {
      const r = await s.h.objects.writeTemplateField(
        ref,
        moduleValue(cwd, v.value),
      );
      if (!r.ok) problems.push({ name: v.name, problem: r.problem });
    } catch (err) {
      problems.push({
        name: v.name,
        problem: /unknownFieldKind/.test(String(err))
          ? `the module of ${ref.kind} is not loaded`
          : (err as Error).message,
      });
    }
  }
  if (problems.length > 0)
    throw new CliError(EXIT.failed, "values do not fit their fields", {
      problems,
    });
}

/** What a field takes beyond its kind (engine ADR 1017): a text field's
 *  allowed styles and breaks, an alternates field's members. */
function describe(r: FieldRow): string {
  const c = r.field.constraints ?? {};
  const parts = [
    ...(c.allowedStyles?.length
      ? [`styles: ${c.allowedStyles.join(", ")}`]
      : []),
    ...(c.breaks ? [`breaks: ${c.breaks}`] : []),
    ...(r.field.members?.length
      ? [`alternates: ${r.field.members.join(" | ")}`]
      : []),
  ];
  return parts.length ? `\t${parts.join("; ")}` : "";
}

/** The values a filled document holds, as `fill` takes them. */
function valuesOf(rows: readonly FieldRow[]): FieldValue[] {
  return rows.flatMap((r) =>
    r.value ? [{ name: r.field.name, value: r.value }] : [],
  );
}

function readValues(cwd: string, arg: string): FieldValue[] {
  const text =
    arg.trim().startsWith("[") || arg.trim().startsWith("{")
      ? arg
      : readFileSync(resolve(cwd, arg), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError(
      EXIT.usage,
      `--values is not JSON: ${(err as Error).message}`,
    );
  }
  // `{ "name": "text" | boolean | runs | value }` is accepted beside the
  // wire's list; a list is a styled value's runs (engine ADR 1017).
  if (Array.isArray(parsed)) return parsed as FieldValue[];
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(
      ([name, v]) => ({
        name,
        value:
          typeof v === "string"
            ? { kind: "text", text: v }
            : typeof v === "boolean"
              ? { kind: "visible", visible: v }
              : Array.isArray(v)
                ? { kind: "runs", runs: v }
                : v,
      }),
    );
  }
  throw new CliError(
    EXIT.usage,
    "--values is a list of {name, value} or an object of name → value",
  );
}

/** The kinds of object a template's layout is made of. */
const KINDS = [
  "textFrame",
  "rectangle",
  "oval",
  "polygon",
  "graphicLine",
  "group",
  "story",
  "page",
];

/** Every object's readable properties (a story's content included), keyed
 *  by address: what two documents are compared by. The loaded modules'
 *  objects count too, so a change to a sheet outside its fields shows. */
async function snapshot(s: CliSession): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const modules = (await s.h.objects.kinds())
    .filter((k) => k.owner !== "core")
    .map((k) => k.kind);
  for (const kind of [...KINDS, ...modules]) {
    let addresses: readonly string[] = [];
    try {
      addresses = await s.h.objects.query(kind);
    } catch {
      continue;
    }
    for (const address of addresses) {
      const all = await s.h.objects.getAll(address, { content: true });
      // A derived row is computed from the session (a query's record count
      // once its source loaded), not stored in the document: two documents
      // are compared by what they hold.
      const derived = new Set(
        (await s.h.objects.schema(address))
          .filter((r) => r.access === "derived")
          .map((r) => r.path),
      );
      const values: Record<string, unknown> = {};
      for (const [path, v] of Object.entries(all)) {
        if (v.kind === "value" && !derived.has(path)) values[path] = v.value;
      }
      out.set(address, JSON.stringify(values));
    }
  }
  return out;
}

const VALUES: OptionSpec = {
  name: "values",
  value: "json|file",
  help: "the field values: a JSON list of {name, value}, an object of name → text, styled runs ([{text, style?} | {break}]), an alternate's name or a value, or a file holding either",
};

interface Derivation {
  fields: {
    field: { name: string; kind: string };
    target: Record<string, unknown> & { kind: string };
  }[];
  skipped: { elementId: string; tag: string; reason: string }[];
}

/** `ingest`: the fields the document's XML tags describe, written as the
 *  template's policy in an author's session, tagged ranges made placeholder
 *  runs (engine ADR 1002), the same message the editor's File ▸ Open as
 *  template sends. */
async function ingest(
  s: CliSession,
  options: { includeNames: boolean; includePlaceholders: boolean },
): Promise<Derivation> {
  const role = await send(s, "setSessionPolicy", {
    policy: { role: "author" },
  });
  if (role.kind !== "sessionPolicyApplied")
    throw new CliError(
      EXIT.failed,
      `the engine did not take the session role (${role.kind})`,
    );
  const derived = await send(s, "requestDerivedTemplateFields", { options });
  if (derived.kind !== "derivedTemplateFields")
    throw new CliError(EXIT.failed, `the engine answered ${derived.kind}`);
  const derivation = derived.payload["derivation"] as Derivation;
  const reply = await send(s, "openAsTemplate", { options, only: null });
  if (reply.kind === "templateFieldsRefused")
    throw new CliError(EXIT.failed, "nothing in the document is a field", {
      problems: reply.payload.problems ?? [],
      skipped: derivation.skipped,
    });
  if (reply.kind !== "mutationApplied")
    throw new CliError(EXIT.failed, `ingest refused: ${refusal(reply)}`);
  return derivation;
}

export const template: Verb = {
  name: "template",
  usage:
    "fields <doc> | kinds | fill <template> | check <template> <filled> | ingest <doc>",
  summary:
    "template fields: list them, fill them as a filler (writes .paged, .idml or .pdf), check that a filled document changed only its fields, ingest a document tagged for XML as a template",
  min: 1,
  max: 3,
  options: [
    VALUES,
    {
      name: "out",
      short: "o",
      value: "file",
      help: "fill, ingest: write the result here",
    },
    {
      name: "names",
      help: "ingest: untagged items with a name become fields too",
    },
    {
      name: "placeholders",
      help: "ingest: plugin placeholders become fields too",
    },
  ],
  reaches: ["templateFieldKinds", "readTemplateField", "writeTemplateField"],
  async run({ args, session, freshSession, cwd }) {
    const [sub, doc, other] = args.positionals as [
      string,
      string | undefined,
      string | undefined,
    ];
    if (sub === "kinds") {
      const s = await session(null);
      const kinds = await s.h.objects.templateFieldKinds();
      return {
        json: { kinds },
        text: kinds.length
          ? kinds
              .map((k) => `${k.kind}\t${k.control.kind}\t${k.title}`)
              .join("\n")
          : "no module field kinds",
      };
    }
    if (!doc)
      throw new CliError(EXIT.usage, `template ${sub} needs a document`);
    if (sub === "fields") {
      const s = await session(doc);
      const rows = await fields(s);
      return {
        json: { fields: rows },
        text: rows.length
          ? rows
              .map(
                (r) =>
                  `${r.field.name}\t${r.field.kind}\t${JSON.stringify(r.value ?? null)}${describe(r)}`,
              )
              .join("\n")
          : "no fields",
      };
    }
    if (sub === "fill") {
      const valuesArg = flagStr(args, "values");
      if (!valuesArg)
        throw new CliError(EXIT.usage, "template fill needs --values");
      const out = flagStr(args, "out");
      if (!out) throw new CliError(EXIT.usage, "template fill needs -o <file>");
      const s = await session(doc);
      await fill(s, readValues(cwd, valuesArg), cwd);
      // A PDF of content this session cannot draw (an edited picture whose
      // composite needs a GPU) would show the old picture: refused, loudly.
      if (extname(out).toLowerCase() === ".pdf") {
        const pending = await pendingContent(s);
        if (pending.length > 0)
          throw new CliError(
            EXIT.failed,
            `template fill: ${pending.length} object(s) cannot be drawn here; write .paged and export it where they render`,
            { pending: pending.map(pendingLine) },
          );
      }
      const saved = await s.save(out);
      return {
        json: { ...saved, fields: await fields(s) },
        text: `wrote ${saved.path}`,
      };
    }
    if (sub === "ingest") {
      const out = flagStr(args, "out");
      if (!out)
        throw new CliError(EXIT.usage, "template ingest needs -o <file>");
      const s = await session(doc);
      const derivation = await ingest(s, {
        includeNames: flagBool(args, "names"),
        includePlaceholders: flagBool(args, "placeholders"),
      });
      const saved = await s.save(out);
      const rows = await fields(s);
      return {
        json: { ...saved, fields: rows, skipped: derivation.skipped },
        text: [
          `wrote ${saved.path}`,
          ...rows.map((r) => `${r.field.name}\t${r.field.kind}`),
          ...derivation.skipped.map((t) => `skipped ${t.tag}: ${t.reason}`),
        ].join("\n"),
      };
    }
    if (sub === "check") {
      if (!other)
        throw new CliError(
          EXIT.usage,
          "template check needs <template> <filled>",
        );
      const submitted = await session(other);
      const values = valuesOf(await fields(submitted));
      const actual = await snapshot(submitted);
      if (!freshSession)
        throw new CliError(EXIT.usage, "template check needs a second session");
      const expected = await freshSession(doc);
      await fill(expected, values, cwd);
      const wanted = await snapshot(expected);
      const differences: string[] = [];
      for (const key of new Set([...wanted.keys(), ...actual.keys()])) {
        if (wanted.get(key) !== actual.get(key)) differences.push(key);
      }
      const ok = differences.length === 0;
      // Content a headless session draws as an older picture: not a change
      // outside the fields, but what a PDF written here would get wrong.
      const pending = await pendingContent(submitted);
      return {
        json: { ok, values, differences, pending },
        text: [
          ok
            ? "ok: only the template's fields differ"
            : `changed outside the template's fields:\n${differences.join("\n")}`,
          ...pending.map(pendingLine),
        ].join("\n"),
        exit: ok ? EXIT.ok : EXIT.failed,
      };
    }
    throw new CliError(
      EXIT.usage,
      `template: unknown subcommand "${sub}" (fields, kinds, fill, check, ingest)`,
    );
  },
};
