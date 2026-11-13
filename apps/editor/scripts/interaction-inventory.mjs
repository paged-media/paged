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
 * THE INTERACTION INVENTORY GUARD (editor ADR 1202; the contract is adopted
 * by ADR 1200). `interaction-inventory.json` is the machine-readable
 * companion of the interaction specification
 * (apps/editor/docs/specs/ideas/paged_interaction_specification.md, §26
 * "Recommended next artifacts"):
 *
 *   requirements   every UXI-<DOMAIN>-### id of the spec, with its section
 *                  and title: written by --sync from the spec, never by hand
 *   tests          UXI-T01…T76 (§23.1): group, steps and assertion from the
 *                  spec; gates, fixture, layers and the requirements each
 *                  proves are curated here
 *   interactions   each user gesture, tool, context and key the editor
 *                  answers, with its owner (§3.2), event class, adapter,
 *                  states, permission and cancel behaviour, real surface ids
 *                  and status (legacy | migrated | exception)
 *   exceptions     the one exception ledger (UXI-MIG-004, ADR 1200)
 *   enforcedGates  the gates G0–G4 the coverage report enforces
 *
 * The owner, phase, group, fixture, gate and layer vocabularies come from
 * the spec too (--sync). The spec is the source; this guard fails when the
 * inventory says something else.
 *
 * WHAT IT CHECKS. The inventory is valid against its schema; the spec-derived
 * sections equal what the spec says today; every id it references resolves
 * (requirements, tests, owners, gates, fixtures, layers, interactions,
 * enumerated surface ids, source files); no exception is past its expiry; no
 * two interactions with different owners claim the same event class in the
 * same scope unless an exception that names UXI-MIG-002 lists one of them
 * (UXI-MIG-002); and when the shell's owners module exists it names every
 * owner (it mirrors this list).
 *
 * FAIL-OPEN IS THE REAL RISK: a spec parser that stops matching would sync
 * the inventory down to nothing and pass. So every id the spec MENTIONS must
 * be one it DEFINES in a form the parser reads, and every section has a
 * floor (FLOORS).
 *
 *   bun scripts/interaction-inventory.mjs           the guard (also --check)
 *   bun scripts/interaction-inventory.mjs --sync    rewrite the spec-derived sections, then check
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { enumerateSurface } from "./surface/enumerate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../../..");
export const INVENTORY = join(HERE, "interaction-inventory.json");
export const SCHEMA = join(HERE, "interaction-inventory.schema.json");
export const SPEC_PATH =
  "apps/editor/docs/specs/ideas/paged_interaction_specification.md";
/** The shell module that will mirror the owner names (plan IC1). */
export const OWNERS_TS = "apps/editor/packages/shell/src/interaction/owners.ts";
/** The plan whose task ids (`- **KF1 …`) exceptions and acknowledged
 *  entries name. */
export const PLAN_PATH = "apps/editor/docs/interaction-plan.md";
/** A plan task id: W0.n or a track and a number. */
export const TASK_ID = /^(W0\.\d+|(KF|IC|EN|WS|DF|FI|CM|AP|PX)\d{1,2})$/;

/** The plan's task ids, or null when the plan is not there. */
export function planTasks(root = ROOT) {
  const file = join(root, PLAN_PATH);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  return new Set(
    [
      ...text.matchAll(
        /^- \*\*(W0\.\d+|(?:KF|IC|EN|WS|DF|FI|CM|AP|PX)\d+)\b/gm,
      ),
    ].map((m) => m[1]),
  );
}

/** Anti-fail-open floors: the spec as adopted on 2026-11-13 (290
 *  requirement ids, 76 tests, 12 owners, 7 phases, 6 groups, 8 fixtures,
 *  5 gates, 8 layers) and the interactions seeded that day. Lower one only
 *  on purpose, in the commit that shrinks what it counts. */
export const FLOORS = {
  requirements: 290,
  tests: 76,
  owners: 12,
  phases: 7,
  groups: 6,
  fixtures: 8,
  gates: 5,
  layers: 8,
  interactions: 60,
};

