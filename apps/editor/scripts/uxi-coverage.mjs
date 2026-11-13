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
 * THE UXI COVERAGE REPORT (editor ADR 1202): which of the interaction
 * specification's acceptance tests UXI-T01…T76 a test in the repository
 * claims, in which layers, and which requirements that proves. The scenarios
 * and their gates are in interaction-inventory.json.
 *
 * WHAT COUNTS AS A CLAIM. A test claims a scenario in its TITLE, statically
 * read (the same way covers() is, but covers() stays for real surface ids:
 * ADR 227, the spec's §23.3):
 *
 *   TS / JS   test("UXI-T07 — Escape aborts a move …")   the title starts with the id
 *             it("… @uxi:UXI-T07 @uxi:UXI-GST-006")       tags anywhere in the title
 *             describe("UXI-T31 — …", …)                  a describe claims for its tests
 *   Rust      fn uxi_t60_script_waits_for_the_gesture()   the fn name
 *             /// UXI-T60 — …   (or /// … @uxi:UXI-T60)   a doc line above the fn
 *
 * A skipped test (`.skip`, `.fixme`, `.todo`, an expected failure `.fail`, a
 * Rust `#[ignore]`) and a quarantined one (`@quarantine`, ADR 228) are read
 * and listed, but claim nothing. A claimed id the inventory does not know is
 * an error, not a quiet zero.
 *
 * THE LAYER is read from the file's path with the surface gate's own rules
 * (surface/covers-reader.mjs `layersOf`): `*.dom.test.tsx` component, other
 * `*.test.*` unit, headless and Rust tests engine, Playwright under
 * apps/canvas/tests e2e, and its tests/journey/ journeys journey-cpu and
 * journey-gpu (the journeys-gpu project runs every journey; the four the
 * journeys project ignores are GPU only).
 *
 * THE RATCHET RUNS BOTH WAYS, as the surface gate's does. A UXI test no test
 * claims must be ACKNOWLEDGED in uxi-acknowledged.json with the plan task
 * that will claim it and a reason; an acknowledged id that a test now claims
 * fails the run until its entry goes (--prune), and a claimed id that loses
 * its test fails unless it is acknowledged again.
 *
 * GATES. `--gate` fails when a test of a gate listed in the inventory's
 * enforcedGates is neither claimed nor excused by an unexpired exception that
 * lists it. Requirement coverage is reported, not gated.
 *
 *   bun scripts/uxi-coverage.mjs                  the ratchet and the report
 *   bun scripts/uxi-coverage.mjs --gate           also the enforced gates
 *   bun scripts/uxi-coverage.mjs --summary        the report to $GITHUB_STEP_SUMMARY
 *   bun scripts/uxi-coverage.mjs --json [path]    the report as JSON (default docs/reference/uxi-coverage.json)
 *   bun scripts/uxi-coverage.mjs --prune          drop acknowledged entries that are claimed now
 *   bun scripts/uxi-coverage.mjs --quiet          no markdown on stdout
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FLOORS,
  INVENTORY,
  PLAN_PATH,
  ROOT,
  TASK_ID,
  expired,
  formatFiles,
  planTasks,
  readJson,
  todayIso,
} from "./interaction-inventory.mjs";
import {
  SOURCE_EXTENSIONS,
  gitGrepFiles,
  isSkippedPath,
  isTestFile,
  layersOf,
  rustCode,
} from "./surface/covers-reader.mjs";
import { listFiles } from "./surface/enumerate.mjs";
import { parseSource } from "./surface/static-eval.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ACKNOWLEDGED = join(HERE, "uxi-acknowledged.json");
export const REPORT_JSON = join(HERE, "../docs/reference/uxi-coverage.json");
export const QUARANTINE = join(HERE, "../apps/canvas/tests/quarantine.json");

/** What `git grep` looks for before a file is parsed. */
const CLAIM_GREP = "UXI-T[0-9]|@uxi:|uxi_t[0-9]";

/** The journeys only the real-Chrome `journeys-gpu` project runs: the
 *  `journeys` project's testIgnore in apps/canvas/playwright.config.ts
 *  (uxi-coverage.test.mjs keeps the two equal). */
export const GPU_ONLY_JOURNEYS = new Set([
  "gpu-backend.journey.spec.ts",
  "gpu-reentrancy.journey.spec.ts",
  "snapshot-backends.journey.spec.ts",
  "gpu-device-loss.journey.spec.ts",
]);

