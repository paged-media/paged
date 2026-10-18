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

// A strict argument parser driven by the verb table: an unknown flag, a
// missing flag value or a wrong positional count is a usage error (exit 2).

import { CliError, EXIT } from "./errors";

export interface OptionSpec {
  /** Long name without dashes (`out`). */
  name: string;
  short?: string;
  /** Takes a value (`--out file`) vs a boolean switch. */
  value?: string;
  /** May repeat (values collect into an array). */
  repeat?: boolean;
  help: string;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | string[] | boolean>;
  /** Everything after `--` (passed to `run` scripts). */
  rest: string[];
}

export function parseArgs(argv: readonly string[], specs: readonly OptionSpec[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {}, rest: [] };
  const byLong = new Map(specs.map((s) => [s.name, s]));
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short!, s]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    let spec: OptionSpec | undefined;
    let inline: string | undefined;
    if (a.startsWith("--")) {
      const [name, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      spec = byLong.get(name);
      inline = v;
      if (!spec) throw new CliError(EXIT.usage, `unknown option --${name}`);
    } else if (a.startsWith("-") && a.length === 2 && !/^-\d$/.test(a)) {
      spec = byShort.get(a.slice(1));
      if (!spec) throw new CliError(EXIT.usage, `unknown option ${a}`);
    } else {
      out.positionals.push(a);
      continue;
    }
    if (!spec.value) {
      if (inline !== undefined) throw new CliError(EXIT.usage, `--${spec.name} takes no value`);
      out.flags[spec.name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new CliError(EXIT.usage, `--${spec.name} needs a value (${spec.value})`);
    if (spec.repeat) {
      const prev = out.flags[spec.name];
      out.flags[spec.name] = [...(Array.isArray(prev) ? prev : []), value];
    } else {
      out.flags[spec.name] = value;
    }
  }
  return out;
}

export const flagStr = (a: ParsedArgs, name: string): string | undefined => {
  const v = a.flags[name];
  return typeof v === "string" ? v : undefined;
};
export const flagBool = (a: ParsedArgs, name: string): boolean => a.flags[name] === true;
export const flagList = (a: ParsedArgs, name: string): string[] => {
  const v = a.flags[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
};
export function flagNumber(a: ParsedArgs, name: string, fallback: number): number {
  const v = flagStr(a, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) throw new CliError(EXIT.usage, `--${name}: "${v}" is not a number`);
  return n;
}
