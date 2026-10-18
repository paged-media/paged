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

// Keeps api-catalog.json honest: every public export of src/index.ts must appear
// in the catalog (as a member name, or as the object prefix of a member — e.g.
// the `Viewer` interface is documented via `Viewer.load`, `Viewer.zoom`, …). The
// docs site renders the SDK reference from this catalog, so a new export that
// isn't documented here fails the build instead of silently shipping undocumented.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function exportedNames(indexTs: string): string[] {
  const names = new Set<string>();
  // Match each `export { ... }` / `export type { ... }` block and pull identifiers.
  for (const [, list = ""] of indexTs.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of list.split(",")) {
      const [id = ""] = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (id.trim()) names.add(id.trim());
    }
  }
  return [...names];
}

describe("api-catalog.json", () => {
  const indexTs = readFileSync(join(root, "src", "index.ts"), "utf8");
  const catalog = JSON.parse(readFileSync(join(root, "api-catalog.json"), "utf8")) as {
    groups: { members: { name: string }[] }[];
  };
  const memberNames = catalog.groups.flatMap((g) => g.members.map((m) => m.name));
  const exports = exportedNames(indexTs);

  it("documents every export of src/index.ts", () => {
    const covered = (id: string) => memberNames.some((n) => n === id || n.startsWith(`${id}.`));
    const missing = exports.filter((id) => !covered(id));
    expect(missing, `undocumented exports — add them to api-catalog.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("has well-formed members (name + signature + summary)", () => {
    for (const g of catalog.groups) {
      for (const m of g.members as { name: string; signature?: string; summary?: string }[]) {
        expect(m.name, "member missing name").toBeTruthy();
        expect(m.signature, `member ${m.name} missing signature`).toBeTruthy();
        expect(m.summary, `member ${m.name} missing summary`).toBeTruthy();
      }
    }
  });
});