/** §23.2's layer names, and the ids the tests and the coverage report use. */
export const LAYER_IDS = {
  "Unit/property tests": "unit",
  "Shell component tests": "component",
  "WASM/engine channel": "engine",
  "Browser journey (CPU)": "journey-cpu",
  "Browser journey (GPU)": "journey-gpu",
  "Visual regression": "visual",
  "Accessibility manual": "a11y-manual",
  "Chaos/stress": "chaos",
};

const REQUIREMENT = /^UXI-[A-Z0-9]+-\d{3}$/;
const TEST = /^UXI-T\d{2}$/;
const GITHUB_ISSUE =
  /^(https:\/\/github\.com\/paged-media\/paged\/issues\/\d+|#\d+)$/;

// ── the spec ─────────────────────────────────────────────────────────

/** Markdown inline markup out: bold, code, italics, links. */
export function plain(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const TITLE_MAX = 220;

/** A requirement's title: its first sentence, plain, at most TITLE_MAX
 *  characters (cut at a word, with an ellipsis). */
export function titleOf(text) {
  const s = plain(text);
  const m = /^(.+?[.!?])(?=\s+[A-Z(]|$)/.exec(s);
  let t = m ? m[1] : s;
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX);
    t = `${cut.slice(0, cut.lastIndexOf(" "))}…`;
  }
  return t;
}

const domainOf = (id) => id.split("-")[1];

/** The string members of a `type <name> = | "a" | "b";` union in the spec. */
function unionOf(text, name) {
  const m = new RegExp(`type ${name} =([^;]+);`).exec(text);
  return m ? [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]) : [];
}

/**
 * Everything the inventory takes from the spec. `mentioned` is every
 * requirement id the text contains anywhere, for the fail-open check.
 */
export function parseSpec(text) {
  const out = {
    requirements: [],
    tests: [],
    groups: [],
    fixtures: [],
    gates: [],
    layers: [],
    owners: unionOf(text, "InteractionOwner"),
    phases: unionOf(text, "InteractionPhase"),
    mentioned: new Set(text.match(/UXI-[A-Z0-9]+-\d{3}/g) ?? []),
  };
  let section = null;
  let group = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^## (\d+)\. /.exec(line))) {
      section = m[1];
      group = null;
      continue;
    }
    if ((m = /^### (\d+\.\d+) (.+)$/.exec(line))) {
      section = m[1];
      group = null;
      const h = /^(.*?) \(`(UXI-[A-Z0-9]+-\d{3})`\)$/.exec(m[2]);
      if (h)
        out.requirements.push({
          id: h[2],
          domain: domainOf(h[2]),
          section,
          title: plain(h[1]),
        });
      continue;
    }
    if ((m = /^#### ([A-Z])\. (.+)$/.exec(line))) {
      group = m[1];
      out.groups.push({ id: m[1], title: plain(m[2]) });
      continue;
    }
    if (
      (m = /^\| `(UXI-[A-Z0-9]+-\d{3})` +\| (.+?) +\|$/.exec(line)) ||
      (m = /^`(UXI-[A-Z0-9]+-\d{3})` — (.+)$/.exec(line))
    ) {
      out.requirements.push({
        id: m[1],
        domain: domainOf(m[1]),
        section,
        title: titleOf(m[2]),
      });
      continue;
    }
    if ((m = /^\| `(UXI-T\d{2})` +\| (.+?) +\| (.+?) +\|$/.exec(line))) {
      out.tests.push({
        id: m[1],
        group,
        title: plain(m[2]),
        assertion: plain(m[3]),
      });
      continue;
    }
    if ((m = /^Use fixtures for: (.+)$/.exec(line))) {
      for (const f of m[1].matchAll(
        /\(([A-Z])\) ([^;]+?)(?=; \([A-Z]\)|\.?$)/g,
      ))
        out.fixtures.push({ id: f[1], description: plain(f[2]) });
      continue;
    }
    if ((m = /^\*\*Gate (G\d) — (.+?):\*\* (.+)$/.exec(line))) {
      out.gates.push({ id: m[1], name: plain(m[2]), criterion: plain(m[3]) });
      continue;
    }
    if (
      section === "23.2" &&
      (m = /^\| ([^|]+?) +\| ([^|]+?) +\|$/.exec(line))
    ) {
      const name = m[1].trim();
      if (name === "Layer" || /^-+$/.test(name)) continue;
      out.layers.push({
        id: LAYER_IDS[name] ?? null,
        name,
        evidence: plain(m[2]),
      });
    }
  }
  return out;
}

