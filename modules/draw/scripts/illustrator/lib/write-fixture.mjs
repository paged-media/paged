#!/usr/bin/env node
// Judge Illustrator's raw reply and, only if it is a recording, write the
// fixture. Called by run-probe.sh; split out so the judgement can be run
// (and tested) on a kept raw reply without driving the app again:
//
//   node scripts/illustrator/lib/write-fixture.mjs \
//     <raw.json> <out.json> <probe-name> <script-path> <script-sha256> <macos-version>
//
// "Judge by the artifact": an osascript exit code of 0 says only that
// Illustrator returned a string. This says whether the string is an answer.
import fs from "node:fs";
const [raw, out, name, script, sha, os] = process.argv.slice(2);
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
if (reply.close_error) fail(`the scratch document did not close: ${reply.close_error}`);
if (reply.probe !== name) fail(`the reply is for probe "${reply.probe}", not "${name}"`);
if (reply.units !== "pt") fail(`units are "${reply.units}", not "pt"`);
if (!Array.isArray(reply.cases) || reply.cases.length === 0) fail("no cases");
if (reply.documents_after !== reply.documents_before) {
  fail(`${reply.documents_before} document(s) before, ${reply.documents_after} after`);
}
const broken = reply.cases.filter((c) => c.error);
if (broken.length > 0) {
  fail(
    `${broken.length} of ${reply.cases.length} cases raised:\n` +
      broken.map((c) => `    ${c.id}: ${c.error}`).join("\n"),
  );
}
const empty = reply.cases.filter((c) => !c.measured || c.measured.paths.length === 0);
if (empty.length > 0) {
  fail(`cases with NO resulting path: ${empty.map((c) => c.id).join(", ")}`);
}
const ids = reply.cases.map((c) => c.id);
if (new Set(ids).size !== ids.length) fail("duplicate case ids");

const fixture = {
  fixture: name,
  produced_by: {
    app: reply.app.name,
    version: reply.app.version,
    build: reply.app.build,
    locale: reply.app.locale,
    script,
    script_sha256: sha,
    runner: "scripts/illustrator/run-probe.sh",
    recorded_at: new Date().toISOString(),
    host_os: `macOS ${os}`,
    ruler_units: reply.ruler_units,
    artboard_rect_app: reply.artboard_rect_app,
  },
  units: reply.units,
  coordinates: reply.coordinates,
  operation: reply.operation,
  cases: reply.cases,
};

// One anchor per line: a re-recording should diff as geometry, not as a
// reflowed blob.
const compact = (v) => JSON.stringify(v);
const lines = ["{"];
for (const key of ["fixture", "produced_by", "units", "coordinates", "operation"]) {
  lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(fixture[key], null, 2).replace(/\n/g, "\n  ")},`);
}
lines.push('  "cases": [');
const pathLines = (p, indent) => {
  const { anchors, ...rest } = p;
  const head = Object.entries(rest).map(([k, v]) => `${JSON.stringify(k)}: ${compact(v)}`);
  return [
    `${indent}{`,
    ...head.map((h) => `${indent}  ${h},`),
    `${indent}  "anchors": [`,
    ...anchors.map((a, i) => `${indent}    ${compact(a)}${i + 1 < anchors.length ? "," : ""}`),
    `${indent}  ]`,
    `${indent}}`,
  ];
};
const block = (label, paths, indent, last) => {
  const body = paths.flatMap((p, i) => {
    const ls = pathLines(p, `${indent}    `);
    if (i + 1 < paths.length) ls[ls.length - 1] += ",";
    return ls;
  });
  return [`${indent}${JSON.stringify(label)}: { "paths": [`, ...body, `${indent}] }${last ? "" : ","}`];
};
fixture.cases.forEach((c, i) => {
  lines.push("    {");
  lines.push(`      "id": ${JSON.stringify(c.id)},`);
  lines.push(`      "parameters": ${compact(c.parameters)},`);
  lines.push(...block("input", c.input.paths, "      ", false));
  lines.push(...block("measured", c.measured.paths, "      ", true));
  lines.push(`    }${i + 1 < fixture.cases.length ? "," : ""}`);
});
lines.push("  ]", "}");
const text = lines.join("\n") + "\n";
// The hand-laid layout must still be the same DATA (key order aside).
const norm = (v) =>
  Array.isArray(v)
    ? v.map(norm)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
      : v;
if (JSON.stringify(norm(JSON.parse(text))) !== JSON.stringify(norm(fixture))) {
  fail("internal: the formatted fixture does not round-trip");
}
fs.writeFileSync(out, text);
console.log(
  `run-probe: recorded ${fixture.cases.length} cases from ${fixture.produced_by.app} ` +
    `${fixture.produced_by.version} (build ${fixture.produced_by.build}, ${fixture.produced_by.locale})`,
);