/** The layers a claim can be attributed to from its file's path. */
export const CLAIM_LAYERS = [
  "unit",
  "component",
  "engine",
  "e2e",
  "journey-cpu",
  "journey-gpu",
];

/** Which attributed layers count as evidence of each layer of §23.2. A
 *  Playwright spec outside the journeys is a browser test on the CPU path.
 *  visual, a11y-manual and chaos are not attributable from a path. */
export const EVIDENCE = {
  unit: ["unit"],
  component: ["component"],
  engine: ["engine"],
  "journey-cpu": ["journey-cpu", "e2e"],
  "journey-gpu": ["journey-gpu"],
  visual: [],
  "a11y-manual": [],
  chaos: [],
};

const TEST_ID = /^UXI-T\d{2}$/;
const REQUIREMENT_ID = /^UXI-[A-Z0-9]+-\d{3}$/;
const MIN_REASON = 40;

// ── the layers ───────────────────────────────────────────────────────

/** The layers a claim in `file` counts in. */
export function claimLayers(file, text = "") {
  const tiers = layersOf(file, text);
  const out = new Set();
  if (tiers.has("rust") || tiers.has("headless")) out.add("engine");
  if (tiers.has("component")) out.add("component");
  if (tiers.has("unit")) out.add("unit");
  if (tiers.has("e2e")) {
    if (/(^|\/)tests\/journey\//.test(file)) {
      out.add("journey-gpu");
      if (!GPU_ONLY_JOURNEYS.has(basename(file))) out.add("journey-cpu");
    } else out.add("e2e");
  }
  return out;
}

// ── the claims ───────────────────────────────────────────────────────

/** The ids a title claims, and the malformed claims in it. */
export function claimsInTitle(title) {
  const ids = [];
  const bad = [];
  const lead = /^\s*(UXI-T\d{2})(?![0-9A-Za-z])/.exec(title);
  if (lead) ids.push(lead[1]);
  else if (/^\s*UXI-T/.test(title))
    bad.push(`a title that starts "${title.slice(0, 12)}" is not UXI-Tnn`);
  for (const m of title.matchAll(/@uxi:(\S*)/g)) {
    const id = m[1].replace(/[),.;:]+$/, "");
    if (TEST_ID.test(id) || REQUIREMENT_ID.test(id)) ids.push(id);
    else
      bad.push(`"@uxi:${m[1]}" is not @uxi:UXI-Tnn or @uxi:UXI-<DOMAIN>-nnn`);
  }
  return { ids: [...new Set(ids)], bad };
}

const TEST_FNS = new Set(["test", "it", "describe"]);
const MODIFIERS = new Set([
  "describe",
  "only",
  "serial",
  "parallel",
  "concurrent",
  "skip",
  "fixme",
  "todo",
  "fail",
]);
const NOT_RUN = new Set(["skip", "fixme", "todo", "fail"]);
const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "parent",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

/** `test.describe.skip` → ["test", "describe", "skip"]; null for anything
 *  that is not a plain member chain on an identifier. */
function calleeChain(callee) {
  const names = [];
  let n = callee;
  while (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.property.type === "Identifier"
  ) {
    names.unshift(n.property.name);
    n = n.object;
  }
  if (n.type !== "Identifier") return null;
  names.unshift(n.name);
  return names;
}

function titleOf(arg) {
  if (!arg) return null;
  if (arg.type === "StringLiteral") return arg.value;
  if (arg.type === "TemplateLiteral")
    return arg.quasis.map((q) => q.value.cooked ?? q.value.raw).join("${…}");
  return null;
}

/** The `tag` strings of Playwright's details argument ({ tag: "@x" } or
 *  { tag: ["@x", "@y"] }). */
function tagsOf(args) {
  const tags = [];
  for (const a of args) {
    if (a.type !== "ObjectExpression") continue;
    for (const p of a.properties) {
      if (p.type !== "ObjectProperty") continue;
      const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
      if (key !== "tag") continue;
      const vals =
        p.value.type === "ArrayExpression" ? p.value.elements : [p.value];
      for (const v of vals) if (v?.type === "StringLiteral") tags.push(v.value);
    }
  }
  return tags;
}