// ── the schema (the subset of JSON Schema 2020-12 the schema file uses) ──

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "title",
  "description",
  "default",
  "examples",
]);
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  "$ref",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "format",
  "minItems",
  "uniqueItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const typeOf = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const isDate = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Validate `value` against `schema`. A keyword this validator does not know
 * THROWS: a constraint it skipped would pass everything it was written to
 * refuse.
 */
export function validate(schema, value, root = schema, path = "$") {
  for (const k of Object.keys(schema))
    if (!KEYWORDS.has(k))
      throw new Error(`schema keyword "${k}" (at ${path}) is not supported`);
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    if (!m || !root.$defs?.[m[1]])
      throw new Error(`schema $ref "${schema.$ref}" does not resolve`);
    if (Object.keys(schema).some((k) => k !== "$ref" && !ANNOTATIONS.has(k)))
      throw new Error(`schema $ref at ${path} has sibling constraints`);
    return validate(root.$defs[m[1]], value, root, path);
  }
  const errors = [];
  const at = (message) => errors.push(`${path}: ${message}`);
  if (schema.type) {
    const types = [schema.type].flat();
    if (!types.includes(typeOf(value))) {
      at(`is ${typeOf(value)}, expected ${types.join(" | ")}`);
      return errors;
    }
  }
  if ("const" in schema && !same(value, schema.const))
    at(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => same(e, value)))
    at(`${JSON.stringify(value)} is not one of: ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      at(`"${value}" does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      at(`is shorter than ${schema.minLength} characters`);
    if (schema.format === "date" && !isDate(value))
      at(`"${value}" is not a YYYY-MM-DD date`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      at(`has ${value.length} items, fewer than ${schema.minItems}`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const v of value) {
        const key = JSON.stringify(v);
        if (seen.has(key)) at(`lists ${key} twice`);
        seen.add(key);
      }
    }
    if (schema.items)
      value.forEach((v, i) =>
        errors.push(...validate(schema.items, v, root, `${path}[${i}]`)),
      );
  }
  if (isObject(value)) {
    for (const r of schema.required ?? [])
      if (!(r in value)) at(`is missing "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k])
        errors.push(...validate(schema.properties[k], v, root, `${path}.${k}`));
      else if (schema.additionalProperties === false)
        at(`has an unknown property "${k}"`);
      else if (isObject(schema.additionalProperties))
        errors.push(
          ...validate(schema.additionalProperties, v, root, `${path}.${k}`),
        );
    }
  }
  return errors;
}

// ── sync ─────────────────────────────────────────────────────────────

/** The spec's ids, row by row, against the inventory's: added, removed and
 *  changed (by field). Empty when they agree. */
function diffRows(label, want, have, fields) {
  const byId = new Map(have.map((r) => [r.id, r]));
  const wantIds = new Set(want.map((r) => r.id));
  const added = want.filter((r) => !byId.has(r.id)).map((r) => r.id);
  const removed = have.filter((r) => !wantIds.has(r.id)).map((r) => r.id);
  const changed = [];
  for (const r of want) {
    const h = byId.get(r.id);
    if (!h) continue;
    const fs = fields.filter((f) => !same(r[f], h[f]));
    if (fs.length) changed.push(`${r.id} (${fs.join(", ")})`);
  }
  const order =
    added.length || removed.length
      ? false
      : !same(
          want.map((r) => r.id),
          have.map((r) => r.id),
        );
  const parts = [];
  const list = (xs) =>
    `${xs.slice(0, 8).join(", ")}${xs.length > 8 ? `, … ${xs.length - 8} more` : ""}`;
  if (added.length)
    parts.push(`${added.length} in the spec only: ${list(added)}`);
  if (removed.length)
    parts.push(`${removed.length} in the inventory only: ${list(removed)}`);
  if (changed.length) parts.push(`${changed.length} differ: ${list(changed)}`);
  if (order) parts.push("the order differs from the spec's");
  return parts.length ? [`${label}: ${parts.join("; ")}`] : [];
}

/** Where the inventory and the spec disagree on what the spec decides. */
export function syncProblems(inv, spec) {
  const problems = [
    ...diffRows("requirements", spec.requirements, inv.requirements ?? [], [
      "domain",
      "section",
      "title",
    ]),
    ...diffRows("tests", spec.tests, inv.tests ?? [], [
      "group",
      "title",
      "assertion",
    ]),
    ...diffRows("groups", spec.groups, inv.groups ?? [], ["title"]),
    ...diffRows("fixtures", spec.fixtures, inv.fixtures ?? [], ["description"]),
    ...diffRows("gates", spec.gates, inv.gates ?? [], ["name", "criterion"]),
    ...diffRows("layers", spec.layers, inv.layers ?? [], ["name", "evidence"]),
  ];
  if (!same(spec.owners, inv.owners))
    problems.push(
      `owners: the spec's InteractionOwner (§3.2) is [${spec.owners.join(", ")}]`,
    );
  if (!same(spec.phases, inv.phases))
    problems.push(
      `phases: the spec's InteractionPhase (§3.2) is [${spec.phases.join(", ")}]`,
    );
  return problems;
}

