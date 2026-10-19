#!/usr/bin/env bun
// The React Compiler coverage ratchet (apps/editor/docs/adr/229-react-compiler.md).
//
//   bun tooling/js/react-compiler-coverage.mjs            check (CI)
//   bun tooling/js/react-compiler-coverage.mjs --write    record the bailouts
//   bun tooling/js/react-compiler-coverage.mjs --json <file>
//                                                         also write the full
//                                                         report (every
//                                                         function, compiled
//                                                         or not)
//
// The compiler compiles every component and hook it can prove follows the
// Rules of React. One it cannot prove is left exactly as written, with no
// automatic memoization: a bailout. Builds never fail on one
// (`panicThreshold: "none"`), so without a record they would accumulate
// unseen.
//
// This runs the compiler with the build's own options
// (tooling/js/react-compiler.mjs) over every first-party React source and
// logs each function it considers. Each package with React code keeps
// `compiler-coverage.json` beside its package.json: the functions that bail
// out, with the compiler's reason. The check fails when
//   - a function bails out that the file does not list (a new bailout: fix
//     the code, the compiler's reason says what it could not prove);
//   - the file lists a bailout that no longer happens (run --write, so the
//     count only goes down);
//   - a `"use no memo"` directive has no issue link and expiry date next to
//     it, or its date has passed.
//   - a function that looks like a component or a hook is invisible to the
//     compiler (`notCompiled`: neither compiled nor a bailout).
// The target is zero bailouts.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cpus } from "node:os";

import {
  REPO_ROOT,
  compilerOptions,
  createCollector,
  functionNameAt,
  isReactSource,
  mayHoldReact,
  packageDirOf,
} from "./react-compiler.mjs";

const require = createRequire(import.meta.url);
const babel = require("@babel/core");
const PLUGIN = require.resolve("babel-plugin-react-compiler");
const COMPILER = `babel-plugin-react-compiler@${
  require("babel-plugin-react-compiler/package.json").version
}`;
const RECORD = "compiler-coverage.json";
const ADR = "apps/editor/docs/adr/229-react-compiler.md";

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const jsonAt = args.indexOf("--json");
const JSON_OUT = jsonAt >= 0 ? args[jsonAt + 1] : null;

// `"use no memo"` opts a function out. It is a debt with an owner and a
// date: the comment right above it names the issue and when it expires.
const OPT_OUT = /^\s*["']use no memo["'];?/;
const ISSUE = /https:\/\/github\.com\/paged-media\/paged\/issues\/\d+/;
const EXPIRES = /\bexpires (\d{4}-\d{2}-\d{2})\b/;

function sourceFiles() {
  return execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((f) => f && isReactSource(f));
}

/** Compile `code` with the build's options; returns the source AST. */
function compile(file, code, logger) {
  const filename = join(REPO_ROOT, file);
  const ast = babel.parseSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: {
      plugins: file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
    },
  });
  babel.transformFromAstSync(ast, code, {
    filename,
    babelrc: false,
    configFile: false,
    cloneInputAst: true,
    plugins: [[PLUGIN, compilerOptions({ logger })]],
    code: false,
    ast: false,
  });
  return ast;
}

// A component the compiler never looks at is neither compiled nor a
// bailout: it does not see a function as a component unless it can name
// it from a declaration, a variable, an assignment or an object key, or it
// is the argument of memo/forwardRef. `return function Panel() {…}` (a
// factory returning its component) is invisible to it. These are listed
// as `notCompiled` beside the bailouts, ratcheted the same way.
function looksLikeAComponent(path) {
  const t = babel.types;
  const parent = path.parentPath;
  let name = path.node.id?.name ?? null;
  if (!name && parent.isVariableDeclarator() && t.isIdentifier(parent.node.id))
    name = parent.node.id.name;
  if (!name || !/^(?:[A-Z]|use[A-Z0-9])/.test(name)) return null;
  let jsxOrHook = false;
  path.traverse({
    JSX() {
      jsxOrHook = true;
    },
    CallExpression(call) {
      const callee = call.node.callee;
      const called = t.isIdentifier(callee)
        ? callee.name
        : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
          ? callee.property.name
          : "";
      if (/^use[A-Z0-9]/.test(called)) jsxOrHook = true;
    },
    Function(inner) {
      if (inner.node !== path.node) inner.skip();
    },
  });
  return jsxOrHook ? name : null;
}

