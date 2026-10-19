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

// The panel kit's tokens (platform/shared/panel-kit) fall back to the
// light theme's values, so a panel that runs where the editor's theme is
// not loaded still reads as the editor does. This holds every fallback
// equal to theme.css's `:root` value, and every token the kit names
// defined there: a design refresh that moves a token moves its fallback.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  chrome,
  color,
  font,
  radius,
  space,
  status,
} from "@paged-media/panel-kit";

const css = readFileSync(
  join(import.meta.dir, "..", "..", "src", "styles", "theme.css"),
  "utf8",
);

/** The `:root` block's custom properties, value by name. */
function rootTokens(): Map<string, string> {
  const start = css.indexOf(":root {");
  const end = css.indexOf("\n}", start);
  const block = css
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out.set(m[1]!, m[2]!.trim());
  return out;
}

const KIT = {
  ...color,
  ...chrome,
  ...status,
  sans: font.sans,
  mono: font.mono,
  trackingWide: font.trackingWide,
  ...Object.fromEntries(Object.entries(space).map(([k, v]) => [`s${k}`, v])),
  ...radius,
};

describe("the panel kit's tokens", () => {
  const root = rootTokens();
  for (const [key, value] of Object.entries(KIT)) {
    const m = /^var\((--[a-z0-9-]+), (.+)\)$/.exec(value)!;
    const [, name, fallback] = m;
    test(`${key}: ${name} is a theme token`, () => {
      expect(root.has(name!)).toBe(true);
    });
    // The font stacks fall back to the generic family, not the stack.
    if (key === "sans" || key === "mono") continue;
    test(`${key}: the fallback is the light theme's value`, () => {
      expect(fallback).toBe(root.get(name!)!);
    });
  }
});