function readTsClaims(file, text, out) {
  let program;
  try {
    program = parseSource(text, file).program;
  } catch (e) {
    out.errors.push(`${file}:0: cannot parse (${e.message})`);
    return;
  }
  const visit = (node, ctx) => {
    if (!node || typeof node.type !== "string") return;
    let inner = ctx;
    if (node.type === "CallExpression" && node.arguments.length > 0) {
      const chain = calleeChain(node.callee);
      const title =
        chain &&
        TEST_FNS.has(chain[0]) &&
        chain.slice(1).every((m) => MODIFIERS.has(m))
          ? titleOf(node.arguments[0])
          : null;
      if (title !== null) {
        const tags = tagsOf(node.arguments);
        inner = {
          quarantined:
            ctx.quarantined ||
            /@quarantine\b/.test(title) ||
            tags.includes("@quarantine"),
          notRun: ctx.notRun || chain.some((m) => NOT_RUN.has(m)),
        };
        const line = node.loc?.start.line ?? 0;
        const { ids, bad } = claimsInTitle(title);
        for (const b of bad) out.errors.push(`${file}:${line}: ${b}`);
        if (ids.length) out.claims.push({ file, line, title, ids, ...inner });
      }
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) for (const c of v) visit(c, inner);
      else if (v && typeof v.type === "string") visit(v, inner);
    }
  };
  visit(program, { quarantined: false, notRun: false });
}

const RUST_FN =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;