/** The inventory with every spec-derived section rewritten from the spec,
 *  the curated fields of each test kept (a new test starts empty, and the
 *  guard then asks for them). */
export function syncInventory(inv, spec) {
  const tests = new Map((inv.tests ?? []).map((t) => [t.id, t]));
  return {
    $schema: "./interaction-inventory.schema.json",
    $comment: inv.$comment,
    spec: SPEC_PATH,
    owners: spec.owners,
    phases: spec.phases,
    groups: spec.groups,
    fixtures: spec.fixtures,
    gates: spec.gates,
    layers: spec.layers,
    requirements: spec.requirements,
    tests: spec.tests.map((t) => {
      const had = tests.get(t.id) ?? {};
      return {
        ...t,
        gates: had.gates ?? [],
        fixture: had.fixture ?? "",
        layers: had.layers ?? [],
        requirements: had.requirements ?? [],
      };
    }),
    interactions: inv.interactions ?? [],
    exceptions: inv.exceptions ?? [],
    enforcedGates: inv.enforcedGates ?? [],
  };
}

// ── the checks ───────────────────────────────────────────────────────

/** The enumerated surface as a lookup: `kind:id`, or a member of a family. */
export function surfaceLookup(surface) {
  const keys = new Set(surface.items.map((i) => `${i.kind}:${i.id}`));
  const members = new Set(
    surface.items
      .filter((i) => i.family)
      .flatMap((i) => i.members.map((m) => `${i.kind}:${m}`)),
  );
  return (key) => keys.has(key) || members.has(key);
}

/** Is exception `e` past its expiry on `today` (YYYY-MM-DD)? */
export const expired = (e, today) => isDate(e.expiry) && today > e.expiry;

/**
 * Every problem with the inventory, as strings; empty means it holds.
 * `surface` is enumerate.mjs's result (null skips the surface-id check, for
 * tests); `plan` the plan's task ids (null skips that check); `today` is
 * YYYY-MM-DD; `root` resolves the interactions' sites.
 */
