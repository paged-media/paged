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

// The harness mounts panels inside PagedShell's provider stack, copied
// (harness.tsx `ShellProviders`) because PagedShell renders the whole
// chrome around it. This keeps the copy honest: the providers, in order,
// must be PagedShell's, plus the one its chrome adds around every panel
// (CockpitStateProvider). A provider added to the shell fails here until
// the harness has it too.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, p), "utf8");

/** `<FooProvider` openings in source order, between two markers. */
function providers(src: string, from: string, to: string): string[] {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`markers not found: ${from}`);
  return [
    ...src.slice(start, end).matchAll(/<([A-Z][A-Za-z]*Provider)\b/g),
  ].map((m) => m[1]);
}

describe("the panel harness", () => {
  test("mounts panels inside PagedShell's providers, in PagedShell's order", () => {
    const shell = providers(
      read("../../../../packages/shell/src/PagedShell.tsx"),
      "export function PagedShell(",
      "<ShellChrome",
    );
    const chrome = providers(
      read("../../../../packages/shell/src/PagedShell.tsx"),
      "function ShellChrome(",
      "\n}\n",
    );
    const harness = providers(
      read("./harness.tsx"),
      "export function ShellProviders(",
      "{children}",
    );
    expect(shell.length).toBeGreaterThan(15);
    expect(harness).toEqual([...shell, "CockpitStateProvider"]);
    expect(chrome.length === 0 || chrome.includes("CockpitStateProvider")).toBe(
      true,
    );
  });
});
