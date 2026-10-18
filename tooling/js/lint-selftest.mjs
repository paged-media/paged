#!/usr/bin/env bun
// Proves that the lint config's boundaries fire, and that the allowed imports
// stay allowed.
//
//   bun tooling/js/lint-selftest.mjs        (or: bun run lint:selftest)
//
// A boundary is only as good as its enforcement, and an enforcement rule is
// only trustworthy if it FIRES. A rule that silently stopped matching (a
// renamed directory, a glob typo, a Bun upgrade that reads the config
// differently) would pass every clean run. So each case below feeds a small
// source to `bun lint --stdin` under a SYNTHETIC file path. The path selects
// the [[lint.overrides]] entries of /bunfig.toml as a real file there would,
// without the file existing, so the real config is exercised end to end and
// there is no second copy of the rules to drift.
//
// The cases cover:
//   - the editor's four zones (apps/editor ADR 206), from the fixtures in
//     lint-selftest/ (moved from the editor's ESLint self-test);
//   - the built-in module contract (docs/adr/PM-0002): every module's
//     allow-list, its test-file exemption, and imports it must not make;
//   - the extension contract: platform/extensions imports only the public
//     packages, never platform/shared/*, a module or the editor;
//   - every package under platform/shared/*, read from disk: allowed in a
//     module, forbidden in an extension, so a new shared package that the
//     config does not list fails here;
//   - the Rules of React and a correctness rule, so the rule set is on.
//
// Exits 1 if any expectation is unmet.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "tooling", "js", "lint-selftest");
const BUN_LINT = join(ROOT, "tooling", "js", "bun-canary.sh");
const RESTRICTED = "no-restricted-imports";

const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const importOf = (spec) =>
  `import * as m from "${spec}";\nexport const ok = m;\n`;

/**
 * @typedef {{ name: string, path: string, source: string, rule?: string, fires: boolean }} Case
 * `rule` defaults to no-restricted-imports; `fires` is whether it must report.
 */

/** @type {Case[]} */
const cases = [];
const add = (name, path, source, fires, rule = RESTRICTED) =>
  cases.push({ name, path, source, rule, fires });

// --- the editor's zones ------------------------------------------------------
const WORKER = "apps/editor/apps/canvas/src/worker/__fixture__.ts";
const CLIENT = "apps/editor/packages/client/src/__fixture__.ts";
const TOOLS = "apps/editor/packages/tools/src/__fixture__.ts";
const APP = "apps/editor/apps/canvas/src/__fixture__.ts";
const SHELL = "apps/editor/packages/shell/src/__fixture__.ts";

add(
  "editor (a): worker imports the @paged-media/shell barrel",
  WORKER,
  fixture("editor-zone-a-worker-shell.fixture.txt"),
  true,
);
add(
  "editor (a): worker imports react",
  WORKER,
  fixture("editor-zone-a-worker-react.fixture.txt"),
  true,
);
add(
  "editor (b): packages/client imports react",
  CLIENT,
  fixture("editor-zone-b-client-react.fixture.txt"),
  true,
);
add(
  "editor (c): app deep-imports @paged-media/shell/components/ui/*",
  APP,
  fixture("editor-zone-c-deep-shell-internals.fixture.txt"),
  true,
);
add(
  "editor (d): app deep-imports the gesture spine",
  APP,
  fixture("editor-zone-d-gesture-spine.fixture.txt"),
  true,
);
add(
  "editor (d): packages/tools deep-imports the gesture spine (allowed)",
  TOOLS,
  fixture("editor-zone-d-gesture-spine.fixture.txt"),
  false,
);
add(
  "editor (d): packages/client deep-imports the gesture spine (allowed)",
  CLIENT,
  importOf("@paged-media/client/sab/gesture"),
  false,
);
add(
  "editor: worker imports the @paged-media/client barrel (allowed)",
  WORKER,
  importOf("@paged-media/client"),
  false,
);
add(
  "editor: app imports the @paged-media/shell barrel (allowed)",
  APP,
  importOf("@paged-media/shell"),
  false,
);
add(
  "editor (c): the shell imports its own internals (allowed)",
  SHELL,
  importOf("@paged-media/shell/components/ui/button"),
  false,
);
add(
  "editor (a): worker deep-imports shell internals",
  WORKER,
  importOf("@paged-media/shell/src/state/x"),
  true,
);

