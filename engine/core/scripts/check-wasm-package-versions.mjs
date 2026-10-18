#!/usr/bin/env node
// Every wasm package of the workspace, engine/core/packages/<pkg>/, is
// versioned 0.<PROTOCOL_VERSION>.0-dev, with PROTOCOL_VERSION read from
// crates/paged-canvas/src/channel.rs (ADR 185). The editor takes the wire
// protocol from @paged-media/canvas-wasm's version minor, so a protocol bump
// that leaves these versions behind runs the editor on the wrong number.
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
const PACKAGES = ["canvas-wasm", "introspect-wasm", "repo-wasm", "sdk"];
const write = process.argv.includes("--write");

const m = readFileSync(CHANNEL, "utf8").match(
  /pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion\((\d+)\)/,
);
if (!m) {
  console.error(`check-wasm-package-versions: cannot read PROTOCOL_VERSION from ${CHANNEL}`);
  process.exit(1);
}
const expected = `0.${m[1]}.0-dev`;

const present = readdirSync(SHELLS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SHELLS, e.name, "package.json")))
  .map((e) => e.name)
  .sort();
const problems = [];
let stale = false;
if (present.join(",") !== [...PACKAGES].sort().join(",")) {
  problems.push(`packages/ holds [${present.join(", ")}], expected [${PACKAGES.join(", ")}]`);
}

for (const pkg of PACKAGES) {
  const file = join(SHELLS, pkg, "package.json");
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  const manifest = JSON.parse(text);
  if (manifest.name !== `@paged-media/${pkg}`) {
    problems.push(`packages/${pkg}: name is ${manifest.name}, expected @paged-media/${pkg}`);
  }
  if (manifest.version === expected) continue;
  if (write) {
    // Replace the one field in place so the rest of the file stays as written.
    writeFileSync(file, text.replace(/("version":\s*)"[^"]*"/, `$1"${expected}"`));
    console.log(`packages/${pkg}: ${manifest.version} -> ${expected}`);
  } else {
    problems.push(`packages/${pkg}: version is ${manifest.version}, expected ${expected}`);
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
console.log(`check-wasm-package-versions: ${PACKAGES.length} packages at ${expected}`);
