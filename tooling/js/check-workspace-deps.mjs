#!/usr/bin/env node
// Every first-party dependency goes through the workspace.
//
//   bun tooling/js/check-workspace-deps.mjs
//
// The packages of the root Bun workspace (/package.json `workspaces`) reach
// each other through `workspace:` specifiers, and nothing first-party is
// installed from npm (docs/adr/PM-0005). Two checks, plain Node and no
// install needed:
//
//   1. Every dependency, devDependency, peerDependency and
//      optionalDependency in a tracked package.json that names a workspace
//      package uses `workspace:`.
//   2. Every entry of /bun.lock for a workspace package's name resolves to
//      the workspace (`<name>@workspace:<dir>`), never to a registry version.
//
// Exits 1 and lists every offender when either fails.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const manifests = execFileSync(
  "git",
  ["ls-files", "--", "package.json", "**/package.json"],
  {
    cwd: ROOT,
    encoding: "utf8",
  },
)
  .split("\n")
  .filter(Boolean);

const read = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));
const names = new Set(manifests.map((f) => read(f).name).filter(Boolean));

const problems = [];
for (const file of manifests) {
  const pkg = read(file);
  for (const field of FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (names.has(name) && !String(spec).startsWith("workspace:")) {
        problems.push(
          `${file}: ${field}.${name} is "${spec}", not a workspace: specifier`,
        );
      }
    }
  }
}

// bun.lock is JSON with trailing commas. A `packages` entry is
// `"<key>": ["<name>@<resolution>", ...]`; its first string says where the
// package came from.
const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
for (const [, ident] of lock.matchAll(
  /^\s+"[^"]+": \["((?:@[^@"/]+\/)?[^@"]+@[^"]*)"/gm,
)) {
  const at = ident.indexOf("@", 1);
  const name = ident.slice(0, at);
  if (names.has(name) && !ident.slice(at + 1).startsWith("workspace:")) {
    problems.push(
      `bun.lock: ${ident} resolves a workspace package from the registry`,
    );
  }
}

if (problems.length) {
  console.error(
    "check-workspace-deps: first-party packages must come from the workspace:",
  );
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `check-workspace-deps: OK — ${manifests.length} manifests, ${names.size} workspace packages, every first-party dependency through the workspace`,
);