export function checkInventory(
  inv,
  { spec, schema, surface = null, plan = null, today, root = ROOT },
) {
  const errors = [];
  const err = (m) => errors.push(m);

  // The schema first: everything below assumes the shape.
  for (const e of validate(schema, inv)) err(`schema: ${e}`);
  if (errors.length) return errors;

  // The spec parser: every id the spec mentions is one it defines, once.
  const defined = new Map();
  for (const r of spec.requirements)
    defined.set(r.id, (defined.get(r.id) ?? 0) + 1);
  for (const id of spec.mentioned)
    if (!defined.has(id))
      err(
        `spec: ${id} is mentioned but not defined in a form this guard reads ` +
          "(a table row | `UXI-…` | text |, a line `UXI-…` — text, or a ### heading (`UXI-…`))",
      );
  for (const [id, n] of defined)
    if (n > 1) err(`spec: ${id} is defined ${n} times`);
  for (const l of spec.layers)
    if (!l.id)
      err(
        `spec: §23.2 layer "${l.name}" has no id in LAYER_IDS (interaction-inventory.mjs)`,
      );
  for (const [section, floor] of Object.entries(FLOORS)) {
    if (section === "interactions") continue;
    const got = spec[section]?.length ?? 0;
    if (got < floor)
      err(
        `spec: ${got} ${section} parsed, under the floor of ${floor} (the parser lost its footing, or the spec shrank: lower the floor deliberately)`,
      );
  }

  // In sync with the spec.
  for (const p of syncProblems(inv, spec))
    err(
      `out of sync with the spec, ${p}. Run: bun scripts/interaction-inventory.mjs --sync`,
    );
  if (inv.interactions.length < FLOORS.interactions)
    err(
      `${inv.interactions.length} interactions, under the floor of ${FLOORS.interactions}`,
    );

  // References.
  const reqs = new Set(inv.requirements.map((r) => r.id));
  const tests = new Set(inv.tests.map((t) => t.id));
  const owners = new Set(inv.owners);
  const phases = new Set(inv.phases);
  const gates = new Set(inv.gates.map((g) => g.id));
  const fixtures = new Set(inv.fixtures.map((f) => f.id));
  const layers = new Set(inv.layers.map((l) => l.id));
  const unknownIn = (what, ids, known, kind) => {
    for (const id of ids)
      if (!known.has(id)) err(`${what}: ${id} is not ${kind}`);
  };

  for (const t of inv.tests) {
    unknownIn(t.id, t.gates, gates, "a gate of §23.4");
    unknownIn(t.id, [t.fixture], fixtures, "a fixture of §23.1");
    unknownIn(t.id, t.layers, layers, "a layer of §23.2");
    unknownIn(t.id, t.requirements, reqs, "a requirement id of the spec");
  }

  const isSurface = surface ? surfaceLookup(surface) : null;
  const interactionIds = new Map();
  for (const x of inv.interactions) {
    interactionIds.set(x.id, (interactionIds.get(x.id) ?? 0) + 1);
    unknownIn(x.id, [x.owner], owners, "an owner of §3.2");
    unknownIn(x.id, x.states, phases, "a phase of §3.2");
    unknownIn(x.id, x.uxi, reqs, "a requirement id of the spec");
    if (isSurface)
      for (const s of x.surfaceIds)
        if (!isSurface(s))
          err(
            `${x.id}: ${s} is not an enumerated surface id (scripts/surface/enumerate.mjs)`,
          );
    if (!existsSync(join(root, x.site)))
      err(`${x.id}: site ${x.site} does not exist`);
  }
  for (const [id, n] of interactionIds)
    if (n > 1) err(`interactions: ${id} is listed ${n} times`);

  // The exception ledger.
  const excusedForMig002 = new Set();
  const listedByAnException = new Set();
  const exceptionIds = new Set();
  for (const e of inv.exceptions) {
    if (exceptionIds.has(e.id)) err(`exceptions: ${e.id} is listed twice`);
    exceptionIds.add(e.id);
    unknownIn(e.id, e.contract, reqs, "a requirement id of the spec");
    unknownIn(e.id, e.interactions ?? [], interactionIds, "an interaction");
    unknownIn(e.id, e.tests ?? [], tests, "a UXI test");
    if (expired(e, today))
      err(
        `${e.id}: EXPIRED on ${e.expiry} (owner ${e.owner}): retire it, or decide again with a new expiry and a reason that says what changed`,
      );
    for (const i of e.interactions ?? []) {
      listedByAnException.add(i);
      if (e.contract.includes("UXI-MIG-002") && !expired(e, today))
        excusedForMig002.add(i);
    }
    if (plan && TASK_ID.test(e.issue) && !plan.has(e.issue))
      err(`${e.id}: issue ${e.issue} is not a task of ${PLAN_PATH}`);
    if (inv.enforcedGates.includes("G4") && !GITHUB_ISSUE.test(e.issue))
      err(
        `${e.id}: gate G4 is enforced, and it requires every exception to link an issue (the spec, §23.4); "${e.issue}" is not one`,
      );
  }
  for (const x of inv.interactions)
    if (x.status === "exception" && !listedByAnException.has(x.id))
      err(
        `${x.id}: status "exception" without an exception entry that lists it`,
      );

  // UXI-MIG-002: one owner per event class and scope.
  const byClass = new Map();
  for (const x of inv.interactions) {
    const key = `${x.eventClass} @ ${x.scope}`;
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(x);
  }
  for (const [key, xs] of byClass) {
    const open = xs.filter((x) => !excusedForMig002.has(x.id));
    if (new Set(open.map((x) => x.owner)).size > 1)
      err(
        `UXI-MIG-002: ${key} has more than one owner (${open
          .map((x) => `${x.id} → ${x.owner}`)
          .join(
            ", ",
          )}): narrow a scope, or list them in an exception that names UXI-MIG-002`,
      );
  }

  for (const g of inv.enforcedGates)
    if (!gates.has(g)) err(`enforcedGates: ${g} is not a gate of §23.4`);

  // The shell's owners module mirrors the owner names once it exists.
  const ownersTs = join(root, OWNERS_TS);
  if (existsSync(ownersTs)) {
    const text = readFileSync(ownersTs, "utf8");
    for (const o of inv.owners)
      if (!text.includes(`"${o}"`))
        err(`${OWNERS_TS} does not name the owner "${o}"`);
  }
  return errors;
}

