#!/usr/bin/env node
/**
 * The feature-id inventory (docs/composable-editor-plan.md, B3; ADR 275).
 *
 * An embedding host switches features by id (`command:paged.object.lock`,
 * `panel:paged.layers`, `chrome:rulers`). Once hosts write those ids into
 * their profiles, the ids are a contract, so they are published as one
 * generated file, `apps/canvas/feature-ids.json`, that the embedding docs and
 * a host's tooling read. It is DERIVED: host and plugin surfaces come from
 * the surface inventory of ADR 227 (which reads plugin surfaces from each
 * bundle's manifest), host tools include planned ones, and the chrome ids
 * come from the shell's own list. `--check` regenerates and fails when the
 * committed file differs.
 *
 * Ids leave through a deprecation window (PM-0013, amendment 2). The committed file is the
 * ledger: an id it lists that the editor no longer has must be named in
 * `apps/canvas/deprecated-ids.json`, with its replacement and its window, and
 * the file mirrors those entries as `deprecated`. So both the write and the
 * check fail when:
 *
 *   · an id disappears without a deprecation entry;
 *   · an entry disappears before its window ends (`removeIn` is after the
 *     release the tree builds, `packages/editor/package.json`);
 *   · an entry outlives its window (the tree builds `removeIn` or later):
 *     the alias is removed in the release that `removeIn` names, no later;
 *   · an entry's old id is still a live id, its replacement is not one, or
 *     its window is shorter than two minor releases.
 *
 *   bun scripts/feature-ids.mjs                    # write
 *   bun scripts/feature-ids.mjs --check            # gate
 *   bun scripts/feature-ids.mjs --release-notes    # the deprecations, as Markdown
 *   bun scripts/feature-ids.mjs --check --release <version>   # at a tag
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_IN_TOOLS } from "../packages/tools/src/built-in-tools.ts";
import { CHROME_FEATURES } from "../packages/shell/src/state/features.ts";
import { enumerateSurface } from "./surface/enumerate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const TARGET = join(HERE, "../apps/canvas/feature-ids.json");
const DEPRECATED = join(HERE, "../apps/canvas/deprecated-ids.json");
const PACKAGE = join(HERE, "../packages/editor/package.json");

const KINDS = ["command", "panel", "tool", "menu", "keybinding"];
const surface = enumerateSurface(REPO);
const byId = new Map();
for (const item of surface.items) {
  if (!KINDS.includes(item.kind)) continue;
  const id = `${item.kind}:${item.id}`;
  if (!byId.has(id)) byId.set(id, { id, kind: item.kind, owner: item.owner });
}
for (const tool of BUILT_IN_TOOLS) {
  const id = `tool:${tool.id}`;
  if (!byId.has(id)) byId.set(id, { id, kind: "tool", owner: "editor" });
}
for (const name of CHROME_FEATURES) {
  byId.set(`chrome:${name}`, {
    id: `chrome:${name}`,
    kind: "chrome",
    owner: "editor",
  });
}

// Every chrome feature the code gates must be in the shell's list, or a
// host could never learn its id.
const SOURCES = [
  "packages/shell/src/cockpit/CockpitLayout.tsx",
  "packages/shell/src/chrome/CanvasContextMenu.tsx",
];
for (const file of SOURCES) {
  const src = readFileSync(join(HERE, "..", file), "utf8");
  for (const m of src.matchAll(/allows\("chrome",\s*"([^"]+)"\)/g)) {
    if (!CHROME_FEATURES.includes(m[1])) {
      console.error(
        `feature-ids: ${file} gates chrome:${m[1]}, which CHROME_FEATURES does not list`,
      );
      process.exit(1);
    }
  }
}

const features = [...byId.values()].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
);

// ── Deprecations (PM-0013, amendment 2) ────────────────────────────────────────

/** `0.76.0-dev` → [0, 76, 0]; the tree's version names the release it builds. */
function release(version, where) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version ?? "");
  if (!m) fail(`${where}: "${version}" is not a release version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function fail(message) {
  console.error(`feature-ids: ${message}`);
  process.exit(1);
}

const releaseArg = process.argv.indexOf("--release");
const building = release(
  releaseArg > 0
    ? process.argv[releaseArg + 1]
    : JSON.parse(readFileSync(PACKAGE, "utf8")).version,
  releaseArg > 0 ? "--release" : "packages/editor/package.json",
);

const source = JSON.parse(readFileSync(DEPRECATED, "utf8"));
if (!Array.isArray(source.deprecated))
  fail("deprecated-ids.json: `deprecated` is not a list");
const deprecated = source.deprecated
  .map((d, i) => {
    const where = `deprecated-ids.json [${i}] ${d?.id ?? ""}`;
    if (!d || typeof d.id !== "string" || !/^[a-z]+:./.test(d.id))
      fail(`${where}: \`id\` is not a feature id`);
    if (d.replacement !== null && typeof d.replacement !== "string")
      fail(`${where}: \`replacement\` is a feature id or null`);
    const from = release(d.deprecatedIn, `${where} deprecatedIn`);
    const until = release(d.removeIn, `${where} removeIn`);
    if (from[0] !== until[0] ? until[0] < from[0] : until[1] < from[1] + 2)
      fail(
        `${where}: the window ${d.deprecatedIn} → ${d.removeIn} is shorter than two minor releases`,
      );
    if (byId.has(d.id))
      fail(`${where}: the id is still the editor's; it is not deprecated`);
    if (d.replacement !== null && !byId.has(d.replacement))
      fail(`${where}: the replacement ${d.replacement} is not a feature id`);
    if (compare(building, until) >= 0)
      fail(
        `${where}: its window ended (removeIn ${d.removeIn}, the tree builds ${building.join(".")}); remove the alias`,
      );
    return {
      id: d.id,
      replacement: d.replacement,
      deprecatedIn: d.deprecatedIn,
      removeIn: d.removeIn,
    };
  })
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const deprecatedIds = new Set(deprecated.map((d) => d.id));
if (deprecatedIds.size !== deprecated.length)
  fail("deprecated-ids.json lists an id twice");

