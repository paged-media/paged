/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// The editor's catalogue for a language is every package's translations
// together (`defineTranslations`), and a key translated twice differently
// refuses the second package at load time. In the browser that refusal makes
// a whole bundle fail to load, which no unit test of that bundle sees. This
// reads every shipped catalogue in the repository and holds them to one
// translation per key.

const ROOT = resolve(import.meta.dir, "../../../..");

/** Every tracked `locales/<lang>.json`, from the index (fast, and it skips
 *  build output and vendored trees by construction). */
function catalogues(): string[] {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--", ":(glob)**/locales/*.json"],
    { cwd: ROOT },
  );
  return new TextDecoder()
    .decode(listed.stdout)
    .split("\n")
    .filter((f) => /\/locales\/[a-z]{2}(-[A-Z]{2})?\.json$/.test(f))
    .map((f) => join(ROOT, f));
}

describe("the shipped catalogues", () => {
  test("translate every key one way per language", () => {
    const files = catalogues();
    expect(files.length).toBeGreaterThan(1);
    const seen = new Map<string, { text: string; file: string }>();
    const clashes: string[] = [];
    for (const file of files) {
      const locale = file.slice(file.lastIndexOf("/") + 1, -".json".length);
      const catalogue = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        string
      >;
      for (const [key, text] of Object.entries(catalogue)) {
        const id = `${locale} ${key}`;
        const known = seen.get(id);
        if (known && known.text !== text)
          clashes.push(
            `${id}: "${known.text}" (${relative(ROOT, known.file)}) vs "${text}" (${relative(ROOT, file)})`,
          );
        else if (!known) seen.set(id, { text, file });
      }
    }
    expect(clashes).toEqual([]);
  });
});
