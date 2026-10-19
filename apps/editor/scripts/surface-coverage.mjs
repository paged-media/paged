#!/usr/bin/env bun
/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

/**
 * THE SURFACE-CONFORMANCE GATE: every surface id the product exposes is
 * ASSERTED by a test in the layers its kind requires, or acknowledged with
 * a reason. Overview: apps/editor/docs/reference/surface-conformance.md;
 * ADR: apps/editor/docs/adr/227-surface-conformance.md.
 *
 * WHAT IT COUNTS. A test vouches for an id by calling `covers("kind:id")`
 * next to its assertions (platform/shared/test-kit, "covers()"). The gate
 * reads those calls statically from every test file in the repository and
 * attributes each to its LAYER from the file's path. Until this gate, a
 * surface id counted as tested when its string appeared anywhere under
 * `tests/`; that "mentioned" signal is kept as a secondary column, because
 * it still finds the surface nothing has ever heard of, but it no longer
 * passes anything.
 *
 * WHAT IT ENUMERATES. surface/enumerate.mjs: the editor's commands, panels,
 * tools, menu items and keybindings; every bundle the editor loads (all
 * nine, slide included), from its manifest and its `contribute.*` calls;
 * every setting (the editor's inventory and every tool option); the CLIs
 * (`paged`, `paged-run`, `paged-node`, `paged-plugin`); and the scripting
 * surface (the catalog's host functions and the editor's automation
 * functions). Derived ids (a show / hide command per panel, …) are
 * FAMILIES with their members beside them.
 *
 * THE REQUIRED LAYERS per kind are REQUIREMENTS below: one or more
 * CLAUSES, each satisfied by one asserting test in any of its layers.
 *
 * THE RATCHET RUNS BOTH WAYS. An (id, clause) that no test satisfies must
 * be ACKNOWLEDGED, with a reason, in
 * `surface-acknowledged/<origin>.<kind>.<clause>.json`. An id that loses
 * its asserting test fails the run (it is neither covered nor
 * acknowledged); an ACKNOWLEDGED entry that has since become covered fails
 * it too, so the list cannot rot into a permanent excuse. `--prune`
 * deletes those entries (and entries for ids that no longer exist).
 *
 * FAIL-OPEN IS THE REAL RISK. An extractor that silently stops matching
 * would turn this into a gate that always passes. So every extractor
 * asserts a floor (SENTINELS, in enumerate.mjs), the bundle table is
 * pinned at nine, every registration site the evaluator cannot resolve
 * fails the run unless it is a family or a DYNAMIC_SITES entry with a
 * reason, and a covers() call the gate cannot read is an error.
 *
 *   bun scripts/surface-coverage.mjs                 the gate
 *   bun scripts/surface-coverage.mjs --prune         drop covered / stale entries
 *   bun scripts/surface-coverage.mjs --json-out f --md-out g   the report
 *   bun scripts/surface-coverage.mjs --list <kind>   every id of a kind, with its state
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readCovers } from "./surface/covers-reader.mjs";
import {
  DYNAMIC_SITES,
  SETTINGS_INVENTORY,
  enumerateSurface,
  listFiles,
} from "./surface/enumerate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
export const ACK_DIR = join(HERE, "surface-acknowledged");

/** The layers each kind requires: every clause must be satisfied by one
 *  asserting test whose layers meet it. `tier` lists acceptable tiers,
 *  `tag` (optional) a tag the same file must carry. */
export const REQUIREMENTS = {
  command: [
    { clause: "unit", tier: ["unit", "component", "rust"] },
    { clause: "integration", tier: ["headless", "e2e"] },
  ],
  panel: [{ clause: "component", tier: ["component"] }],
  tool: [{ clause: "gesture", tier: ["unit", "component"], tag: "gesture" }],
  menu: [{ clause: "e2e", tier: ["e2e"] }],
  keybinding: [
    { clause: "any", tier: ["unit", "component", "headless", "e2e"] },
  ],
  setting: [{ clause: "unit", tier: ["unit", "component"] }],
  cli: [
    {
      clause: "golden",
      tier: ["unit", "component", "headless", "e2e", "rust"],
      tag: "golden",
    },
  ],
  script: [
    {
      clause: "script",
      tier: ["unit", "component", "headless", "e2e", "rust"],
      tag: "script",
    },
  ],
  importer: [
    { clause: "any", tier: ["unit", "component", "headless", "e2e", "rust"] },
  ],
  exporter: [
    { clause: "any", tier: ["unit", "component", "headless", "e2e", "rust"] },
  ],
};