function notConsidered(ast, seenLines) {
  const out = [];
  babel.traverse(ast, {
    "FunctionDeclaration|FunctionExpression|ArrowFunctionExpression"(path) {
      const line = path.node.loc?.start.line;
      if (seenLines.has(line)) return;
      const name = looksLikeAComponent(path);
      if (name) out.push({ function: name, line });
    },
  });
  return out;
}

function optOutProblems(file, code) {
  const problems = [];
  const lines = code.split("\n");
  const today = new Date().toISOString().slice(0, 10);
  lines.forEach((text, i) => {
    if (!OPT_OUT.test(text)) return;
    const above = lines.slice(Math.max(0, i - 3), i).join("\n");
    const where = `${file}:${i + 1}`;
    if (!ISSUE.test(above)) {
      problems.push(
        `${where}: "use no memo" needs the issue it waits on in the comment above it (${ISSUE.source.replace(/\\/g, "")})`,
      );
    }
    const date = EXPIRES.exec(above)?.[1];
    if (!date) {
      problems.push(
        `${where}: "use no memo" needs an expiry date in the comment above it ("expires YYYY-MM-DD")`,
      );
    } else if (date < today) {
      problems.push(
        `${where}: "use no memo" expired on ${date}: fix the function, or renew it with a reason`,
      );
    }
  });
  return problems;
}

const started = Date.now();
const files = sourceFiles();
const packages = new Map(); // dir -> { compiled, bailouts: [] }
const report = [];
const problems = [];
let considered = 0;

for (const file of files) {
  const code = readFileSync(join(REPO_ROOT, file), "utf8");
  if (!mayHoldReact(file, code)) continue;
  considered++;
  problems.push(...optOutProblems(file, code));
  const { logger, files: logged } = createCollector();
  let ast;
  try {
    ast = compile(file, code, logger);
  } catch (err) {
    problems.push(`${file}: the compiler threw: ${err.message.split("\n")[0]}`);
    continue;
  }
  const entry = logged.get(join(REPO_ROOT, file)) ?? {
    compiled: [],
    bailouts: new Map(),
  };
  const seen = new Set([
    ...entry.compiled.map((c) => c.line),
    ...[...entry.bailouts.values()].map((b) => b.line),
  ]);
  const unseen = notConsidered(ast, seen);
  if (
    entry.compiled.length === 0 &&
    entry.bailouts.size === 0 &&
    !unseen.length
  )
    continue;
  const dir = packageDirOf(file, existsSync);
  if (!dir) continue;
  if (!packages.has(dir))
    packages.set(dir, { compiled: 0, bailouts: [], notCompiled: [] });
  const pkg = packages.get(dir);
  const inPackage = relative(dir, join(REPO_ROOT, file)).split("\\").join("/");
  pkg.compiled += entry.compiled.length;
  pkg.notCompiled.push(
    ...unseen.map((u) => ({ file: inPackage, function: u.function })),
  );
  const bailouts = [...entry.bailouts.values()]
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
    .map((b) => ({
      file: inPackage,
      function: functionNameAt(code, b.line),
      reason: b.categories.sort().join(", "),
      detail: b.reason,
    }));
  pkg.bailouts.push(...bailouts);
  report.push({
    file,
    compiled: entry.compiled,
    bailouts: [...entry.bailouts.values()],
  });
}

const key = (b) => `${b.file} ${b.function} [${b.reason}]`;
const nkey = (b) => `${b.file} ${b.function}`;

function multisetDiff(a, b, keyOf = key) {
  const counts = new Map();
  for (const x of b) counts.set(keyOf(x), (counts.get(keyOf(x)) ?? 0) + 1);
  const extra = [];
  for (const x of a) {
    const k = keyOf(x);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else extra.push(x);
  }
  return extra;
}

