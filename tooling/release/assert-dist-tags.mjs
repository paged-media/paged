#!/usr/bin/env node
// The dist-tag assertion of a release (PM-0008): after release.yml publishes,
// npm must serve the release from the dist-tag it was published under, for
// each of the four public packages.
//
//   node tooling/release/assert-dist-tags.mjs <version> <dist-tag>
//   node tooling/release/assert-dist-tags.mjs --audit
//
// - `<dist-tag>` (latest for a release, next for a prerelease) points at
//   <version>. The registry can take a little while to show a fresh publish,
//   so this asks again for up to two minutes before it fails.
// - `latest` never points at a prerelease (a bare `npm install` would hand it
//   out). A prerelease release publishes under `next` and leaves `latest` as
//   it found it, so there this is a warning; a release to `latest` sets it,
//   and the first one corrects the June 0.2.8-canary.0 of plugin-api and
//   plugin-sdk.
// - A `canary` dist-tag is left over from the canary lane the release workflow
//   replaced; the owner removes it (docs/migration/npm-release-runbook.md). It
//   is reported, not failed, so the first release does not depend on that.
//
// --audit prints the four packages' dist-tags and checks only the `latest`
// rule. Read-only: it runs `npm view`, never anything that writes.

import { execFileSync } from "node:child_process";

const PACKAGES = [
  "@paged-media/canvas-wasm",
  "@paged-media/idml-viewer",
  "@paged-media/plugin-api",
  "@paged-media/plugin-sdk",
];
const args = process.argv.slice(2);
const audit = args.includes("--audit");
const [version, tag] = args.filter((a) => !a.startsWith("--"));
if (!audit && (!version || !tag)) {
  console.error(
    "usage: node tooling/release/assert-dist-tags.mjs <version> <dist-tag> | --audit",
  );
  process.exit(2);
}

const isPrerelease = (v) => typeof v === "string" && v.includes("-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function distTags(name) {
  try {
    const out = execFileSync("npm", ["view", name, "dist-tags", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? JSON.parse(out) : {};
  } catch {
    return null; // not on npm (yet), or the registry did not answer
  }
}

const failures = [];
for (const name of PACKAGES) {
  let tags = distTags(name);
  if (!audit) {
    for (let i = 0; i < 12 && tags?.[tag] !== version; i++) {
      await sleep(10_000);
      tags = distTags(name);
    }
  }
  console.log(`${name}: ${JSON.stringify(tags)}`);
  if (tags === null) {
    if (!audit) failures.push(`${name}: npm does not answer for it`);
    continue;
  }
  if (!audit && tags[tag] !== version) {
    failures.push(
      `${name}: ${tag} is ${tags[tag] ?? "(absent)"}, expected ${version}`,
    );
  }
  if (isPrerelease(tags.latest)) {
    const msg = `${name}: latest is the prerelease ${tags.latest}; point it at a release (npm dist-tag add ${name}@<release> latest)`;
    // A prerelease publishes under `next` and leaves an older `latest` as it
    // found it, so that is reported; an audit, or a release to `latest`, fails.
    if (audit || tag === "latest") failures.push(msg);
    else console.log(`::warning::${msg}`);
  }
  if (tags.canary) {
    console.log(
      `::notice::${name} still has a canary dist-tag (${tags.canary}); remove it: npm dist-tag rm ${name} canary`,
    );
  }
}

if (failures.length) {
  for (const f of failures) console.error(`::error::dist-tags: ${f}`);
  process.exit(1);
}
console.log(
  audit
    ? "dist-tags audit OK"
    : `dist-tags OK — ${tag} is ${version} for all four`,
);
