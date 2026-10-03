#!/usr/bin/env node
// This file is part of paged (https://paged.media).
// AGPL-3.0-only OR Paged Media Enterprise License (PMEL) — see LICENSE.md.
// Copyright (c) And The Next GmbH.
//
// Judge InDesign's raw reply and, only if it is a recording, write the
// fixture. Called by run-roundtrip.sh; split out so the judgement can be
// re-run on a kept raw reply without driving the app again:
//
//   node scripts/indesign/lib/write-fixture.mjs \
//     <raw.json> <out.json> <case> <reader-path> <reader-sha256> \
//     <idml-path> <idml-sha256> <macos-version> <pdf-path> <reexport-path|"">
//
// "Judge by the artifact": an osascript exit code of 0 says only that
// InDesign returned a string. This says whether the string is an answer.
import fs from "node:fs";

const [raw, out, name, reader, sha, idml, idmlSha, os, pdf, reexport] = process.argv.slice(2);
const fail = (why) => {
  console.error(`run-roundtrip: NOT A RECORDING — ${why}`);
  process.exit(1);
};
let reply;
try {
  reply = JSON.parse(fs.readFileSync(raw, "utf8"));
} catch (e) {
  fail(`InDesign's reply is not JSON (${e.message})`);
}
if (reply.reader !== "roundtrip") fail(`the reply is not the roundtrip reader's ("${reply.reader}")`);
if (reply.open_error) fail(`InDesign could not open the IDML: ${reply.open_error}`);
if (reply.error) fail(`the reader failed: ${reply.error}`);
if (reply.close_error) fail(`the document did not close: ${reply.close_error}`);
if (reply.units !== "pt") fail(`units are "${reply.units}", not "pt"`);
if (reply.documents_after !== reply.documents_before) {
  fail(`${reply.documents_before} document(s) before, ${reply.documents_after} after`);
}
if (!Array.isArray(reply.items)) fail("no item list");
if (reply.items.length === 0) fail("InDesign sees NO page item at all");
if (!Array.isArray(reply.pages) || reply.pages.length === 0) fail("no pages");
if (!fs.existsSync(pdf) || fs.statSync(pdf).size === 0) fail(`no PDF was written to ${pdf}`);
if (reexport && (!fs.existsSync(reexport) || fs.statSync(reexport).size === 0)) {
  fail(`no IDML re-export was written to ${reexport}`);
}

const fixture = {
  fixture: name,
  produced_by: {
    app: reply.app.name,
    version: reply.app.version,
    locale: reply.app.locale,
    script: reader,
    script_sha256: sha,
    runner: "scripts/indesign/run-roundtrip.sh",
    recorded_at: new Date().toISOString(),
    host_os: `macOS ${os}`,
    pdf_preset: reply.pdf_preset ?? null,
  },
  idml: { path: idml, sha256: idmlSha },
  reexported: Boolean(reply.reexported),
  units: reply.units,
  coordinates: reply.coordinates,
  open: reply.open,
  spreads: reply.spreads,
  pages: reply.pages,
  layers: reply.layers,
  warnings: reply.warnings ?? [],
  items: reply.items,
};

// One anchor per line, so a re-recording diffs as geometry and paint, not
// as a reflowed blob.
const compact = (v) => JSON.stringify(v);
const lines = ["{"];
const head = Object.keys(fixture).filter((k) => k !== "items");
for (const key of head) {
  lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(fixture[key], null, 2).replace(/\n/g, "\n  ")},`);
}
lines.push('  "items": [');
fixture.items.forEach((item, i) => {
  const { paths, ...rest } = item;
  const body = Object.entries(rest).map(([k, v]) => `      ${JSON.stringify(k)}: ${compact(v)}`);
  if (paths !== undefined) {
    const p = paths.map((path, j) => {
      const { anchors, ...meta } = path;
      const metaLines = Object.entries(meta).map(([k, v]) => `          ${JSON.stringify(k)}: ${compact(v)},`);
      return [
        "        {",
        ...metaLines,
        '          "anchors": [',
        ...anchors.map((a, k) => `            ${compact(a)}${k + 1 < anchors.length ? "," : ""}`),
        "          ]",
        `        }${j + 1 < paths.length ? "," : ""}`,
      ].join("\n");
    });
    body.push(`      "paths": [\n${p.join("\n")}\n      ]`);
  }
  lines.push("    {");
  lines.push(body.join(",\n"));
  lines.push(`    }${i + 1 < fixture.items.length ? "," : ""}`);
});
lines.push("  ]", "}");
const text = lines.join("\n") + "\n";
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
  `run-roundtrip: recorded ${fixture.items.length} item(s), ${fixture.warnings.length} warning(s) ` +
    `from ${fixture.produced_by.app} ${fixture.produced_by.version} (${fixture.produced_by.locale})`,
);