// Every package that has, or had, a record.
const recorded = execFileSync(
  "git",
  ["ls-files", "--", `${RECORD}`, `**/${RECORD}`],
  { cwd: REPO_ROOT, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .map((f) => join(REPO_ROOT, f, ".."));
const dirs = [...new Set([...packages.keys(), ...recorded])].sort();

const rows = [];
const totals = { compiled: 0, bailouts: 0, notCompiled: 0 };
for (const dir of dirs) {
  const rel = relative(REPO_ROOT, dir).split("\\").join("/");
  const pkg = packages.get(dir) ?? {
    compiled: 0,
    bailouts: [],
    notCompiled: [],
  };
  pkg.bailouts.sort((a, b) => key(a).localeCompare(key(b)));
  pkg.notCompiled.sort((a, b) => nkey(a).localeCompare(nkey(b)));
  const skipped = pkg.bailouts.length + pkg.notCompiled.length;
  totals.compiled += pkg.compiled;
  totals.bailouts += pkg.bailouts.length;
  totals.notCompiled += pkg.notCompiled.length;
  const all = pkg.compiled + skipped;
  rows.push([rel, pkg.compiled, pkg.bailouts.length, pkg.notCompiled.length]);
  const path = join(dir, RECORD);
  const next = {
    $comment: `The components and hooks of this package the React Compiler leaves uncompiled: its bailouts (it could not prove the Rules of React; the reason is its own) and the functions it cannot see as components (notCompiled). Written by tooling/js/react-compiler-coverage.mjs --write; CI fails on a new one, and the lists only get shorter (${ADR}).`,
    compiler: COMPILER,
    skipped,
    bailouts: pkg.bailouts,
    notCompiled: pkg.notCompiled,
  };
  if (WRITE) {
    if (all === 0 && !existsSync(path)) continue;
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    continue;
  }
  if (!existsSync(path)) {
    if (all > 0) {
      problems.push(
        `${rel}: has React code but no ${RECORD}; run tooling/js/react-compiler-coverage.mjs --write`,
      );
    }
    continue;
  }
  const prev = JSON.parse(readFileSync(path, "utf8"));
  for (const b of multisetDiff(pkg.bailouts, prev.bailouts ?? [])) {
    problems.push(
      `${rel}/${b.file}: ${b.function} is no longer compiled (${b.reason}: ${b.detail})`,
    );
  }
  for (const b of multisetDiff(pkg.notCompiled, prev.notCompiled ?? [], nkey)) {
    problems.push(
      `${rel}/${b.file}: ${b.function} looks like a component or hook but the compiler cannot see it (name it: a declaration, or \`const ${b.function} = …\`)`,
    );
  }
  const goneNot = multisetDiff(prev.notCompiled ?? [], pkg.notCompiled, nkey);
  if (goneNot.length > 0) {
    problems.push(
      `${rel}/${RECORD}: ${goneNot.length} recorded not-compiled function(s) are compiled or gone (${goneNot
        .map((b) => `${b.file} ${b.function}`)
        .join(", ")}); run tooling/js/react-compiler-coverage.mjs --write`,
    );
  }
  const gone = multisetDiff(prev.bailouts ?? [], pkg.bailouts);
  if (gone.length > 0) {
    problems.push(
      `${rel}/${RECORD}: ${gone.length} recorded bailout(s) no longer happen (${gone
        .map((b) => `${b.file} ${b.function}`)
        .join(
          ", ",
        )}); run tooling/js/react-compiler-coverage.mjs --write so the count goes down`,
    );
  }
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify({ compiler: COMPILER, files: report }, null, 2)}\n`,
  );
}

const width = Math.max(...rows.map((r) => r[0].length), 7);
const pct = (c, b, n) =>
  c + b + n ? `${((100 * c) / (c + b + n)).toFixed(1)}%` : "-";
const line = (p, c, b, n) =>
  `${p.padEnd(width)}  ${String(c).padStart(8)}  ${String(b).padStart(8)}  ${String(n).padStart(11)}  ${pct(c, b, n).padStart(8)}`;
console.log(
  [
    `${"package".padEnd(width)}  compiled  bailouts  not compiled  coverage`,
    ...rows.map((r) => line(...r)),
    line("all", totals.compiled, totals.bailouts, totals.notCompiled),
  ].join("\n"),
);
console.log(
  `${COMPILER}: ${considered} files in ${((Date.now() - started) / 1000).toFixed(1)} s (${cpus().length} cores)`,
);

if (problems.length > 0 && !WRITE) {
  console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
if (WRITE) {
  if (problems.length > 0) {
    console.error(`\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `wrote ${RECORD} for ${rows.filter((r) => r[1] + r[2] + r[3] > 0).length} packages`,
  );
}
