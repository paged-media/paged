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

// The golden-file kit of the TypeScript CLIs' tests (`paged-plugin` here,
// `paged-node` in packages/cli): a command's run is recorded as a transcript
// (the command line, the exit code, stdout, stderr), normalised so it does not
// depend on the machine (temporary paths, versions, sizes, times), and
// compared with a committed file. `PAGED_UPDATE_GOLDEN=1` rewrites the files
// instead; review the diff before committing it.
//
// Also the TypeScript half of the honest-skip convention
// (docs/development/testing.md): a test whose resource is missing reports
// `unavailable: <resource>: <reason>`, is SKIPPED (never passed), and fails
// when `PAGED_REQUIRE_<KEY>=1` says the lane has the resource.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { expect, it } from "bun:test";

/** `PAGED_UPDATE_GOLDEN=1`: write the golden files instead of comparing. */
export const UPDATE_GOLDEN = process.env["PAGED_UPDATE_GOLDEN"] === "1";

/** One substitution: every occurrence of `from` becomes `to`. */
export interface Rule {
  from: string | RegExp;
  to: string;
}

/** The rules that replace a directory (and its resolved form: macOS reports
 *  `/var/…` and `/private/var/…` for one temporary directory) by `token`. */
export function pathRules(dir: string, token: string): Rule[] {
  const forms = new Set([dir]);
  try {
    forms.add(realpathSync(dir));
  } catch {
    /* a directory that does not exist yet has one form */
  }
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map((from) => ({ from, to: token }));
}

/** Applies `rules` in order; also unifies line endings, drops trailing
 *  blanks and ends the text with exactly one newline. */
export function normalise(text: string, rules: readonly Rule[]): string {
  let out = text.replace(/\r\n?/g, "\n");
  for (const r of rules)
    out =
      typeof r.from === "string"
        ? out.split(r.from).join(r.to)
        : out.replace(r.from, r.to);
  return `${out.replace(/[ \t]+$/gm, "").replace(/\n+$/, "")}\n`;
}

/** A shell-readable command line. */
export function commandLine(argv: readonly string[]): string {
  return argv
    .map((a) =>
      a === "" || /[^\w@%+=:,./<>#*-]/.test(a)
        ? `'${a.replace(/'/g, `'\\''`)}'`
        : a,
    )
    .join(" ");
}

/** The transcript a golden file holds. */
export function transcript(run: {
  argv: readonly string[];
  code: number;
  out: string;
  err: string;
  extra?: string;
}): string {
  const block = (s: string) => (s.trim() === "" ? "(empty)\n" : `${s}\n`);
  return [
    `$ ${commandLine(run.argv)}\n`,
    `# exit ${run.code}\n`,
    "# stdout\n",
    block(run.out.replace(/\n+$/, "")),
    "# stderr\n",
    block(run.err.replace(/\n+$/, "")),
    ...(run.extra !== undefined
      ? ["# structure\n", block(run.extra.replace(/\n+$/, ""))]
      : []),
  ].join("");
}

/** Compares `actual` with the golden `file`, or writes it under
 *  PAGED_UPDATE_GOLDEN=1. A missing golden fails with the command to make it. */
export function expectGolden(file: string, actual: string): void {
  if (UPDATE_GOLDEN) {
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== actual)
      writeFileSync(file, actual);
    return;
  }
  if (!existsSync(file))
    throw new Error(
      `no golden file ${file}: run the test with PAGED_UPDATE_GOLDEN=1 to write it, then review it`,
    );
  expect(actual).toBe(readFileSync(file, "utf8"));
}

/** Every golden file under `dir`, as `/`-separated paths relative to it. */
export function goldenFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".txt"))
        out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

// ------------------------------------------------------------ honest skips

/** Whether `PAGED_REQUIRE_<key>` asks for the resource (1, true or yes). */
export function required(key: string): boolean {
  const v = process.env[`PAGED_REQUIRE_${key}`]?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The `it` for tests that need a resource. Available: `it`. Missing: prints
 * `unavailable: <resource>: <reason>`, appends it to `$PAGED_SKIP_LOG`, and
 * answers `it.skip` — or, under `PAGED_REQUIRE_<key>=1`, an `it` that fails
 * with that line.
 */
export function needs(
  available: boolean,
  resource: string,
  key: string,
  reason: string,
): typeof it {
  if (available) return it;
  const line = `unavailable: ${resource}: ${reason}`;
  if (required(key)) {
    return ((name: string) =>
      it(name, () => {
        throw new Error(`${line} (PAGED_REQUIRE_${key}=1)`);
      })) as unknown as typeof it;
  }
  return ((name: string, ...rest: unknown[]) => {
    process.stderr.write(`${line}\n`);
    const log = process.env["PAGED_SKIP_LOG"];
    if (log)
      appendFileSync(log, `bun test\t${name}\t${resource}\t${line}\n`, "utf8");
    return (it.skip as (n: string, ...r: unknown[]) => void)(name, ...rest);
  }) as unknown as typeof it;
}

// ------------------------------------------------------------- structure

/** The entry names of a ZIP archive (IDML and `.paged` are ZIPs), in
 *  central-directory order — an export's structure without its bytes. */
export function zipEntries(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0)
    throw new Error("not a ZIP archive: no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  const utf8 = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50)
      throw new Error(`ZIP central directory entry ${n} is malformed`);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    names.push(utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** A PDF's header version and its page count (`/Type /Page` objects). */
export function pdfStructure(bytes: Uint8Array): {
  header: string;
  pages: number;
} {
  const text = new TextDecoder("latin1").decode(bytes);
  const header = /^%PDF-\d\.\d/.exec(text)?.[0];
  if (!header) throw new Error("not a PDF: no %PDF- header");
  return {
    header,
    pages: (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length,
  };
}
