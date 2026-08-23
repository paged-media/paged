/**
 * paged.draw — the menu entries name real commands.
 *
 * WHY THIS TEST EXISTS. `contribute.menu()` REFUSES an entry whose
 * command the bundle has not registered — deliberately, on the principle
 * that a menu item which accepts a click and does nothing is worse than
 * an absent one. That refusal happens at activate time in the browser,
 * so a single mistyped suffix here would surface as one quietly missing
 * menu item in the running app and nowhere else. Comparing the table
 * against the manifest catches it in CI instead, in milliseconds.
 *
 * It also catches the reverse drift: a command RENAMED in the manifest
 * while the menu table keeps pointing at the old id.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { MENU_COMMAND_PREFIX, MENU_ENTRIES } from "../src/menu";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "..", "manifest.json");

const declared: string[] = JSON.parse(readFileSync(MANIFEST, "utf8"))
  .contributes.commands;

describe("draw menu entries", () => {
  it("every entry points at a command the manifest declares", () => {
    const declaredSet = new Set(declared);
    const missing = MENU_ENTRIES.map(
      ([, suffix]) => `${MENU_COMMAND_PREFIX}.${suffix}`,
    ).filter((id) => !declaredSet.has(id));
    expect(missing, `menu entries naming unknown commands: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("no command appears in two menu places", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [path, suffix] of MENU_ENTRIES) {
      const prior = seen.get(suffix);
      if (prior) dupes.push(`${suffix}: "${prior}" and "${path}"`);
      else seen.set(suffix, path);
    }
    expect(dupes).toEqual([]);
  });

  it("no two entries share a path", () => {
    const paths = MENU_ENTRIES.map(([p]) => p);
    expect(paths.length).toBe(new Set(paths).size);
  });

  it("entries merging into a HOST menu use a host top-level segment", () => {
    // `Object/…` and `Edit/…` merge into menus the host already owns.
    // Anything else must be under `Draw/`, or it silently mints a new
    // top-level menu nobody designed.
    const HOST_MENUS = ["Object", "Edit"];
    const stray = MENU_ENTRIES.map(([p]) => p).filter((p) => {
      const top = p.split("/")[0];
      return top !== "Draw" && !HOST_MENUS.includes(top);
    });
    expect(stray, `unexpected top-level menus: ${stray.join(", ")}`).toEqual([]);
  });

  it("covers a real share of the bundle's commands", () => {
    // A floor, not a target. If someone deletes the table the earlier
    // assertions all pass vacuously — an empty list names no unknown
    // command and has no duplicates.
    expect(MENU_ENTRIES.length).toBeGreaterThan(50);
    expect(MENU_ENTRIES.length).toBeLessThanOrEqual(declared.length);
  });
});