export const LAYERS = [
  "unit",
  "component",
  "headless",
  "e2e",
  "rust",
  "golden",
  "script",
  "gesture",
];

/** An unknown covers() id fails the run once this is true. It stays false
 *  while the enumeration settles, so a sibling's correct id that the
 *  enumeration does not know yet is reported, not blocking. */
const ORPHANS_FAIL = false;

/** The editor's settings inventory is required once it exists on main. */
const SETTINGS_INVENTORY_REQUIRED = false;

const MIN_REASON = 40;

const satisfies = (layers, req) =>
  req.tier.some((t) => layers.has(t)) && (!req.tag || layers.has(req.tag));

const describeReq = (req) =>
  `${req.tag ? `${req.tag} + ` : ""}${req.tier.join("|")}`;

// ── acknowledged ─────────────────────────────────────────────────────

export function loadAcknowledged(dir = ACK_DIR) {
  const entries = [];
  const problems = [];
  if (!existsSync(dir)) return { entries, problems };
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const m = /^(host|plugin)\.([a-z]+)\.([a-z0-9]+)\.json$/.exec(f);
    if (!m) {
      problems.push(`${f}: not <host|plugin>.<kind>.<clause>.json`);
      continue;
    }
    const [, origin, kind, clause] = m;
    if (!REQUIREMENTS[kind]?.some((r) => r.clause === clause)) {
      problems.push(`${f}: ${kind} has no clause "${clause}"`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      problems.push(`${f}: not valid JSON (${e.message})`);
      continue;
    }
    for (const [key, reason] of Object.entries(data)) {
      const idx = key.indexOf(":");
      const k = key.slice(0, idx);
      const id = key.slice(idx + 1);
      entries.push({
        file: f,
        origin,
        kind,
        clause,
        key,
        keyKind: k,
        id,
        reason,
      });
    }
  }
  return { entries, problems };
}

