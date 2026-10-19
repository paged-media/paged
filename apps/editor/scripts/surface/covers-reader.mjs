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
import { basename, join } from "node:path";

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

function readRust(file, text, out) {
  if (!/covers/.test(text)) return;
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    const line = i + 1;
    const comment = /^\s*\/\/\s*covers:\s*(.+?)\s*$/.exec(l);
    if (comment) {
      const ids = comment[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      out.calls.push({ file, line, ids });
      return;
    }
    if (/macro_rules!\s*covers\b/.test(l)) return;
    const stripped = l.replace(/\/\/.*$/, "");
    const at = stripped.search(/\bcovers!\s*\(/);
    if (at < 0) return;
    // The call may span lines: read to the matching parenthesis.
    let rest = lines.slice(i).join("\n").slice(stripped.indexOf("covers!", at));
    const open = rest.indexOf("(");
    let depth = 0;
    let end = -1;
    let inStr = false;
    for (let k = open; k < rest.length; k++) {
      const ch = rest[k];
      if (inStr) {
        if (ch === "\\") k++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) {
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
      return;
    }
    const inner = rest.slice(open + 1, end);
    const ids = [];
    const parts = inner
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(p);
      if (!m) {
        out.errors.push({
          file,
          line,
          message: `covers! argument is not a string literal: ${p.slice(0, 40)}`,
        });
        continue;
      }
      ids.push(m[1].replace(/\\(.)/g, "$1"));
    }
    if (ids.length === 0 && parts.length === 0)
      out.errors.push({ file, line, message: "covers!() with no ids" });
    out.calls.push({ file, line, ids });
  });
}

/**
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
