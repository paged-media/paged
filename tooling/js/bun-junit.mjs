#!/usr/bin/env bun
// bun test's JUnit report, in the shape vitest's had.
//
//   bun tooling/js/bun-junit.mjs [--out FILE] <junit.xml>...
//
// The CI lanes upload their unit-test JUnit as evidence, and the feature
// registry maps tests by the vitest shape: one <testsuite> per spec file,
// every <testcase> with `classname` = the spec path (relative to the
// package) and `name` = the describe chain and the title joined by " > ".
// bun test nests a <testsuite> per describe block instead, keeps the path
// only in a `file` attribute, and sets `classname` to the describe chain in
// reverse. This script rewrites each report into the vitest shape, so the
// test ids (and everything keyed on them) stay the same across the runner
// change. Plain JavaScript, no dependencies: it runs under Bun or Node.
//
// Each input becomes one XML document; several are concatenated (the
// lanes' `junit-all.xml` always was). Exits 1 if an input has no testcase.

import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

const args = process.argv.slice(2);
let out;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else inputs.push(args[i]);
}
if (inputs.length === 0) {
  console.error("usage: bun-junit.mjs [--out FILE] <junit.xml>...");
  process.exit(2);
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENTITIES[e] ?? m),
  );
// vitest's escapeXML: the five entities, then the characters XML 1.0 forbids
// (and the ones it discourages) are dropped, not escaped. bun writes them
// raw, which no XML parser accepts. Newlines stay raw, as vitest left them.
const INVALID =
  /([\0-\x08\v\f\x0E-\x1F\uFFFD\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/g;
const DISCOURAGED = new RegExp(
  "([\\x7F-\\x84]|[\\x86-\\x9F]|[\\uFDD0-\\uFDEF]|\\uD83F[\\uDFFE\\uDFFF]|(?:\\uD87F[\\uDFFE\\uDFFF])|\\uD8BF[\\uDFFE\\uDFFF]|\\uD8FF[\\uDFFE\\uDFFF]|(?:\\uD93F[\\uDFFE\\uDFFF])|\\uD97F[\\uDFFE\\uDFFF]|\\uD9BF[\\uDFFE\\uDFFF]|\\uD9FF[\\uDFFE\\uDFFF]|\\uDA3F[\\uDFFE\\uDFFF]|\\uDA7F[\\uDFFE\\uDFFF]|\\uDABF[\\uDFFE\\uDFFF]|(?:\\uDAFF[\\uDFFE\\uDFFF])|\\uDB3F[\\uDFFE\\uDFFF]|\\uDB7F[\\uDFFE\\uDFFF]|(?:\\uDBBF[\\uDFFE\\uDFFF])|\\uDBFF[\\uDFFE\\uDFFF](?:[\\0-\\t\\v\\f\\x0E-\\u2027\\u202A-\\uD7FF\\uE000-\\uFFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?:[^\\uD800-\\uDBFF]|^)[\\uDC00-\\uDFFF]))",
  "g",
);
const encode = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(INVALID, "")
    .replace(DISCOURAGED, "");
const attrs = (tag) => {
  const a = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) a[m[1]] = decode(m[2]);
  return a;
};

/** Every testcase of one bun report: { file, chain, name, time, body }. */
function parse(xml) {
  const cases = [];
  const stack = []; // open <testsuite> attrs, outermost first
  const TOKEN =
    /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)\/>|<testcase\b([^>]*?)>([\s\S]*?)<\/testcase>/g;
  for (const m of xml.matchAll(TOKEN)) {
    if (m[0].startsWith("</testsuite")) stack.pop();
    else if (m[0].startsWith("<testsuite")) {
      if (!m[2]) stack.push(attrs(m[1]));
    } else {
      const a = attrs(m[3] ?? m[4]);
      const fileSuite = stack[0] ?? {};
      cases.push({
        file: a.file ?? fileSuite.file ?? fileSuite.name ?? "",
        chain: stack.slice(1).map((s) => s.name),
        name: a.name ?? "",
        time: a.time ?? "0",
        body: (m[5] ?? "").trim().replace(INVALID, "").replace(DISCOURAGED, ""),
      });
    }
  }
  return cases;
}

function render(cases) {
  const files = new Map();
  for (const c of cases) {
    if (!files.has(c.file)) files.set(c.file, []);
    files.get(c.file).push(c);
  }
  const status = (c) =>
    /<(failure|error)\b/.test(c.body)
      ? "failed"
      : /<skipped\b/.test(c.body)
        ? "skipped"
        : "passed";
  const count = (cs, s) => cs.filter((c) => status(c) === s).length;
  const seconds = (cs) => cs.reduce((t, c) => t + Number(c.time || 0), 0);
  const host = hostname();
  const stamp = new Date().toISOString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" ?>',
    `<testsuites name="bun test" tests="${cases.length}" failures="${count(cases, "failed")}" errors="0" skipped="${count(cases, "skipped")}" time="${seconds(cases).toFixed(6)}">`,
  ];
  for (const [file, cs] of files) {
    lines.push(
      `    <testsuite name="${encode(file)}" timestamp="${stamp}" hostname="${encode(host)}" tests="${cs.length}" failures="${count(cs, "failed")}" errors="0" skipped="${count(cs, "skipped")}" time="${seconds(cs).toFixed(6)}">`,
    );
    for (const c of cs) {
      const name = [...c.chain, c.name].join(" > ");
      const open = `        <testcase classname="${encode(file)}" name="${encode(name)}" time="${c.time}"`;
      lines.push(
        c.body
          ? `${open}>\n            ${c.body}\n        </testcase>`
          : `${open}>\n        </testcase>`,
      );
    }
    lines.push("    </testsuite>");
  }
  lines.push("</testsuites>");
  return lines.join("\n") + "\n";
}

let failed = false;
const docs = inputs.map((path) => {
  const cases = parse(readFileSync(path, "utf8"));
  if (cases.length === 0) {
    console.error(`bun-junit: ${path} has no testcase`);
    failed = true;
  }
  return render(cases);
});
if (out) writeFileSync(out, docs.join(""));
else process.stdout.write(docs.join(""));
process.exit(failed ? 1 : 0);