// --- the built-in modules ----------------------------------------------------
// Each module's allow-list (what the deleted scripts/check-contract-imports.mjs
// allowed), plus the shared packages: `own` are this module's packages,
// `extra` the third-party packages only this module may import.
const MODULES = [
  {
    name: "data",
    dir: "modules/data/packages/data-bundle",
    own: ["@paged-media/data-host-model"],
    extra: ["@duckdb/duckdb-wasm", "apache-arrow"],
  },
  {
    name: "doc",
    dir: "modules/doc/packages/doc-bundle",
    own: ["@paged-media/doc-host-model", "@paged-media/doc"],
    extra: [],
  },
  {
    name: "draw",
    dir: "modules/draw/packages/draw-bundle",
    own: ["@paged-media/draw-geometry", "@paged-media/draw-tools"],
    extra: [],
  },
  {
    name: "image",
    dir: "modules/image/glue",
    own: ["@paged-media/image-manifest"],
    extra: [],
  },
  {
    name: "publish",
    dir: "modules/publish/packages/pdf-bundle",
    own: ["@paged-media/publish", "@paged-media/pdf"],
    extra: ["jszip"],
  },
  {
    name: "sheet",
    dir: "modules/sheet/packages/sheet-bundle",
    own: ["@paged-media/sheet-host-model"],
    extra: [],
  },
  {
    name: "slide",
    dir: "modules/slide/packages/slide-bundle",
    own: ["@paged-media/slide"],
    extra: [],
  },
  {
    name: "web",
    dir: "modules/web/packages/web-bundle",
    own: ["@paged-media/web-model"],
    extra: [],
  },
];
const CONTRACT = [
  "@paged-media/plugin-api",
  "@paged-media/plugin-api/manifest",
  "@paged-media/plugin-sdk",
  "@paged-media/plugin-sdk/harness",
];
const REACT = ["react", "react/jsx-runtime", "react-dom"];

for (const m of MODULES) {
  const src = `${m.dir}/src/__fixture__.ts`;
  for (const spec of [
    ...CONTRACT,
    ...REACT,
    ...m.own,
    ...m.extra,
    "./sibling",
    "../parent",
  ]) {
    add(`${m.name}: imports ${spec} (allowed)`, src, importOf(spec), false);
  }
  const foreign = MODULES.find((o) => o !== m).own[0];
  for (const spec of [
    "@paged-media/shell",
    "@paged-media/client",
    "@paged-media/ui",
    "@paged-media/catalog",
    "@paged-media/tools",
    foreign,
    "@paged-media/plugin-apix",
    "reactive-lib",
    "lodash",
  ]) {
    add(`${m.name}: imports ${spec}`, src, importOf(spec), true);
  }
  if (m.name !== "publish")
    add(
      `${m.name}: imports jszip (only publish may)`,
      src,
      importOf("jszip"),
      true,
    );
  add(
    `${m.name}: re-exports from @paged-media/shell`,
    src,
    'export { PagedShell } from "@paged-media/shell";\n',
    true,
  );
  add(
    `${m.name}: type-only import of @paged-media/client`,
    src,
    'import type { CanvasClient } from "@paged-media/client";\nexport type T = CanvasClient;\n',
    true,
  );
  add(
    `${m.name}: side-effect import of @paged-media/shell`,
    src,
    'import "@paged-media/shell";\n',
    true,
  );
  // The deleted scripts skipped test files and anything outside src/.
  add(
    `${m.name}: a .test.ts imports @paged-media/shell (tests exempt)`,
    `${m.dir}/src/__fixture__.test.ts`,
    importOf("@paged-media/shell"),
    false,
  );
  add(
    `${m.name}: a .spec.ts imports @paged-media/shell (tests exempt)`,
    `${m.dir}/src/__fixture__.spec.ts`,
    importOf("@paged-media/shell"),
    false,
  );
  add(
    `${m.name}: a script outside src/ imports @paged-media/shell (not in the zone)`,
    `${m.dir}/scripts/__fixture__.ts`,
    importOf("@paged-media/shell"),
    false,
  );
}

// --- the extension contract --------------------------------------------------
const EXTENSIONS = [
  "platform/extensions/packages/plugin-sdk/src/__fixture__.ts",
  "platform/extensions/packages/plugin-api/src/__fixture__.ts",
  "platform/extensions/packages/plugin-sdk/test/__fixture__.test.ts",
  "platform/extensions/scripts/__fixture__.mjs",
];
for (const path of EXTENSIONS) {
  for (const spec of [
    "@paged-media/plugin-api",
    "@paged-media/plugin-sdk/harness",
    "@paged-media/canvas-wasm",
    "@paged-media/idml-viewer",
    "@paged-media/ai",
    "react",
    "node:fs",
    "./sibling",
  ]) {
    add(
      `extensions (${path.split("/").slice(2, 4).join("/")}): imports ${spec} (allowed)`,
      path,
      importOf(spec),
      false,
    );
  }
  for (const spec of [
    "@paged-media/shell",
    "@paged-media/client",
    "@paged-media/draw-geometry",
    "@paged-media/sheet",
    "@paged-media/web-model",
  ]) {
    add(
      `extensions (${path.split("/").slice(2, 4).join("/")}): imports ${spec}`,
      path,
      importOf(spec),
      true,
    );
  }
}

