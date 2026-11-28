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

// The entry point: `main(argv)` parses against the verb table, runs the
// verb over a session, prints JSON (or --text / --format text), and answers
// an exit code. In-process callable (the tests drive it), and what the
// `paged-node` bin runs.

import {
  parseArgs,
  flagBool,
  flagStr,
  type OptionSpec,
  type ParsedArgs,
} from "./args";
import { BIN, CliError, EXIT } from "./errors";
import {
  cliVersion,
  engineVersionOnDisk,
  openSession,
  type CliSession,
} from "./session";
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

/** `paged-node --help`, generated from the verb table. */
export function helpText(): string {
  const width = Math.max(
    ...VERBS.map((v) => v.name.length + v.usage.length + 1),
  );
  return [
    `${BIN} ${cliVersion()} — the paged Node CLI over core and every installed plugin (ADR 324)`,
    "",
    `usage: ${BIN} <verb> [args] [options]`,
    "",
    "verbs:",
    ...VERBS.map(
      (v) => `  ${`${v.name} ${v.usage}`.padEnd(width + 2)} ${v.summary}`,
    ),
    "",
    "options (every verb):",
    ...GLOBAL_OPTIONS.map(optionLine),
    "",
    "Plugin bundles load only on request: --plugins <a,b> names them, --plugins auto (or PAGED_PLUGINS=auto)",
    "  discovers the ones installed in the current directory. Use auto only in a directory whose packages you trust.",
    "Output is JSON; --text (or --format text where --format is not a file format) is for humans.",
    "Exit codes: 0 ok · 1 rejected write or failed check · 2 usage or IO error.",
    "Addresses: doc, page:#1, textFrame:<id>, story:<id>, storyRange:<id>@a..b, swatch:<name>, style:<family>/<name>,",
    "  layer:<id>, plugin:<pluginId>/<kind>/<id>. Selectors: swatch[name=Black], frame[label.<key>=v], page:#1 > frame.",
    `Run \`${BIN} <verb> --help\` for a verb's options.`,
  ].join("\n");
}

export function verbHelp(v: Verb): string {
  return [
    `${BIN} ${v.name} ${v.usage}`,
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
  const fmtIsOutput = verb.options.some(
    (o) => o.name === "format" && o.value === "json|text",
  );
  const f = flagStr(args, "format");
  if (fmtIsOutput && f !== undefined && f !== "json" && f !== "text") {
    throw new CliError(EXIT.usage, `--format: "${f}" is not json | text`);
  }
  return fmtIsOutput && f === "text";
}

/** Is a stack trace asked for: `--debug` among the options (before a `--`),
 *  or PAGED_DEBUG set to anything but `0`? Read ahead of the parse, so a
 *  failure of the parse itself honours it too. */
export function debugRequested(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  const end = argv.indexOf("--");
  if ((end < 0 ? argv : argv.slice(0, end)).includes("--debug")) return true;
  const v = env["PAGED_DEBUG"];
  return v !== undefined && v !== "" && v !== "0";
}

/** Run the CLI; resolves to the exit code. Never calls process.exit. */
export async function main(
  argv: readonly string[],
  io: MainIO = processIO,
): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const [first, ...rest] = argv;
  if (
    first === undefined ||
    first === "--help" ||
    first === "-h" ||
    first === "help"
  ) {
    io.stdout(helpText());
    return first === undefined ? EXIT.usage : EXIT.ok;
  }
  if (first === "--version" || first === "-v") {
    io.stdout(
      JSON.stringify({ cli: cliVersion(), engine: engineVersionOnDisk() }),
    );
    return EXIT.ok;
  }
  const verb = VERBS.find((v) => v.name === first);
  let text = false;
  let debug = debugRequested(rest);
  let session: CliSession | null = null;
  const extra: CliSession[] = [];
  try {
    if (!verb)
      throw new CliError(
        EXIT.usage,
        `unknown verb "${first}" — one of: ${VERBS.map((v) => v.name).join(", ")}`,
      );
    const args = parseArgs(rest, [...verb.options, ...GLOBAL_OPTIONS]);
    if (flagBool(args, "help")) {
      io.stdout(verbHelp(verb));
      return EXIT.ok;
    }
    debug = debug || flagBool(args, "debug");
    text = textMode(args, verb);
    if (
      args.positionals.length < verb.min ||
      args.positionals.length > verb.max
    ) {
      throw new CliError(
        EXIT.usage,
        `usage: ${BIN} ${verb.name} ${verb.usage}`,
      );
    }
    const options = {
      ...sessionOptions(args, cwd),
      warn: (t: string) => io.stderr(`${BIN}: warning: ${t}`),
    };
    const result = await verb.run({
      args,
      cwd,
      async session(doc) {
        if (session) return session;
        session = await openSession(doc, options);
        return session;
      },
      async freshSession(doc) {
        const s = await openSession(doc, options);
        extra.push(s);
        return s;
      },
    });
    if (result.silent) return result.exit ?? EXIT.ok;
    io.stdout(
      text && result.text !== undefined
        ? result.text
        : JSON.stringify(result.json, null, 2),
    );
    return result.exit ?? EXIT.ok;
  } catch (err) {
    // An unexpected failure reports its message only: a stack trace names
    // the installation's paths and internals, so it is for `--debug`.
    const e =
      err instanceof CliError
        ? err
        : new CliError(
            EXIT.failed,
            err instanceof Error ? err.message : String(err),
          );
    const stack =
      debug &&
      !(err instanceof CliError) &&
      err instanceof Error &&
      typeof err.stack === "string"
        ? err.stack
        : undefined;
    if (text) io.stderr(`${BIN}: ${stack ?? e.message}`);
    else
      io.stdout(
        JSON.stringify(
          {
            error: {
              message: e.message,
              exit: e.exit,
              ...(e.detail ?? {}),
              ...(stack !== undefined ? { stack } : {}),
            },
          },
          null,
          2,
        ),
      );
    return e.exit;
  } finally {
    (session as CliSession | null)?.dispose();
    for (const s of extra) s.dispose();
  }
}
