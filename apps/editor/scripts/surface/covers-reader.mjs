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

// Reads every `covers(...)` call in the repository's tests, statically,
// and attributes each to its LAYER from the file's path. The forms (the
// only ones counted) are in platform/shared/test-kit/README.md, "covers()":
//
//   TS / JS   covers("kind:id", …)   the kit's export or a local no-op
//   Rust      covers!("kind:id", …)  paged_test_resources::covers or a local macro
//   Rust      // covers: kind:id, kind:id   (a line comment)
//
// Every argument must be a string literal. Anything else is an ERROR the
// gate fails on: a call it cannot read must not pass as covering nothing.

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseSource, walkAst } from "./static-eval.mjs";

export const SURFACE_KINDS = [
  "command",
  "panel",
  "tool",
  "menu",
  "keybinding",
  "setting",
  "cli",
  "script",
  "importer",
  "exporter",
];

/** Directories never scanned for tests. */
const SKIP = /(^|\/)(node_modules|target|dist|\.moon|\.git|tooling\/import)\//;

/** Is `file` (repo-relative) a test file the gate reads? */
export function isTestFile(file, text) {
  if (SKIP.test(file)) return false;
  if (file.endsWith(".rs")) {
    if (/(^|\/)tests\//.test(file)) return true;
    return text !== undefined && /#\[cfg\(test\)\]|#\[test\]/.test(text);
  }
  if (!/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file)) return false;
  if (/\.d\.ts$/.test(file)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return true;
  if (/\.film\.ts$/.test(file)) return true;
  return /(^|\/)(test|tests|__tests__)\//.test(file);
}

const WORD_SCRIPT = /(^|[^a-z])(script|scripts|scripting)([^a-z]|$)/i;
const GESTURE_DSL =
  /\b(gestures|browserGestures|createGestureDsl|unitBackend|gestureEditor)\s*\(/;

/**
 * The layers a test file counts in: one TIER (`unit`, `component`,
 * `headless`, `e2e`, `rust`) and any of the TAGS (`golden`, `script`,
 * `gesture`).
 *
 * The repository's root tests (`tests/`, tests/README.md) are named by what
 * they are about (contracts, system, integration, fidelity), not by tier, so
 * their names carry it: a `*.headless.test.ts` runs on the headless editor,
 * and a `*.spec.ts` there is a Playwright spec (the editor's config runs it).
 */
export function layersOf(file, text = "") {
  const layers = new Set();
  const segments = file.split("/");
  const name = basename(file);
  if (file.endsWith(".rs")) layers.add("rust");
  else if (segments.includes("headless") || /\.headless\.test\./.test(name))
    layers.add("headless");
  else if (
    file.startsWith("apps/editor/apps/canvas/tests/") ||
    (file.startsWith("tests/") && /\.spec\.[cm]?[jt]sx?$/.test(name)) ||
    segments.includes("e2e") ||
    /\.e2e\.[cm]?[jt]sx?$/.test(name)
  )
    layers.add("e2e");
  else if (/\.dom\.test\.[cm]?[jt]sx?$/.test(name)) layers.add("component");
  else layers.add("unit");
  if (segments.some((s) => /golden/i.test(s))) layers.add("golden");
  if (segments.some((s) => WORD_SCRIPT.test(s))) layers.add("script");
  if (GESTURE_DSL.test(text)) layers.add("gesture");
  return layers;
}

const ID_SHAPE = /^([a-z]+):(.+)$/;

/** Normalise one id: `->` is read as `→` in keybindings. */
export function normaliseId(raw) {
  const m = ID_SHAPE.exec(raw);
  if (!m) return null;
  let [, kind, id] = m;
  if (kind === "keybinding")
    id = id.replace(/\s*->\s*/, "→").replace(/\s*→\s*/, "→");
  return { kind, id: id.trim() };
}

/** The literal value of a string-literal argument, or null. */
function literal(arg) {
  if (arg.type === "StringLiteral") return arg.value;
  if (arg.type === "TemplateLiteral" && arg.expressions.length === 0)
    return arg.quasis[0].value.cooked ?? arg.quasis[0].value.raw;
  return null;
}

function readTs(file, text, out) {
  if (!/\bcovers\s*\(/.test(text)) return;
  let program;
  try {
    program = parseSource(text, file).program;
  } catch (e) {
    out.errors.push({ file, line: 0, message: `cannot parse (${e.message})` });
    return;
  }
  walkAst(program, (n) => {
    if (n.type !== "CallExpression" && n.type !== "OptionalCallExpression")
      return;
    if (n.callee.type !== "Identifier" || n.callee.name !== "covers") return;
    const line = n.loc?.start.line ?? 0;
    if (n.arguments.length === 0) {
      out.errors.push({ file, line, message: "covers() with no ids" });
      return;
    }
    const ids = [];
    for (const a of n.arguments) {
      const v = literal(a);
      if (v === null) {
        out.errors.push({
          file,
          line,
          message:
            `covers() argument is not a string literal (${a.type}); the gate reads ` +
            "the calls statically, so write each id out",
        });
        continue;
      }
      ids.push(v);
    }
    out.calls.push({ file, line, ids });
  });
}

/**
 * The Rust source with comments blanked to spaces and the insides of
 * string, raw-string and char literals blanked to \u0001, same length and
 * same line breaks. A `covers!(` or `// covers:` inside a string (a test
 * that FORMATS the form, say) is then not a call.
 */
export function rustCode(src) {
  const out = [];
  const n = src.length;
  const ident = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  const blank = (from, to, fill) => {
    for (let k = from; k < to; k++) out.push(src[k] === "\n" ? "\n" : fill);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      blank(i, j, " ");
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") (depth++, (j += 2));
        else if (src[j] === "*" && src[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      blank(i, j, " ");
      i = j;
      continue;
    }
    if (
      c === "r" &&
      !ident(src[i - 1]) &&
      (src[i + 1] === '"' || src[i + 1] === "#")
    ) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === "#") (hashes++, j++);
      if (src[j] === '"') {
        const close = `"${"#".repeat(hashes)}`;
        let end = src.indexOf(close, j + 1);
        if (end < 0) end = n;
        out.push(...src.slice(i, j + 1));
        blank(j + 1, end, "\u0001");
        out.push(...src.slice(end, end + close.length));
        i = end + close.length;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out.push('"');
      blank(i + 1, Math.min(j, n), "\u0001");
      if (j < n) out.push('"');
      i = j + 1;
      continue;
    }
    if (c === "'") {
      // A char literal ('x', '\n', '\''), or a lifetime ('a): only the
      // literal is blanked.
      const m = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'])'/.exec(
        src.slice(i, i + 12),
      );
      if (m) {
        out.push("'");
        blank(i + 1, i + m[0].length - 1, "\u0001");
        out.push("'");
        i += m[0].length;
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

function readRust(file, text, out) {
  if (!/covers/.test(text)) return;
  const code = rustCode(text);
  const found = [];
  const lineOf = (offset) => text.slice(0, offset).split("\n").length;
  // The comment form: a line that is a comment (blank in `code`).
  const lines = text.split("\n");
  const codeLines = code.split("\n");
  lines.forEach((l, i) => {
    const m = /^\s*\/\/\s*covers:\s*(.+?)\s*$/.exec(l);
    if (!m || codeLines[i].trim() !== "") return;
    const ids = m[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    found.push({ file, line: i + 1, ids });
  });
  // The macro form: `covers!(` in code, its arguments read from the text.
  for (const m of code.matchAll(/\bcovers!\s*\(/g)) {
    const line = lineOf(m.index);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let k = open; k < code.length; k++) {
      if (code[k] === "(") depth++;
      else if (code[k] === ")" && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end < 0) {
      out.errors.push({
        file,
        line,
        message: "covers!( without a closing parenthesis",
      });
      continue;
    }
    const inner = text.slice(open + 1, end);
    const ids = [];
    const parts = inner
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const p of parts) {
      const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(p);
      if (!lit) {
        out.errors.push({
          file,
          line,
          message: `covers! argument is not a string literal: ${p.slice(0, 40)}`,
        });
        continue;
      }
      ids.push(lit[1].replace(/\\(.)/g, "$1"));
    }
    if (parts.length === 0)
      out.errors.push({ file, line, message: "covers!() with no ids" });
    found.push({ file, line, ids });
  }
  // In source order, whichever form each call takes.
  out.calls.push(...found.sort((a, b) => a.line - b.line));
}

const helperDrives = new Map();

/** Does a test file drive the gesture DSL through a local helper it
 *  imports (`harness()` in a `test/support.ts` that calls `gestures(…)`)?
 *  One level of relative imports, which is how the suites share a harness. */
function drivesGesturesThroughImport(root, file, text) {
  for (const m of text.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = join(dirname(join(root, file)), m[1]);
    const stripped = base.replace(/\.(js|mjs|jsx)$/, "");
    for (const cand of [
      base,
      `${stripped}.ts`,
      `${stripped}.tsx`,
      join(base, "index.ts"),
    ]) {
      if (!helperDrives.has(cand)) {
        let drives = false;
        try {
          drives = GESTURE_DSL.test(readFileSync(cand, "utf8"));
        } catch {
          drives = false;
        }
        helperDrives.set(cand, drives);
      }
      if (helperDrives.get(cand)) return true;
    }
  }
  return false;
}

/**
 * Read `files` (repo-relative)./**
 * Read `files` (repo-relative). Returns `{ calls, errors, testFiles,
 * mentionText }`: each call with its ids and layers; every unreadable or
 * malformed call; the test files read; and their concatenated text for
 * the secondary "mentioned" signal.
 */
export function readCovers(root, files, options = {}) {
  const { candidates = null, keepTexts = true } = options;
  const out = { calls: [], errors: [], testFiles: [], texts: new Map() };
  for (const file of files) {
    if (SKIP.test(file)) continue;
    const isRust = file.endsWith(".rs");
    const isJs = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file);
    if (!isRust && !isJs) continue;
    // Reading is the cost on a slow disk. With a candidate list (the files
    // `git grep` found a covers form in), a file outside it is read only
    // when its text is wanted for the "mentioned" signal.
    if (candidates && !candidates.has(file)) {
      if (!keepTexts) {
        if (isTestFile(file)) out.testFiles.push(file);
        continue;
      }
      if (!isTestFile(file) && !(isRust && /(^|\/)src\//.test(file))) continue;
    }
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const test = isTestFile(file, text);
    if (!test) {
      // A covers() outside a test file counts nothing; say so.
      if (isJs && /\bcovers\s*\(\s*["'`][a-z]+:/.test(text)) {
        // Only a real call counts (comments and strings are not calls).
        const probe = { calls: [], errors: [] };
        readTs(file, text, probe);
        for (const c of probe.calls)
          out.errors.push({
            file,
            line: c.line,
            message: "covers() in a file that is not a test file",
          });
      }
      if (
        isRust &&
        /\bcovers!\s*\(\s*"[a-z]+:/.test(text) &&
        !/test-resources\/src\//.test(file)
      )
        out.errors.push({
          file,
          line: 0,
          message: "covers! in a file that is not a test file",
        });
      continue;
    }
    out.testFiles.push(file);
    if (keepTexts) out.texts.set(file, text);
    const before = out.calls.length;
    if (isRust) readRust(file, text, out);
    else readTs(file, text, out);
    const layers = layersOf(file, text);
    if (!layers.has("gesture") && drivesGesturesThroughImport(root, file, text))
      layers.add("gesture");
    for (let i = before; i < out.calls.length; i++)
      out.calls[i].layers = layers;
  }
  // Ids: shape and kind.
  for (const c of out.calls) {
    c.parsed = [];
    for (const raw of c.ids) {
      const p = normaliseId(raw);
      if (!p || !SURFACE_KINDS.includes(p.kind)) {
        out.errors.push({
          file: c.file,
          line: c.line,
          message: `"${raw}" is not <kind>:<id> with a known kind (${SURFACE_KINDS.join(", ")})`,
        });
        continue;
      }
      c.parsed.push(p);
    }
  }
  return out;
}