// The ledger: what the committed file promised.
let ledger = { features: [], deprecated: [] };
try {
  ledger = JSON.parse(readFileSync(TARGET, "utf8"));
} catch {
  /* missing: nothing promised yet */
}
const lost = (ledger.features ?? [])
  .map((f) => f.id)
  .filter((id) => !byId.has(id) && !deprecatedIds.has(id));
if (lost.length)
  fail(
    `${lost.length} id(s) left the editor without a deprecation entry in apps/canvas/deprecated-ids.json (PM-0013, amendment 2):\n  ${lost.join("\n  ")}`,
  );
const dropped = (ledger.deprecated ?? []).filter(
  (d) =>
    !deprecatedIds.has(d.id) &&
    compare(building, release(d.removeIn, `feature-ids.json ${d.id}`)) < 0,
);
if (dropped.length)
  fail(
    `deprecated-ids.json dropped an alias before its window ended:\n  ${dropped
      .map((d) => `${d.id} (removeIn ${d.removeIn})`)
      .join("\n  ")}`,
  );

if (process.argv.includes("--release-notes")) {
  console.log(
    deprecated.length === 0
      ? "No deprecated feature ids."
      : [
          "| Deprecated id | Replacement | Deprecated in | Removed in |",
          "| --- | --- | --- | --- |",
          ...deprecated.map(
            (d) =>
              `| \`${d.id}\` | ${d.replacement ? `\`${d.replacement}\`` : "none"} | ${d.deprecatedIn} | ${d.removeIn} |`,
          ),
        ].join("\n"),
  );
  process.exit(0);
}
const counts = {};
for (const f of features) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

const rendered = `${JSON.stringify(
  {
    $comment:
      "Feature ids an editor profile may switch (docs/composable-editor.md §6, ADR 275). Generated by apps/editor/scripts/feature-ids.mjs; CI fails when it is stale. Globs (`command:paged.object.*`) match these ids. `deprecated` lists ids that left, each read as its replacement until `removeIn` (PM-0013, amendment 2).",
    version: 1,
    counts,
    features,
    deprecated,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(TARGET, "utf8");
  } catch {
    /* missing: stale */
  }
  if (committed !== rendered) {
    console.error(
      "feature-ids: apps/canvas/feature-ids.json is stale — run `bun scripts/feature-ids.mjs`",
    );
    process.exit(1);
  }
  console.log(`feature ids OK — ${features.length} ids`);
} else {
  writeFileSync(TARGET, rendered);
  console.log(`feature ids written — ${features.length} ids`, counts);
}
