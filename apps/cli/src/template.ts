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
//   paged template fill <template> --values <json> -o <out>
//                                                    fill as a filler; write .paged, .idml or .pdf
//   paged template check <template> <filled>         is <filled> the template with only its fields changed?
//
// `fill` runs in a filler session, so a value the template does not permit
// is refused here as it is in the browser. `check` refills the template with
// the submission's own field values and compares the two documents element
// by element and story by story: any other difference is a change the
// template did not allow. The template, not the submission, is the authority.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flagStr, type OptionSpec } from "./args";
import { CliError, EXIT } from "./errors";
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
  field: { name: string; kind: string };
  storyId?: string | null;
  value?: {
    kind: string;
    text?: string;
    uri?: string;
    visible?: boolean;
  } | null;
}

const send = (s: CliSession, kind: string, payload?: unknown): Promise<Reply> =>
  s.driver.editor.client.send(
    (payload === undefined ? { kind } : { kind, payload }) as never,
  ) as unknown as Promise<Reply>;

async function fields(s: CliSession): Promise<FieldRow[]> {
  return (await s.driver.editor.client.collection(
    "templateFields" as never,
  )) as FieldRow[];
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

/** Fill `values` in a filler session; throws what the engine refused. */
async function fill(s: CliSession, values: unknown[]): Promise<void> {
  const role = await send(s, "setSessionPolicy", {
    policy: { role: "filler" },
  });
  if (role.kind !== "sessionPolicyApplied")
    throw new CliError(
      EXIT.failed,
      `the engine did not take the session role (${role.kind})`,
    );
  const reply = await send(s, "setTemplateFields", { values });
  if (reply.kind === "templateFieldsRefused")
    throw new CliError(EXIT.failed, "values do not fit their fields", {
      problems: reply.payload.problems ?? [],
    });
  if (reply.kind !== "mutationApplied")
    throw new CliError(EXIT.failed, `fill refused: ${refusal(reply)}`);
}

/** The values a filled document holds, as `fill` takes them. */
function valuesOf(rows: readonly FieldRow[]): unknown[] {
  return rows.flatMap((r) =>
    r.value ? [{ name: r.field.name, value: r.value }] : [],
  );
}

function readValues(cwd: string, arg: string): unknown[] {
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
  // `{ "name": "text" | value }` is accepted beside the wire's list.
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(
      ([name, v]) => ({
        name,
        value:
          typeof v === "string"
            ? { kind: "text", text: v }
            : typeof v === "boolean"
              ? { kind: "visible", visible: v }
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
 *  by address: what two documents are compared by. */
async function snapshot(s: CliSession): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const kind of KINDS) {
    let addresses: readonly string[] = [];
    try {
      addresses = await s.h.objects.query(kind);
    } catch {
      continue;
    }
    for (const address of addresses) {
      const all = await s.h.objects.getAll(address, { content: true });
      const values: Record<string, unknown> = {};
      for (const [path, v] of Object.entries(all)) {
        if (v.kind === "value") values[path] = v.value;
      }
      out.set(address, JSON.stringify(values));
    }
  }
  return out;
}

const VALUES: OptionSpec = {
  name: "values",
  value: "json|file",
  help: "the field values: a JSON list of {name, value}, an object of name → text, or a file holding either",
};

export const template: Verb = {
  name: "template",
  usage: "fields <doc> | fill <template> | check <template> <filled>",
  summary:
    "template fields: list them, fill them as a filler (writes .paged, .idml or .pdf), check that a filled document changed only its fields",
  min: 2,
  max: 3,
  options: [
    VALUES,
    {
      name: "out",
      short: "o",
      value: "file",
      help: "fill: write the result here",
    },
  ],
  reaches: [],
  async run({ args, session, freshSession, cwd }) {
    const [sub, doc, other] = args.positionals as [
      string,
      string,
      string | undefined,
    ];
    if (sub === "fields") {
      const s = await session(doc);
      const rows = await fields(s);
      return {
        json: { fields: rows },
        text: rows.length
          ? rows
              .map(
                (r) =>
                  `${r.field.name}\t${r.field.kind}\t${JSON.stringify(r.value ?? null)}`,
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
      await fill(s, readValues(cwd, valuesArg));
      const saved = await s.save(out);
      return {
        json: { ...saved, fields: await fields(s) },
        text: `wrote ${saved.path}`,
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
      await fill(expected, values);
      const wanted = await snapshot(expected);
      const differences: string[] = [];
      for (const key of new Set([...wanted.keys(), ...actual.keys()])) {
        if (wanted.get(key) !== actual.get(key)) differences.push(key);
      }
      const ok = differences.length === 0;
      return {
        json: { ok, values, differences },
        text: ok
          ? "ok: only the template's fields differ"
          : `changed outside the template's fields:\n${differences.join("\n")}`,
        exit: ok ? EXIT.ok : EXIT.failed,
      };
    }
    throw new CliError(
      EXIT.usage,
      `template: unknown subcommand "${sub}" (fields, fill, check)`,
    );
  },
};
