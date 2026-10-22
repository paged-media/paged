#!/usr/bin/env node
/**
 * Preset guard: a preset of the editor profile may not name a surface that
 * is not there (docs/composable-editor-plan.md, A6; it replaces the solo
 * profile guard of ADR 213).
 *
 * A preset is an ALLOW-LIST. It names the host panels, tools, menus, rail
 * launchers, commands and bundles an editor keeps. That direction is
 * deliberate (a deny-list would leak every new host panel into every
 * preset), but it buys the opposite failure, and this gate exists for it:
 * a panel or tool renamed host-side silently DROPS OUT of the preset.
 * Nothing breaks or throws; the editor boots one panel poorer, and the only
 * way to notice is to have known it was there.
 *
 * The presets are read as data (`apps/canvas/src/profiles/presets.ts`,
 * resolved through their `extends` chain), and every id is checked against
 * the surface inventory of ADR 227 (`scripts/surface/enumerate.mjs`), which
 * reads host surfaces from the code that registers them and plugin
 * surfaces from each bundle's own manifest. A glob must match at least one
 * id. Written after a first draft of the draw profile named a draw
 * "layers" panel that has never existed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// By path: this script is not a workspace package of its own.
import { CORE_MENUS } from "../packages/shell/src/chrome/MenuBar.tsx";
import {
  BUNDLES_ENTRY,
  globMatches,
  resolveProfile,
} from "../packages/shell/src/profile/index.ts";

import { PRESETS } from "../apps/canvas/src/profiles/presets.ts";
import { BUILT_IN_TOOLS } from "../packages/tools/src/built-in-tools.ts";
import { enumerateSurface } from "./surface/enumerate.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const surface = enumerateSurface(REPO);
const idsOf = (kind) =>
  surface.items.filter((i) => i.kind === kind).map((i) => i.id);
const known = {
  panel: idsOf("panel"),
  // Every host tool, planned ones included: a planned tool is registered
  // and drawn as an honest stub, so a preset may name it.
  tool: [...new Set([...idsOf("tool"), ...BUILT_IN_TOOLS.map((t) => t.id)])],
  command: idsOf("command"),
  menu: [
    ...new Set([
      ...CORE_MENUS,
      ...idsOf("menu").map((path) => path.split("/")[0]),
    ]),
  ],
  bundle: surface.bundles.map((b) => b.id),
};

const failures = [];
const check = (preset, where, kind, id) => {
  if (id === BUNDLES_ENTRY) return;
  if (!known[kind].some((k) => globMatches(id, k))) {
    failures.push(
      `${preset}: ${where} names ${kind} "${id}", which nothing registers`,
    );
  }
};
const named = (region) =>
  region && region.kind === "list"
    ? region.items.flatMap(function flat(item) {
        if (typeof item === "string") return [item];
        if (item.kind === "group") return item.items.flatMap(flat);
        return [];
      })
    : [];

let presets = 0;
for (const name of Object.keys(PRESETS)) {
  presets++;
  const { profile, problems } = resolveProfile({ extends: name }, PRESETS);
  for (const p of problems) failures.push(`${name}: ${p.path}: ${p.message}`);

  if (profile.bundles !== "all") {
    for (const id of profile.bundles) check(name, "bundles", "bundle", id);
  }
  if (profile.panels !== "all") {
    for (const id of profile.panels) check(name, "panels", "panel", id);
  }
  if (profile.modes !== "all") {
    profile.modes.forEach((mode, i) => {
      const at = `modes[${i}]`;
      const slots = mode.slots;
      if (slots?.left) check(name, `${at}.slots.left`, "panel", slots.left);
      for (const id of slots?.tabs ?? [])
        check(name, `${at}.slots.tabs`, "panel", id);
      if (slots?.inspector)
        check(name, `${at}.slots.inspector`, "panel", slots.inspector);
      for (const id of mode.paletteSuggestions ?? [])
        check(name, `${at}.paletteSuggestions`, "command", id);
    });
  }
  const r = profile.regions;
  for (const id of named(r["tool-rail"]))
    check(name, "regions.tool-rail", "tool", id);
  for (const id of named(r["panel-rail"]))
    check(name, "regions.panel-rail", "panel", id);
  for (const id of named(r.menubar)) check(name, "regions.menubar", "menu", id);
  for (const region of ["header", "actions-bar"]) {
    for (const id of named(r[region]))
      check(name, `regions.${region}`, "command", id);
  }
  console.log(
    `  ✓ ${name.padEnd(12)} ${profile.chain.join(" → ") || "(base)"}`,
  );
}

if (failures.length > 0) {
  console.error(`\nprofile-presets-guard: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(
  `\nprofile presets OK — ${presets} preset(s), every id resolves against the code that registers it.`,
);
