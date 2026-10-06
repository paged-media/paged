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

// The entry point: `main(argv)` parses against the verb table, runs the
// verb over a session, prints JSON (or --text / --format text), and answers
// an exit code. In-process callable (the tests drive it), and what the
// `paged` bin runs.

import { parseArgs, flagBool, flagStr, type OptionSpec, type ParsedArgs } from "./args";
import { CliError, EXIT } from "./errors";
import { cliVersion, engineVersionOnDisk, openSession, type CliSession } from "./session";
import { GLOBAL_OPTIONS, sessionOptions, VERBS, type Verb } from "./verbs";

export interface MainIO {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd?: string;
}

const processIO: MainIO = {
  stdout: (t) => void process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  stderr: (t) => void process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
};

const optionLine = (o: OptionSpec): string =>
  `  ${[o.short ? `-${o.short}` : null, `--${o.name}${o.value ? ` <${o.value}>` : ""}`].filter(Boolean).join(", ").padEnd(34)} ${o.help}${o.repeat ? " (repeatable)" : ""}`;

/** `paged --help`, generated from the verb table. */
export function helpText(): string {
  const width = Math.max(...VERBS.map((v) => v.name.length + v.usage.length + 1));
  return [
    `paged ${cliVersion()} — the paged Node CLI over core and every installed plugin (ADR 324)`,
    "",
    "usage: paged <verb> [args] [options]",
    "",
    "verbs:",
    ...VERBS.map((v) => `  ${`${v.name} ${v.usage}`.padEnd(width + 2)} ${v.summary}`),
    "",
    "options (every verb):",
    ...GLOBAL_OPTIONS.map(optionLine),
    "",
    "Output is JSON; --text (or --format text where --format is not a file format) is for humans.",
    "Exit codes: 0 ok · 1 rejected write or failed check · 2 usage or IO error.",
    "Addresses: doc, page:#1, textFrame:<id>, story:<id>, storyRange:<id>@a..b, swatch:<name>, style:<family>/<name>,",
    "  layer:<id>, plugin:<pluginId>/<kind>/<id>. Selectors: swatch[name=Black], frame[label.<key>=v], page:#1 > frame.",
    "Run `paged <verb> --help` for a verb's options.",
  ].join("\n");
}

export function verbHelp(v: Verb): string {
  return [
    `paged ${v.name} ${v.usage}`,
    "",
    v.summary,
    "",
    "options:",
    ...v.options.map(optionLine),
    ...GLOBAL_OPTIONS.map(optionLine),
  ].join("\n");
}

function textMode(args: ParsedArgs, verb: Verb): boolean {
  if (flagBool(args, "text")) return true;
  const fmtIsOutput = verb.options.some((o) => o.name === "format" && o.value === "json|text");
  const f = flagStr(args, "format");
  if (fmtIsOutput && f !== undefined && f !== "json" && f !== "text") {
    throw new CliError(EXIT.usage, `--format: "${f}" is not json | text`);
  }
  return fmtIsOutput && f === "text";
}

/** Run the CLI; resolves to the exit code. Never calls process.exit. */
export async function main(argv: readonly string[], io: MainIO = processIO): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") {
    io.stdout(helpText());
    return first === undefined ? EXIT.usage : EXIT.ok;
  }
  if (first === "--version" || first === "-v") {
    io.stdout(JSON.stringify({ cli: cliVersion(), engine: engineVersionOnDisk() }));
    return EXIT.ok;
  }
  const verb = VERBS.find((v) => v.name === first);
  let text = false;
  let session: CliSession | null = null;
  try {
    if (!verb) throw new CliError(EXIT.usage, `unknown verb "${first}" — one of: ${VERBS.map((v) => v.name).join(", ")}`);
    const args = parseArgs(rest, [...verb.options, ...GLOBAL_OPTIONS]);
    if (flagBool(args, "help")) {
      io.stdout(verbHelp(verb));
      return EXIT.ok;
    }
    text = textMode(args, verb);
    if (args.positionals.length < verb.min || args.positionals.length > verb.max) {
      throw new CliError(EXIT.usage, `usage: paged ${verb.name} ${verb.usage}`);
    }
    const options = sessionOptions(args, cwd);
    const result = await verb.run({
      args,
      cwd,
      async session(doc) {
        if (session) return session;
        session = await openSession(doc, options);
        return session;
      },
    });
    io.stdout(text && result.text !== undefined ? result.text : JSON.stringify(result.json, null, 2));
    return result.exit ?? EXIT.ok;
  } catch (err) {
    const e = err instanceof CliError ? err : new CliError(EXIT.failed, err instanceof Error ? (err.stack ?? err.message) : String(err));
    if (text) io.stderr(`paged: ${e.message}`);
    else io.stdout(JSON.stringify({ error: { message: e.message, exit: e.exit, ...(e.detail ?? {}) } }, null, 2));
    return e.exit;
  } finally {
    (session as CliSession | null)?.dispose();
  }
}
