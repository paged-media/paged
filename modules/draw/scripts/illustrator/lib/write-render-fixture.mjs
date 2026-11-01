#!/usr/bin/env node
// Judge a RENDER probe's reply (one whose answer is files Illustrator
// wrote into the stage: a PNG of what it drew, a PDF of how it exports)
// and, only if it is a recording, copy the files beside <out.json> and
// write the fixture. Selected with PAGED_PROBE_WRITER=write-render-fixture.mjs;
// same arguments as write-fixture.mjs plus the stage directory:
//
//   node scripts/illustrator/lib/write-render-fixture.mjs \
//     <raw.json> <out.json> <probe-name> <script-path> <script-sha256> <macos-version> <stage>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [raw, out, name, script, sha, os, stage] = process.argv.slice(2);
const fail = (why) => {
  console.error(`run-probe: NOT A RECORDING — ${why}`);
  process.exit(1);
};
let reply;
try {
  reply = JSON.parse(fs.readFileSync(raw, "utf8"));
} catch (e) {
  fail(`Illustrator's reply is not JSON (${e.message})`);
}
if (reply.error) fail(`the probe failed before its cases: ${reply.error}`);
if (reply.close_error) fail(`a document did not close: ${reply.close_error}`);
if (reply.probe !== name)
  fail(`the reply is for probe "${reply.probe}", not "${name}"`);
if (reply.units !== "pt") fail(`units are "${reply.units}", not "pt"`);
if (!Array.isArray(reply.cases) || reply.cases.length === 0) fail("no cases");
if (reply.documents_after !== reply.documents_before) {
  fail(
    `${reply.documents_before} document(s) before, ${reply.documents_after} after`,
  );
}
const broken = reply.cases.filter((c) => c.error);
if (broken.length > 0) {
  fail(
    `${broken.length} of ${reply.cases.length} cases raised:\n` +
      broken.map((c) => `    ${c.id}: ${c.error}`).join("\n"),
  );
}
const dir = path.dirname(out);
const files = {};
for (const c of reply.cases) {
  for (const key of ["png", "pdf"]) {
    const file = c[key];
    if (typeof file !== "string" || file.includes("/"))
      fail(`case ${c.id} names no ${key}`);
    const from = path.join(stage, file);
    if (!fs.existsSync(from) || fs.statSync(from).size === 0)
      fail(`case ${c.id}: Illustrator wrote no ${file}`);
    files[file] = from;
  }
}
const digests = {};
for (const [file, from] of Object.entries(files)) {
  const bytes = fs.readFileSync(from);
  digests[file] = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(dir, file), bytes);
}
const fixture = {
  fixture: name,
  produced_by: {
    app: reply.app.name,
    version: reply.app.version,
    build: reply.app.build,
    locale: reply.app.locale,
    script,
    script_sha256: sha,
    runner:
      "scripts/illustrator/run-probe.sh (PAGED_PROBE_WRITER=write-render-fixture.mjs)",
    recorded_at: new Date().toISOString(),
    host_os: `macOS ${os}`,
  },
  units: reply.units,
  coordinates: reply.coordinates,
  operation: reply.operation,
  files: digests,
  cases: reply.cases,
};
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(
  `run-probe: recorded ${fixture.cases.length} cases and ${Object.keys(digests).length} files from ` +
    `${fixture.produced_by.app} ${fixture.produced_by.version} (build ${fixture.produced_by.build})`,
);