// --- platform/shared/*, read from disk ----------------------------------------
const sharedDir = join(ROOT, "platform", "shared");
const shared = existsSync(sharedDir)
  ? readdirSync(sharedDir)
      .filter((d) => existsSync(join(sharedDir, d, "package.json")))
      .map(
        (d) =>
          JSON.parse(readFileSync(join(sharedDir, d, "package.json"), "utf8"))
            .name,
      )
  : [];
for (const name of shared) {
  for (const m of MODULES)
    add(
      `${m.name}: imports the shared ${name} (allowed)`,
      `${m.dir}/src/__fixture__.ts`,
      importOf(name),
      false,
    );
  for (const path of EXTENSIONS)
    add(`extensions: imports the shared ${name}`, path, importOf(name), true);
}

// --- the rule set is on ---------------------------------------------------------
const COMPONENT = "apps/editor/packages/shell/src/__fixture__.tsx";
add(
  "Rules of React: a hook called conditionally",
  COMPONENT,
  'import { useState } from "react";\nexport function C({ on }: { on: boolean }) {\n  if (on) useState(0);\n  return null;\n}\n',
  true,
  "react-hooks/rules-of-hooks",
);
add(
  "Rules of React: an impure call during render",
  COMPONENT,
  "export function C() {\n  const r = Math.random();\n  return <p>{r}</p>;\n}\n",
  true,
  "react-hooks/purity",
);
add(
  "Rules of React: a missing effect dependency",
  COMPONENT,
  'import { useEffect } from "react";\nexport function C({ x }: { x: number }) {\n  useEffect(() => { console.log(x); }, []);\n  return null;\n}\n',
  true,
  "react-hooks/exhaustive-deps",
);
add(
  "Rules of React: a pure component (allowed)",
  COMPONENT,
  'import { useState } from "react";\nexport function C() {\n  const [n] = useState(0);\n  return <p>{n}</p>;\n}\n',
  false,
  "react-hooks/rules-of-hooks",
);
add(
  "correctness: a debugger statement in a module",
  "modules/draw/packages/draw-tools/src/__fixture__.ts",
  "export function f() {\n  debugger;\n}\n",
  true,
  "no-debugger",
);

// --- run -------------------------------------------------------------------------
const ruleOf = (id) => (id ?? "").replace(/^@typescript-eslint\//, "");

function lint(c) {
  return new Promise((resolve) => {
    const child = spawn(
      BUN_LINT,
      [
        "lint",
        "--no-script",
        "--stdin",
        "--stdin-filename",
        join(ROOT, c.path),
        "--format",
        "json",
      ],
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(c.source);
  });
}

async function check(c) {
  const { code, out, err } = await lint(c);
  let results;
  try {
    results = JSON.parse(out);
  } catch {
    return `bun lint exited ${code} without a JSON report:\n${err || out}`;
  }
  const messages = results.flatMap((r) => r.messages);
  const broken = messages.filter((m) => m.ruleId == null);
  if (code === 2 || broken.length > 0) {
    return `the file was not linted (exit ${code}): ${broken.map((m) => m.message).join("; ") || err}`;
  }
  const fired = messages.some((m) => ruleOf(m.ruleId) === c.rule);
  if (fired === c.fires) return null;
  const seen = messages
    .map((m) => `[${m.ruleId}] ${m.message.split("\n")[0]}`)
    .join("\n        ");
  return `expected ${c.rule} to ${c.fires ? "FIRE" : "stay silent"}, but it ${fired ? "fired" : "did not"}${seen ? `\n        ${seen}` : ""}`;
}

const failures = [];
const queue = cases.map((c, i) => [c, i]);
const outcome = new Array(cases.length);
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [c, i] = next;
      outcome[i] = await check(c);
    }
  }),
);
cases.forEach((c, i) => {
  if (outcome[i]) {
    failures.push(c);
    console.error(`FAIL ${c.name} (${c.path})\n      ${outcome[i]}`);
  } else {
    console.log(
      `ok   ${c.name}: ${c.rule} ${c.fires ? "fired" : "stayed silent"}`,
    );
  }
});

const firing = cases.filter((c) => c.fires).length;
if (failures.length > 0) {
  console.error(
    `\n${failures.length} of ${cases.length} lint self-test expectations unmet.`,
  );
  process.exit(1);
}
console.log(
  `\nAll ${cases.length} lint self-test expectations met (${firing} must fire, ${cases.length - firing} must stay silent; shared packages: ${shared.join(", ") || "none"}).`,
);