// ── run ──────────────────────────────────────────────────────────────

/** Format files the scripts wrote (bun fmt through the repository wrapper);
 *  the checks compare data, so a failed format only costs a fmt check. */
export function formatFiles(files) {
  const res = spawnSync(
    "bash",
    [join(ROOT, "tooling/js/fmt.sh"), ...files.map((f) => relative(ROOT, f))],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (res.status !== 0)
    console.error(
      `! could not format ${files.map((f) => relative(ROOT, f)).join(", ")}; run tooling/js/fmt.sh on it`,
    );
}

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export const readSpec = (root = ROOT) =>
  parseSpec(readFileSync(join(root, SPEC_PATH), "utf8"));
export const todayIso = () =>
  process.env.UXI_TODAY ?? new Date().toISOString().slice(0, 10);

function main(argv) {
  const spec = readSpec();
  let inv = readJson(INVENTORY);
  if (argv.includes("--sync")) {
    inv = syncInventory(inv, spec);
    writeFileSync(INVENTORY, `${JSON.stringify(inv, null, 2)}\n`);
    formatFiles([INVENTORY]);
    console.log(
      `interaction-inventory --sync: ${inv.requirements.length} requirements, ${inv.tests.length} tests from ${SPEC_PATH}`,
    );
  }
  const errors = checkInventory(inv, {
    spec,
    schema: readJson(SCHEMA),
    surface: enumerateSurface(ROOT),
    plan: planTasks(ROOT),
    today: todayIso(),
  });
  if (errors.length) {
    console.error(`\n✗ the interaction inventory: ${errors.length} problem(s)`);
    for (const e of errors.slice(0, 200)) console.error(`    ${e}`);
    if (errors.length > 200)
      console.error(`    … and ${errors.length - 200} more`);
    return 1;
  }
  const status = {};
  for (const x of inv.interactions)
    status[x.status] = (status[x.status] ?? 0) + 1;
  console.log(
    `interaction inventory OK: ${inv.requirements.length} requirements, ${inv.tests.length} tests, ` +
      `${inv.interactions.length} interactions (${Object.entries(status)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ")}), ${inv.exceptions.length} exception(s), ` +
      `enforced gates: ${inv.enforcedGates.join(", ") || "none"}.`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
