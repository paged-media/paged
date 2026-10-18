#!/usr/bin/env node
// The engine's npm packages in the workspace are versioned
// 0.<PROTOCOL_VERSION>.0-dev, with PROTOCOL_VERSION read from
// crates/paged-canvas/src/channel.rs (ADR 185): @paged-media/canvas-wasm
// (packages/canvas-wasm/, which carries the canvas, introspection and
// repository wasm) and @paged-media/idml-viewer (web/idml-viewer/, which
// carries the viewer session wasm), PM-0008. The editor takes the wire
// protocol from canvas-wasm's version minor, so a protocol bump that leaves
// these versions behind runs the editor on the wrong number.
//
//   node scripts/check-wasm-package-versions.mjs          # check; exit 1 on a mismatch
//   node scripts/check-wasm-package-versions.mjs --write  # set them (after a protocol bump)
//
// After --write, `bun install` updates bun.lock, which records each workspace
// package's version.
//
// Plain Node (no dependencies), so CI runs it without an install.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = join(CORE, "crates/paged-canvas/src/channel.rs");
const SHELLS = join(CORE, "packages");
// directory (relative to engine/core) -> package name
const PACKAGES = {
  "packages/canvas-wasm": "@paged-media/canvas-wasm",
  "web/idml-viewer": "@paged-media/idml-viewer",
};
const write = process.argv.includes("--write");

const m = readFileSync(CHANNEL, "utf8").match(
  /pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion\((\d+)\)/,
);
if (!m) {
  console.error(
    `check-wasm-package-versions: cannot read PROTOCOL_VERSION from ${CHANNEL}`,
  );
  process.exit(1);
}
const expected = `0.${m[1]}.0-dev`;

// packages/ holds canvas-wasm only: introspect-wasm, repo-wasm and sdk are
// entry points of the two public packages now, never packages of their own.
const present = readdirSync(SHELLS, { withFileTypes: true })
  .filter(
    (e) => e.isDirectory() && existsSync(join(SHELLS, e.name, "package.json")),
  )
  .map((e) => `packages/${e.name}`)
  .sort();
const shells = Object.keys(PACKAGES).filter((d) => d.startsWith("packages/"));
const problems = [];
let stale = false;
if (present.join(",") !== shells.sort().join(",")) {
  problems.push(
    `packages/ holds [${present.join(", ")}], expected [${shells.join(", ")}]`,
  );
}

for (const [dir, name] of Object.entries(PACKAGES)) {
  const file = join(CORE, dir, "package.json");
  if (!existsSync(file)) {
    problems.push(`${dir}: package.json is missing`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  const manifest = JSON.parse(text);
  if (manifest.name !== name) {
    problems.push(`${dir}: name is ${manifest.name}, expected ${name}`);
  }
  if (manifest.version === expected) continue;
  if (write) {
    // Replace the one field in place so the rest of the file stays as written.
    writeFileSync(
      file,
      text.replace(/("version":\s*)"[^"]*"/, `$1"${expected}"`),
    );
    console.log(`${dir}: ${manifest.version} -> ${expected}`);
  } else {
    problems.push(
      `${dir}: version is ${manifest.version}, expected ${expected}`,
    );
    stale = true;
  }
}

if (problems.length) {
  for (const p of problems) console.error(`check-wasm-package-versions: ${p}`);
  if (stale) {
    console.error(
      `PROTOCOL_VERSION is ${m[1]}: run \`node engine/core/scripts/check-wasm-package-versions.mjs --write\`,` +
        " then `bun install` (bun.lock records the workspace versions).",
    );
  }
  process.exit(1);
}
console.log(
  `check-wasm-package-versions: ${Object.keys(PACKAGES).length} packages at ${expected}`,
);