function readRustClaims(file, text, out) {
  const raw = text.split("\n");
  const code = rustCode(text).split("\n");
  let pending = [];
  raw.forEach((line, i) => {
    const c = code[i].trim();
    const r = line.trim();
    // Blank lines, comments and attributes lead up to the item they belong to.
    if (r === "" || (c === "" && r.startsWith("//")) || /^#!?\[/.test(c)) {
      pending.push(r);
      return;
    }
    const fn = RUST_FN.exec(c);
    if (fn) {
      const ids = [];
      const bad = [];
      const byName = /^uxi_t(\d{2})(?=_|$)/.exec(fn[1]);
      if (byName) ids.push(`UXI-T${byName[1]}`);
      else if (/^uxi_t/.test(fn[1]))
        bad.push(`fn ${fn[1]} starts uxi_t but is not uxi_tNN_…`);
      for (const p of pending) {
        if (!p.startsWith("///")) continue;
        const found = claimsInTitle(p.replace(/^\/\/\/\s?/, ""));
        ids.push(...found.ids);
        bad.push(...found.bad);
      }
      for (const b of bad) out.errors.push(`${file}:${i + 1}: ${b}`);
      if (ids.length)
        out.claims.push({
          file,
          line: i + 1,
          title: fn[1],
          ids: [...new Set(ids)],
          quarantined: false,
          notRun: pending.some((p) => /^#\[ignore\b/.test(p)),
        });
    }
    pending = [];
  });
}

/**
 * Read the claims in `files` (repository-relative); with `candidates`, only
 * the files in it are read. Returns `{ claims, errors, filesRead }`, each
 * claim with its file, line, title, ids, layers and whether it counts.
 */
export function readClaims(root, files, { candidates = null } = {}) {
  const out = { claims: [], errors: [], filesRead: 0 };
  for (const file of files) {
    if (isSkippedPath(file)) continue;
    const ext = file.slice(file.lastIndexOf(".") + 1);
    if (!SOURCE_EXTENSIONS.includes(ext)) continue;
    if (candidates && !candidates.has(file)) continue;
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (!candidates && !/UXI-T\d|@uxi:|uxi_t\d/.test(text)) continue;
    if (!isTestFile(file, text)) continue;
    out.filesRead++;
    const before = out.claims.length;
    if (ext === "rs") readRustClaims(file, text, out);
    else readTsClaims(file, text, out);
    const layers = claimLayers(file, text);
    for (let i = before; i < out.claims.length; i++)
      out.claims[i].layers = layers;
  }
  return out;
}

/** Every claim in the repository: `git grep` finds the candidate files, or
 *  without git the whole tree is walked. */
export function readRepositoryClaims(root = ROOT) {
  const candidates = gitGrepFiles(root, CLAIM_GREP);
  const files = candidates ? [...candidates].sort() : listFiles(root, ["."]);
  return readClaims(root, files, { candidates });
}

/** The quarantine list's entries as (file suffix, title) pairs: a claim
 *  whose test an entry names claims nothing, tag or not. */
export function quarantinedTests(file = QUARANTINE) {
  if (!existsSync(file)) return [];
  const { entries = [] } = readJson(file);
  return entries.map((e) => {
    const parts = String(e.id).split(" › ");
    return { file: parts[0], title: parts[parts.length - 1] };
  });
}

// ── the computation ──────────────────────────────────────────────────

export const loadAcknowledged = (file = ACKNOWLEDGED) => {
  const data = readJson(file);
  const entries = { ...data };
  delete entries.$comment;
  return { comment: data.$comment, entries };
};

/**
 * Grade every UXI test and requirement against the claims. Pure: the
 * caller reads the files. `plan` is the plan's task ids (null skips that
 * check).
 */
export function computeCoverage({
  inventory,
  claims,
  readErrors = [],
  acknowledged,
  quarantine = [],
  plan = null,
  today,
}) {
  const errors = [...readErrors];
  const tests = new Map(inventory.tests.map((t) => [t.id, t]));
  const reqs = new Map(inventory.requirements.map((r) => [r.id, r]));

  // Which claims count.
  for (const c of claims) {
    if (
      !c.quarantined &&
      quarantine.some((q) => c.file.endsWith(q.file) && q.title === c.title)
    )
      c.quarantined = true;
    c.counts = !c.quarantined && !c.notRun;
    for (const id of c.ids)
      if (!tests.has(id) && !reqs.has(id))
        errors.push(
          `${c.file}:${c.line}: ${id} is not a UXI test or requirement of the inventory (a typo, or the spec dropped it)`,
        );
  }
  const counted = claims.filter((c) => c.counts);
  const claimsOf = (id) => counted.filter((c) => c.ids.includes(id));

  // The acknowledged entries.
  const ackProblems = [];
  for (const [id, entry] of Object.entries(acknowledged.entries)) {
    if (!tests.has(id)) {
      ackProblems.push(
        `${id}: not a UXI test of the inventory; --prune drops it`,
      );
      continue;
    }
    if (typeof entry?.task !== "string" || !TASK_ID.test(entry.task))
      ackProblems.push(
        `${id}: "task" must name the plan task that will claim it (W0.n, KFn, ICn, ENn, WSn, DFn, FIn, CMn, APn or PXn)`,
      );
    else if (plan && !plan.has(entry.task))
      ackProblems.push(
        `${id}: task ${entry.task} is not a task of ${PLAN_PATH}`,
      );
    if (
      typeof entry?.reason !== "string" ||
      entry.reason.trim().length < MIN_REASON
    )
      ackProblems.push(
        `${id}: "reason" must say why no test claims it yet (at least ${MIN_REASON} characters)`,
      );
  }

  const live = inventory.exceptions.filter((e) => !expired(e, today));
  const gradedTests = inventory.tests.map((t) => {
    const by = claimsOf(t.id);
    const layers = new Set(by.flatMap((c) => [...c.layers]));
    const ack = acknowledged.entries[t.id] ?? null;
    return {
      id: t.id,
      group: t.group,
      title: t.title,
      gates: t.gates,
      fixture: t.fixture,
      expectedLayers: t.layers,
      claimedLayers: CLAIM_LAYERS.filter((l) => layers.has(l)),
      layersWithoutEvidence: t.layers.filter(
        (l) => !EVIDENCE[l].some((e) => layers.has(e)),
      ),
      claims: by.map((c) => `${c.file}:${c.line}`),
      covered: by.length > 0,
      acknowledged: ack,
      exceptions: live.filter((e) => e.tests?.includes(t.id)).map((e) => e.id),
      state: by.length ? "covered" : ack ? "acknowledged" : "missing",
    };
  });
  const lost = gradedTests.filter((t) => !t.covered && !t.acknowledged);
  const stale = gradedTests.filter((t) => t.covered && t.acknowledged);

  // Requirements: proved through a covered test, or claimed directly.
  const viaTests = new Map();
  for (const t of gradedTests)
    if (t.covered)
      for (const r of tests.get(t.id).requirements) {
        if (!viaTests.has(r)) viaTests.set(r, []);
        viaTests.get(r).push(t.id);
      }
  const gradedReqs = inventory.requirements.map((r) => {
    const direct = claimsOf(r.id).map((c) => `${c.file}:${c.line}`);
    const via = viaTests.get(r.id) ?? [];
    return {
      id: r.id,
      domain: r.domain,
      section: r.section,
      viaTests: via,
      direct,
      covered: via.length > 0 || direct.length > 0,
    };
  });

  // Gates.
  const gates = inventory.gates.map((g) => {
    const ts = gradedTests.filter((t) => t.gates.includes(g.id));
    return {
      id: g.id,
      name: g.name,
      tests: ts.length,
      covered: ts.filter((t) => t.covered).length,
      excepted: ts.filter((t) => !t.covered && t.exceptions.length).length,
      enforced: inventory.enforcedGates.includes(g.id),
      open: ts
        .filter((t) => !t.covered && t.exceptions.length === 0)
        .map((t) => t.id),
    };
  });
  const gateFailures = gates
    .filter((g) => g.enforced)
    .flatMap((g) => g.open.map((id) => ({ gate: g.id, id })));

  // Floors: an inventory that lost its tests passes everything.
  const floors = [];
  if (inventory.tests.length < FLOORS.tests)
    floors.push(
      `the inventory lists ${inventory.tests.length} UXI tests, under the floor of ${FLOORS.tests}`,
    );
  if (inventory.requirements.length < FLOORS.requirements)
    floors.push(
      `the inventory lists ${inventory.requirements.length} requirements, under the floor of ${FLOORS.requirements}`,
    );

  return {
    tests: gradedTests,
    requirements: gradedReqs,
    gates,
    claims,
    errors,
    ackProblems,
    lost,
    stale,
    gateFailures,
    floors,
  };
}

// ── the report ───────────────────────────────────────────────────────

export function buildReport(r, inventory) {
  const byLayer = Object.fromEntries(
    CLAIM_LAYERS.map((l) => [
      l,
      r.tests.filter((t) => t.claimedLayers.includes(l)).length,
    ]),
  );
  const domains = {};
  for (const q of r.requirements) {
    domains[q.domain] ??= { ids: 0, covered: 0 };
    domains[q.domain].ids++;
    if (q.covered) domains[q.domain].covered++;
  }
  return {
    schema: 1,
    totals: {
      tests: r.tests.length,
      covered: r.tests.filter((t) => t.covered).length,
      acknowledged: r.tests.filter((t) => !t.covered && t.acknowledged).length,
      missing: r.lost.length,
      requirements: r.requirements.length,
      requirementsCovered: r.requirements.filter((q) => q.covered).length,
      claims: r.claims.length,
      claimsCounted: r.claims.filter((c) => c.counts).length,
    },
    enforcedGates: inventory.enforcedGates,
    groups: inventory.groups.map((g) => {
      const ts = r.tests.filter((t) => t.group === g.id);
      return {
        id: g.id,
        title: g.title,
        tests: ts.length,
        covered: ts.filter((t) => t.covered).length,
        acknowledged: ts.filter((t) => !t.covered && t.acknowledged).length,
        missing: ts.filter((t) => !t.covered && !t.acknowledged).length,
      };
    }),
    gates: r.gates,
    byLayer,
    domains,
    tests: r.tests.map((t) => ({
      id: t.id,
      group: t.group,
      gates: t.gates,
      fixture: t.fixture,
      state: t.state,
      task: t.acknowledged?.task,
      expectedLayers: t.expectedLayers,
      claimedLayers: t.claimedLayers,
      layersWithoutEvidence: t.layersWithoutEvidence,
      claims: t.claims,
      exceptions: t.exceptions,
    })),
    requirements: r.requirements,
    notCounted: r.claims
      .filter((c) => !c.counts)
      .map((c) => ({
        at: `${c.file}:${c.line}`,
        ids: c.ids,
        why: c.quarantined ? "quarantined" : "skipped",
      })),
  };
}

export function markdownReport(report) {
  const t = report.totals;
  const lines = [];
  lines.push("## Interaction contract coverage");
  lines.push("");
  lines.push(
    `**${t.covered} of ${t.tests}** UXI acceptance tests are claimed by a test; ` +
      `${t.acknowledged} acknowledged with their target task, ${t.missing} missing. ` +
      `Requirements proved (through a claimed test, or claimed directly): **${t.requirementsCovered} of ${t.requirements}**. ` +
      `Enforced gates: ${report.enforcedGates.join(", ") || "none"}.`,
  );
  lines.push("");
  lines.push("| group | tests | claimed | acknowledged | missing |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const g of report.groups)
    lines.push(
      `| ${g.id} — ${g.title} | ${g.tests} | ${g.covered} | ${g.acknowledged} | ${g.missing} |`,
    );
  lines.push("");
  lines.push("| gate | tests | claimed | excused by an exception | enforced |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const g of report.gates)
    lines.push(
      `| ${g.id} — ${g.name} | ${g.tests} | ${g.covered} | ${g.excepted} | ${g.enforced ? "yes" : "no"} |`,
    );
  lines.push("");
  lines.push(
    `Tests with a claim per layer: ${CLAIM_LAYERS.map((l) => `${l} ${report.byLayer[l]}`).join(" · ")}.`,
  );
  lines.push("");
  lines.push(
    `Requirements proved per domain: ${Object.entries(report.domains)
      .map(([d, c]) => `${d} ${c.covered}/${c.ids}`)
      .join(" · ")}.`,
  );
  const claimed = report.tests.filter((x) => x.state === "covered");
  if (claimed.length) {
    lines.push("");
    lines.push(
      "| test | layers claimed | expected layers without evidence | claims |",
    );
    lines.push("| --- | --- | --- | --- |");
    for (const x of claimed)
      lines.push(
        `| ${x.id} | ${x.claimedLayers.join(", ")} | ${x.layersWithoutEvidence.join(", ") || "—"} | ${x.claims.slice(0, 3).join("<br>")}${x.claims.length > 3 ? ` (+${x.claims.length - 3})` : ""} |`,
      );
  }
  if (report.notCounted.length) {
    lines.push("");
    lines.push("Claims that do not count (quarantined or skipped):");
    for (const c of report.notCounted.slice(0, 50))
      lines.push(`- ${c.at}: ${c.ids.join(", ")} (${c.why})`);
  }
  return `${lines.join("\n")}\n`;
}

// ── run ──────────────────────────────────────────────────────────────

function main(argv) {
  const inventory = readJson(INVENTORY);
  const acknowledged = loadAcknowledged();
  const read = readRepositoryClaims(ROOT);
  const r = computeCoverage({
    inventory,
    claims: read.claims,
    readErrors: read.errors,
    acknowledged,
    quarantine: quarantinedTests(),
    plan: planTasks(ROOT),
    today: todayIso(),
  });

  if (argv.includes("--prune")) {
    const drop = new Set([
      ...r.stale.map((t) => t.id),
      ...Object.keys(acknowledged.entries).filter(
        (id) => !inventory.tests.some((t) => t.id === id),
      ),
    ]);
    const kept = Object.fromEntries(
      Object.entries(acknowledged.entries)
        .filter(([id]) => !drop.has(id))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    writeFileSync(
      ACKNOWLEDGED,
      `${JSON.stringify({ $comment: acknowledged.comment, ...kept }, null, 2)}\n`,
    );
    formatFiles([ACKNOWLEDGED]);
    console.log(
      `uxi-coverage --prune: ${drop.size} entr(ies) removed, ${Object.keys(kept).length} kept.`,
    );
    return 0;
  }

  const report = buildReport(r, inventory);
  const md = markdownReport(report);
  const at = argv.indexOf("--json");
  if (at >= 0) {
    const next = argv[at + 1];
    const path = next && !next.startsWith("--") ? next : REPORT_JSON;
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
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
    "the floors (an inventory that lost its tests would pass everything)",
    r.floors,
  );
  fail("claims the report cannot read, or that name no UXI id", r.errors);
  fail("uxi-acknowledged.json", r.ackProblems);
  fail(
    "UXI tests no test claims and uxi-acknowledged.json does not list (a claim was lost, or the spec added a test): " +
      "claim it in a test title (UXI-Tnn — …), or acknowledge it with its task and a reason",
    r.lost.map((t) => `${t.id}  ${t.title}`),
  );
  fail(
    "acknowledged UXI tests a test claims now: remove the entries (bun scripts/uxi-coverage.mjs --prune)",
    r.stale.map((t) => `${t.id}  (${t.claims.slice(0, 2).join(", ")})`),
  );
  if (argv.includes("--gate"))
    fail(
      "tests of an enforced gate that no test claims and no unexpired exception excuses",
      r.gateFailures.map((g) => `${g.gate}: ${g.id}`),
    );
  if (failed) return 1;
  console.log(
    `uxi coverage OK: ${report.totals.covered}/${report.totals.tests} UXI tests claimed, ` +
      `${report.totals.acknowledged} acknowledged; requirements ${report.totals.requirementsCovered}/${report.totals.requirements}; ` +
      `enforced gates: ${report.enforcedGates.join(", ") || "none"}.`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
