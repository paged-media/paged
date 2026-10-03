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
//     <idml-path> <idml-sha256> <macos-version> <pdf-path> <zorder.xml>
//
// "Judge by the artifact": an osascript exit code of 0 says only that
// InDesign returned a string. This says whether the string is an answer.
import fs from "node:fs";

const [raw, out, name, reader, sha, idml, idmlSha, os, pdf, zorderXml] = process.argv.slice(2);
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
if (!reply.exported) fail("the reader did not export InDesign's own IDML");

// THE STACKING ORDER, from InDesign's own export of the opened document:
// page items are written back to front, each with `Self="u<hex id>"`. The
// DOM cannot answer it (`pageItems` is grouped by kind — see the reader).
const PAGE_ITEM = new Set(["Rectangle", "Oval", "Polygon", "GraphicLine", "Group", "TextFrame"]);
const stack = []; // open elements: { tag, self }
const zOf = new Map(); // self -> { z, parent }
const nextZ = new Map(); // parent self -> next z
const xml = fs.readFileSync(zorderXml, "utf8");
for (const m of xml.matchAll(/<(\/?)([A-Za-z:]+)([^>]*?)(\/?)>/g)) {
  const [, closing, tag, attrs, selfClosing] = m;
  if (tag.startsWith("?") || tag.startsWith("!")) continue;
  if (closing) {
    stack.pop();
    continue;
  }
  const self = /\bSelf="([^"]*)"/.exec(attrs)?.[1] ?? null;
  if (PAGE_ITEM.has(tag) && self) {
    const owner = [...stack].reverse().find((e) => PAGE_ITEM.has(e.tag));
    const parent = owner ? owner.self : "spread";
    const z = nextZ.get(parent) ?? 0;
    nextZ.set(parent, z + 1);
    zOf.set(self, { z, parent });
  }
  if (!selfClosing) stack.push({ tag, self });
}
for (const item of reply.items) {
  const self = `u${Number(item.id).toString(16)}`;
  const found = zOf.get(self);
  if (!found) fail(`item ${item.kind}#${item.id} (${self}) is not in InDesign's own export`);
  const parentSelf = item.parent === "spread" ? "spread" : `u${Number(item.parent.split("#")[1]).toString(16)}`;
  if (found.parent !== parentSelf) {
    fail(`item ${self}: the DOM says parent ${item.parent}, the export says ${found.parent}`);
  }
  item.z = found.z;
}
if (zOf.size !== reply.items.length) {
  fail(`InDesign's export holds ${zOf.size} page items, the DOM walk ${reply.items.length}`);
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
  units: reply.units,
  coordinates: reply.coordinates,
  open: reply.open,
  spreads: reply.spreads,
  pages: reply.pages,
  layers: reply.layers,
  warnings: reply.warnings ?? [],
  stories: reply.stories ?? [],
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