function writeAcknowledged(entries, dir = ACK_DIR) {
  const byFile = new Map();
  for (const e of entries) {
    const f = `${e.origin}.${e.kind}.${e.clause}.json`;
    if (!byFile.has(f)) byFile.set(f, {});
    byFile.get(f)[`${e.kind}:${e.id}`] = e.reason;
  }
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json"))
    : [];
  for (const f of new Set([...existing, ...byFile.keys()])) {
    const data = byFile.get(f) ?? {};
    const sorted = Object.fromEntries(
      Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    writeFileSync(join(dir, f), `${JSON.stringify(sorted, null, 2)}\n`);
  }
}

// ── the computation ──────────────────────────────────────────────────

const globToRegex = (glob) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

/**
 * Enumerate, read every covers() call, resolve each id, and grade every
 * (id, clause). Pure apart from reading files.
 */
export function computeGate(root = ROOT, ackDir = ACK_DIR) {
  const surface = enumerateSurface(root);
  const files = listFiles(root, ["."]);
  const covers = readCovers(root, files);

  const byKey = new Map(surface.items.map((i) => [`${i.kind}:${i.id}`, i]));
  const familyMatchers = surface.items
    .filter((i) => i.family)
    .map((i) => ({ item: i, re: globToRegex(i.id) }));
  const menuByCommand = new Map();
  for (const i of surface.items)
    if (i.kind === "menu" && i.command && !i.family) {
      if (!menuByCommand.has(i.command)) menuByCommand.set(i.command, []);
      menuByCommand.get(i.command).push(i);
    }

  const coverage = new Map(); // key → [{ file, line, layers }]
  const memberCoverage = new Map(); // family key → Set(member id)
  const orphans = [];
  const errors = [
    ...covers.errors.map((e) => `${e.file}:${e.line}: ${e.message}`),
  ];
  for (const call of covers.calls) {
    for (const { kind, id } of call.parsed) {
      let item = byKey.get(`${kind}:${id}`);
      if (!item && kind === "menu" && menuByCommand.has(id)) {
        const hits = menuByCommand.get(id);
        if (hits.length === 1) item = hits[0];
        else {
          errors.push(
            `${call.file}:${call.line}: menu:${id} is ambiguous, ${hits.length} items invoke it ` +
              `(${hits.map((h) => h.id).join(" | ")}); use menu:<path>`,
          );
          continue;
        }
      }
      if (!item) {
        const fam = familyMatchers.find(
          (f) => f.item.kind === kind && f.re.test(id),
        );
        if (fam) {
          const k = `${kind}:${fam.item.id}`;
          if (!memberCoverage.has(k)) memberCoverage.set(k, new Set());
          memberCoverage.get(k).add(id);
          continue;
        }
        orphans.push({ kind, id, file: call.file, line: call.line });
        continue;
      }
      const key = `${item.kind}:${item.id}`;
      if (!coverage.has(key)) coverage.set(key, []);
      coverage
        .get(key)
        .push({ file: call.file, line: call.line, layers: call.layers });
    }
  }

  // Mentioned (the secondary signal): the id's text in any test file.
  const blob = [...covers.texts.values()].join("\n");
  //   keybinding: its command (the binding itself is a chord, rarely spelt
  //   the way it is registered); setting: its key with its tool; family:
  //   any member.
  const mentioned = (item) => {
    if (item.family)
      return item.members.some((m) => blob.includes(m.replace(/^.*\/…\//, "")));
    if (item.kind === "keybinding")
      return blob.includes(item.id.split("→")[1] ?? item.id);
    if (item.kind === "setting" && item.id.includes(".tool.")) {
      const at = item.id.lastIndexOf(".");
      return (
        blob.includes(item.id.slice(0, at)) &&
        blob.includes(item.id.slice(at + 1))
      );
    }
    return blob.includes(item.id);
  };

  // Grade.
  const { entries: acks, problems: ackProblems } = loadAcknowledged(ackDir);
  const ackByKey = new Map(
    acks.map((a) => [`${a.keyKind}:${a.id}#${a.clause}`, a]),
  );
  const graded = [];
  for (const item of surface.items) {
    const key = `${item.kind}:${item.id}`;
    const tests = coverage.get(key) ?? [];
    const layers = new Set(tests.flatMap((t) => [...t.layers]));
    const clauses = (REQUIREMENTS[item.kind] ?? []).map((req) => {
      const by = tests.filter((t) => satisfies(t.layers, req));
      const ack = ackByKey.get(`${key}#${req.clause}`);
      return {
        clause: req.clause,
        requires: describeReq(req),
        covered: by.length > 0,
        tests: by.map((t) => `${t.file}:${t.line}`),
        acknowledged: ack ? ack.reason : null,
        ackFile: ack?.file ?? null,
      };
    });
    graded.push({
      ...item,
      key,
      layers: [...layers].sort(),
      tests: tests.map((t) => `${t.file}:${t.line}`),
      clauses,
      mentioned: mentioned(item),
      membersCovered: item.family
        ? [...(memberCoverage.get(key) ?? [])].sort()
        : undefined,
    });
  }

  // Ratchet problems.
  const failures = [];
  const ackFailures = [...ackProblems];
  const known = new Set(graded.map((g) => g.key));
  for (const a of acks) {
    const item = byKey.get(`${a.keyKind}:${a.id}`);
    if (a.keyKind !== a.kind)
      ackFailures.push(
        `${a.file}: "${a.key}" is a ${a.keyKind} id in a ${a.kind} file`,
      );
    else if (!item)
      ackFailures.push(
        `${a.file}: "${a.key}" is not a surface id any more (renamed or removed); --prune drops it`,
      );
    else if (item.origin !== a.origin)
      ackFailures.push(
        `${a.file}: "${a.key}" is ${item.origin} surface; it belongs in ${item.origin}.${a.kind}.${a.clause}.json`,
      );
    if (typeof a.reason !== "string" || a.reason.trim().length < MIN_REASON)
      ackFailures.push(
        `${a.file}: "${a.key}" has no reason a reader can use (min ${MIN_REASON} characters): say what and why`,
      );
  }
  const lost = [];
  const stale = [];
  for (const g of graded)
    for (const c of g.clauses) {
      if (!c.covered && !c.acknowledged) lost.push({ g, c });
      if (c.covered && c.acknowledged) stale.push({ g, c });
    }

  // Sites the evaluator could not resolve.
  const unresolved = [];
  const usedDynamic = new Set();
  for (const u of surface.unresolved) {
    const k = `${u.kind} ${u.file}`;
    if (DYNAMIC_SITES.has(k)) {
      usedDynamic.add(k);
      continue;
    }
    unresolved.push(u);
  }
  const staleDynamic = [...DYNAMIC_SITES.keys()].filter(
    (k) => !usedDynamic.has(k),
  );

  // Sentinels.
  const lowSentinels = surface.sentinels.filter(
    ([, got, floor]) => got < floor,
  );
  const bundleProblems = [];
  const loaded = surface.bundles.filter((b) => b.counts);
  if (surface.bundles.length !== 9 || loaded.length !== 9)
    bundleProblems.push(
      `the editor's bundle table lists ${surface.bundles.length} bundles and ${loaded.length} have a ` +
        "manifest the gate read; it is pinned at nine (draw, web, data, sheet, image, publish, pdf, " +
        "doc, slide). A bundle that drops out or joins changes this number deliberately.",
    );
  if (!surface.bundles.some((b) => b.id === "media.paged.slide"))
    bundleProblems.push("the slide bundle is not among the enumerated bundles");
  for (const n of surface.notes) bundleProblems.push(n);

  // Plumbing contributions (no covers() kind): the old "mentioned" ratchet.
  const plumbingUnmentioned = surface.plumbing.filter(
    (p) => !blob.includes(p.id),
  );

  const settingsPending = surface.settingsInventory === null;

  return {
    surface,
    graded,
    covers,
    orphans,
    errors,
    acks,
    ackFailures,
    lost,
    stale,
    unresolved,
    staleDynamic,
    lowSentinels,
    bundleProblems,
    plumbingUnmentioned,
    settingsPending,
    known,
  };
}

// ── the report ───────────────────────────────────────────────────────

export function buildReport(r) {
  const kinds = {};
  for (const kind of Object.keys(REQUIREMENTS)) {
    const items = r.graded.filter((g) => g.kind === kind);
    const byLayer = {};
    for (const l of LAYERS)
      byLayer[l] = items.filter((g) => g.layers.includes(l)).length;
    const clauses = {};
    for (const req of REQUIREMENTS[kind]) {
      const cs = items.map((g) =>
        g.clauses.find((c) => c.clause === req.clause),
      );
      clauses[req.clause] = {
        requires: describeReq(req),
        required: cs.length,
        covered: cs.filter((c) => c.covered).length,
        acknowledged: cs.filter((c) => !c.covered && c.acknowledged).length,
        missing: cs.filter((c) => !c.covered && !c.acknowledged).length,
      };
    }
    kinds[kind] = {
      ids: items.length,
      host: items.filter((g) => g.origin === "host").length,
      plugin: items.filter((g) => g.origin === "plugin").length,
      families: items
        .filter((g) => g.family)
        .map((g) => ({
          id: g.id,
          members: g.members.length,
          membersCovered: g.membersCovered.length,
        })),
      asserted: items.filter((g) => g.tests.length > 0).length,
      byLayer,
      clauses,
      mentioned: items.filter((g) => g.mentioned).length,
    };
  }
  return {
    schema: 1,
    kinds,
    totals: {
      ids: r.graded.length,
      asserted: r.graded.filter((g) => g.tests.length > 0).length,
      coversCalls: r.covers.calls.length,
      testFiles: r.covers.testFiles.length,
      testFilesWithCovers: new Set(r.covers.calls.map((c) => c.file)).size,
      acknowledged: r.acks.length,
    },
    bundles: r.surface.bundles.map((b) => ({
      name: b.name,
      id: b.id,
      counts: b.counts,
    })),
    settingsInventory: r.settingsPending
      ? "pending"
      : r.surface.settingsInventory,
    orphans: r.orphans,
    errors: r.errors,
    items: r.graded.map((g) => ({
      kind: g.kind,
      id: g.id,
      origin: g.origin,
      owner: g.owner,
      source: g.source,
      family: g.family || undefined,
      members: g.family ? g.members.length : undefined,
      membersCovered: g.membersCovered,
      layers: g.layers,
      tests: g.tests,
      clauses: Object.fromEntries(
        g.clauses.map((c) => [
          c.clause,
          c.covered ? "covered" : c.acknowledged ? "acknowledged" : "missing",
        ]),
      ),
      mentioned: g.mentioned,
    })),
  };
}

export function markdownReport(report) {
  const lines = [];
  lines.push("## Surface conformance");
  lines.push("");
  lines.push(
    `${report.totals.ids} surface ids; ${report.totals.asserted} asserted by at least one test under covers() ` +
      `(${report.totals.coversCalls} calls in ${report.totals.testFilesWithCovers} of ${report.totals.testFiles} test files); ` +
      `${report.totals.acknowledged} acknowledged gaps.`,
  );
  lines.push("");
  lines.push(
    "Ids with at least one asserting test, per layer (a test file counts in its tier and its tags):",
  );
  lines.push("");
  lines.push(`| kind | ids | ${LAYERS.join(" | ")} | mentioned (secondary) |`);
  lines.push(`| --- | ---: | ${LAYERS.map(() => "---:").join(" | ")} | ---: |`);
  for (const [kind, k] of Object.entries(report.kinds))
    lines.push(
      `| ${kind} | ${k.ids} | ${LAYERS.map((l) => k.byLayer[l]).join(" | ")} | ${k.mentioned} |`,
    );
  lines.push("");
  lines.push(
    "Required layers, per kind and clause (covered / required, acknowledged, missing):",
  );
  lines.push("");
  lines.push(
    "| kind | clause | requires | covered / required | acknowledged | missing |",
  );
  lines.push("| --- | --- | --- | ---: | ---: | ---: |");
  for (const [kind, k] of Object.entries(report.kinds))
    for (const [clause, c] of Object.entries(k.clauses))
      lines.push(
        `| ${kind} | ${clause} | ${c.requires} | ${c.covered} / ${c.required} | ${c.acknowledged} | ${c.missing} |`,
      );
  const fams = Object.entries(report.kinds).flatMap(([kind, k]) =>
    k.families.map((f) => ({ kind, ...f })),
  );
  if (fams.length) {
    lines.push("");
    lines.push(
      "Families (one surface id each; members are the ids derived per registered item):",
    );
    lines.push("");
    lines.push("| family | members | members named by a covers() call |");
    lines.push("| --- | ---: | ---: |");
    for (const f of fams)
      lines.push(`| ${f.kind}:${f.id} | ${f.members} | ${f.membersCovered} |`);
  }
  lines.push("");
  lines.push(
    `Settings inventory: ${report.settingsInventory === "pending" ? "pending (apps/editor/scripts/settings-inventory.json is not there yet; tool options only)" : `${report.settingsInventory} editor settings`}.`,
  );
  if (report.orphans.length) {
    lines.push("");
    lines.push(
      `${report.orphans.length} covers() id(s) name no enumerated surface:`,
    );
    for (const o of report.orphans.slice(0, 50))
      lines.push(`- \`${o.kind}:${o.id}\` (${o.file}:${o.line})`);
  }
  return `${lines.join("\n")}\n`;
}

// ── run ──────────────────────────────────────────────────────────────

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const r = computeGate();
  const report = buildReport(r);
  const md = markdownReport(report);

  if (argv.includes("--prune")) {
    const keep = r.acks.filter((a) => {
      const g = r.graded.find((x) => x.kind === a.kind && x.id === a.id);
      if (!g || g.origin !== a.origin) return false;
      const c = g.clauses.find((x) => x.clause === a.clause);
      return c && !c.covered;
    });
    writeAcknowledged(keep);
    console.log(
      `surface-coverage --prune: ${r.acks.length - keep.length} entr(ies) removed, ${keep.length} kept.`,
    );
    return 0;
  }

  const list = arg("--list");
  if (list) {
    for (const g of r.graded.filter((x) => x.kind === list))
      console.log(
        `${g.key.padEnd(60)} ${g.clauses.map((c) => `${c.clause}=${c.covered ? "covered" : c.acknowledged ? "ack" : "MISSING"}`).join(" ")}  ${g.mentioned ? "mentioned" : ""}`,
      );
    return 0;
  }

  const jsonOut = arg("--json-out");
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  const mdOut = arg("--md-out");
  if (mdOut) writeFileSync(mdOut, md);
  if (process.env.GITHUB_STEP_SUMMARY && argv.includes("--summary"))
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

  if (!argv.includes("--quiet")) console.log(md);

  let failed = false;
  const fail = (title, rows) => {
    if (!rows.length) return;
    failed = true;
    console.error(`\n✗ ${title}`);
    for (const row of rows.slice(0, 200)) console.error(`    ${row}`);
    if (rows.length > 200) console.error(`    … and ${rows.length - 200} more`);
  };
  fail(
    "an extractor came back under its floor (it lost its footing, or the surface shrank: lower the floor deliberately)",
    r.lowSentinels.map(
      ([what, got, floor]) => `${what}: ${got} (floor ${floor})`,
    ),
  );
  fail("the bundle enumeration", r.bundleProblems);
  fail(
    "registration sites the evaluator cannot resolve: make the id static, declare a family " +
      "(FAMILY_OF_PATTERN), or add a DYNAMIC_SITES entry with a reason (surface/enumerate.mjs)",
    r.unresolved.map(
      (u) =>
        `${u.kind} at ${u.at}${u.pattern ? ` (pattern ${u.pattern})` : ""}${u.partial ? " (some fields unresolved)" : ""}`,
    ),
  );
  fail(
    "DYNAMIC_SITES entries that match nothing any more: remove them",
    r.staleDynamic,
  );
  fail("covers() calls the gate cannot read", r.errors);
  fail("the ACKNOWLEDGED files", r.ackFailures);
  fail(
    "surface without an asserting test in a required layer and without an ACKNOWLEDGED entry " +
      "(an id lost its coverage, or new surface arrived untested): write the test with covers(), " +
      "or acknowledge it with a specific reason in surface-acknowledged/<origin>.<kind>.<clause>.json",
    r.lost.map(
      ({ g, c }) =>
        `${g.key.padEnd(58)} ${c.clause} (${c.requires})  → ${g.origin}.${g.kind}.${c.clause}.json`,
    ),
  );
  fail(
    "ACKNOWLEDGED entries that are covered now: delete them (bun scripts/surface-coverage.mjs --prune)",
    r.stale.map(
      ({ g, c }) => `${g.key} ${c.clause}  (${c.tests.slice(0, 2).join(", ")})`,
    ),
  );
  fail(
    "plugin contributions no test names at all (edit contexts, object types, part types; the old mentioned ratchet)",
    r.plumbingUnmentioned.map((p) => `${p.kind} ${p.id} (${p.owner})`),
  );
  if (r.orphans.length) {
    const rows = r.orphans.map(
      (o) => `${o.kind}:${o.id}  (${o.file}:${o.line})`,
    );
    if (ORPHANS_FAIL)
      fail(
        "covers() ids that name no enumerated surface (a typo, or a renamed id)",
        rows,
      );
    else {
      console.error(
        `\n! ${rows.length} covers() id(s) name no enumerated surface (reported, not failing yet):`,
      );
      for (const row of rows.slice(0, 50)) console.error(`    ${row}`);
    }
  }
  if (r.settingsPending && SETTINGS_INVENTORY_REQUIRED)
    fail("the settings inventory", [`${SETTINGS_INVENTORY} is missing`]);

  if (failed) return 1;
  console.log(
    `surface conformance OK: ${report.totals.asserted}/${report.totals.ids} ids asserted, ` +
      `${report.totals.acknowledged} acknowledged gaps, each with a reason.`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
