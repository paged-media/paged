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

// The theme's contrast (editor ADR "High contrast and AA"; UXI-A11Y-012):
// every text token on every surface token it is drawn on meets WCAG 2.2 AA
// (4.5:1) in the dark and light themes, and 7:1 in their high-contrast
// variants, where field and panel boundaries and the focus ring meet 4.5:1
// too. Computed from theme.css itself (WCAG's relative luminance), so a
// token change that breaks a pair fails here before any page renders.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "..", "..", "src", "styles", "theme.css"),
  "utf8",
);

/** A block's custom properties, by the exact text that opens it. */
function block(head: string): Map<string, string> {
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`no ${head} block in theme.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  return out;
}

const light = block(":root,");
const dark = new Map([...light, ...block(".dark {")]);
const THEMES = {
  light,
  dark,
  "high-contrast light": new Map([
    ...light,
    ...block('[data-paged-editor][data-contrast="more"]:not(.dark) {'),
  ]),
  "high-contrast dark": new Map([
    ...dark,
    ...block('[data-paged-editor].dark[data-contrast="more"] {'),
  ]),
};

type Rgb = [number, number, number];

function hsl(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A token's colour: hex, `hsl(h s% l%)`, the shadcn channels `h s% l%`,
 *  or `var(--other)`. */
function colour(tokens: Map<string, string>, name: string, depth = 0): Rgb {
  const v = tokens.get(name);
  if (v === undefined || depth > 8) throw new Error(`${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return colour(tokens, ref[1]!, depth + 1);
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m)
    return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as Rgb;
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]!].map((c) => parseInt(c + c, 16)) as Rgb;
  m =
    /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(v) ??
    /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(v);
  if (m) return hsl(Number(m[1]), Number(m[2]), Number(m[3]));
  throw new Error(`${name}: cannot read "${v}"`);
}

const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text tokens on the surfaces they are drawn on. */
const TEXT: Array<[string, string]> = [
  ["--foreground", "--background"],
  ["--foreground", "--popover"],
  ["--foreground", "--muted"],
  ["--muted-foreground", "--background"],
  ["--muted-foreground", "--popover"],
  ["--muted-foreground", "--muted"],
  ["--muted-foreground", "--accent"],
  ["--pg-fg", "--pg-bg"],
  ["--pg-fg", "--elevated"],
  ["--pg-muted-fg", "--pg-bg"],
  ["--pg-muted-fg", "--pg-muted"],
  ["--pg-muted-fg", "--elevated"],
  ["--pg-muted-fg", "--chrome-panel-bg"],
  ["--pg-muted-fg", "--chrome-rail-bg"],
  ["--chrome-label", "--chrome-panel-bg"],
  ["--chrome-label", "--chrome-rail-bg"],
  ["--chrome-label", "--elevated"],
  ["--chrome-menu-text", "--chrome-panel-bg"],
  ["--primary-foreground", "--primary"],
  ["--pg-primary-fg", "--pg-primary"],
  ["--pg-primary", "--pg-bg"],
  ["--destructive", "--background"],
  ["--destructive-foreground", "--destructive"],
  ["--status-error", "--pg-bg"],
  ["--status-error", "--elevated"],
  ["--status-review", "--pg-bg"],
  ["--status-approved", "--pg-bg"],
  ["--status-info", "--pg-bg"],
  ["--status-draft", "--pg-bg"],
  ["--status-progress", "--pg-bg"],
];

/** Non-text: glyphs and the focus ring (3:1, AA's 1.4.11); in high
 *  contrast also the boundaries of fields and panels (4.5:1). */
const GLYPHS: Array<[string, string]> = [
  ["--ring", "--background"],
  ["--ring", "--popover"],
  ["--chrome-icon", "--chrome-rail-bg"],
  ["--chrome-icon", "--chrome-panel-bg"],
  ["--chrome-icon-active", "--chrome-slot-active"],
];
const BOUNDARIES: Array<[string, string]> = [
  ["--input", "--background"],
  ["--border", "--background"],
  ["--chrome-divider", "--chrome-panel-bg"],
  ["--chrome-border", "--chrome-panel-bg"],
];

describe("the theme's contrast", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const high = theme.startsWith("high");
    test(`${theme}: text ${high ? "7" : "4.5"}:1 on its surfaces`, () => {
      const min = high ? 7 : 4.5;
      const below = TEXT.map(([fg, bg]) => ({
        pair: `${fg} on ${bg}`,
        ratio: Number(
          contrast(colour(tokens, fg), colour(tokens, bg)).toFixed(2),
        ),
      })).filter((r) => r.ratio < min);
      expect(below).toEqual([]);
    });
    test(`${theme}: glyphs and the focus ring ${high ? "4.5" : "3"}:1${high ? ", boundaries 4.5:1" : ""}`, () => {
      const min = high ? 4.5 : 3;
      const pairs = high ? [...GLYPHS, ...BOUNDARIES] : GLYPHS;
      const below = pairs
        .map(([fg, bg]) => ({
          pair: `${fg} on ${bg}`,
          ratio: Number(
            contrast(colour(tokens, fg), colour(tokens, bg)).toFixed(2),
          ),
        }))
        .filter((r) => r.ratio < min);
      expect(below).toEqual([]);
    });
  }

  test("the high-contrast variants set only tokens the default defines", () => {
    for (const head of [
      '[data-paged-editor][data-contrast="more"]:not(.dark) {',
      '[data-paged-editor].dark[data-contrast="more"] {',
    ]) {
      for (const name of block(head).keys()) expect(light.has(name)).toBe(true);
    }
  });
});
