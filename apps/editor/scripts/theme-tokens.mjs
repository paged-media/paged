#!/usr/bin/env node
/**
 * The theme-token contract (docs/composable-editor-plan.md, E4).
 *
 * An embedding host restyles the editor through `handle.setTheme({ tokens })`
 * with the editor's own custom properties. Once hosts set them, their names
 * are a contract, so they are published as one generated file,
 * `docs/theme-tokens.json`: every token `packages/shell/src/styles/theme.css`
 * defines, its group (the section comment above it), its light and dark
 * values and, for a density token, its value in each density preset other
 * than the default (`[data-density]`, editor ADR "Density presets"), and
 * its high-contrast values (`[data-contrast="more"]`, editor ADR "High
 * contrast and AA").
 * `--check` regenerates and fails when the committed file differs.
 *
 *   bun scripts/theme-tokens.mjs           # write
 *   bun scripts/theme-tokens.mjs --check   # gate
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, "../packages/shell/src/styles/theme.css");
const OUT = join(HERE, "../docs/theme-tokens.json");

/** The declarations of the first top-level block opened by `selector`
 *  (alone, or first in a selector list: `:root, [data-paged-editor]`). */
function block(css, selector) {
  const start = css.search(
    new RegExp(`^${selector.replace(".", "\\.")}(\\s*,[^{]*)?\\s*\\{`, "m"),
  );
  if (start < 0)
    throw new Error(`theme-tokens: no ${selector} block in theme.css`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0)
      return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`theme-tokens: ${selector} is not closed`);
}

/** `--name: value;` declarations with the section comment above each. */
function tokens(body) {
  const out = new Map();
  let group = "";
  for (const line of body.split("\n")) {
    const heading = /\/\*\s*[─-]*\s*(.+?)\s*[─-]*\s*\*\//.exec(line);
    if (heading && !line.includes(":"))
      group = heading[1].replace(/\s*\(.*\)$/, "");
    const decl = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*;/.exec(line);
    if (decl) out.set(decl[1], { group, value: decl[2] });
  }
  return out;
}

/** The density presets' blocks: `[data-paged-editor][data-density="x"]`. */
function densities(css) {
  const out = new Map();
  const head = /^\[data-paged-editor\]\[data-density="([\w-]+)"\]\s*\{/gm;
  for (const m of css.matchAll(head)) {
    const open = m.index + m[0].length - 1;
    const close = css.indexOf("}", open);
    if (close < 0)
      throw new Error(`theme-tokens: density ${m[1]} is not closed`);
    out.set(m[1], tokens(css.slice(open + 1, close)));
  }
  return out;
}

/** A high-contrast block's declarations (editor ADR "High contrast and
 *  AA"): `[data-paged-editor][data-contrast="more"]…`, light or dark. */
function contrastBlock(css, head) {
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`theme-tokens: no ${head} block in theme.css`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return tokens(css.slice(open + 1, close));
}

const css = readFileSync(CSS, "utf8");
const light = tokens(block(css, ":root"));
const dark = tokens(block(css, ".dark"));
const presets = densities(css);
const highContrast = {
  light: contrastBlock(
    css,
    '[data-paged-editor][data-contrast="more"]:not(.dark) {',
  ),
  dark: contrastBlock(css, '[data-paged-editor].dark[data-contrast="more"] {'),
};
if (presets.size === 0)
  throw new Error("theme-tokens: no [data-density] preset in theme.css");
const names = [...new Set([...light.keys(), ...dark.keys()])].sort();
const contract = {};
for (const name of names) {
  const l = light.get(name);
  const d = dark.get(name);
  contract[name] = {
    group: (l ?? d).group,
    light: l?.value ?? null,
    dark: d?.value ?? l?.value ?? null,
  };
  const byDensity = {};
  for (const [density, values] of presets) {
    const v = values.get(name);
    if (v) byDensity[density] = v.value;
  }
  if (Object.keys(byDensity).length > 0) contract[name].densities = byDensity;
  const hcLight = highContrast.light.get(name)?.value;
  const hcDark = highContrast.dark.get(name)?.value;
  if (hcLight || hcDark) {
    contract[name].highContrast = {
      light: hcLight ?? contract[name].light,
      dark: hcDark ?? contract[name].dark,
    };
  }
}
for (const [theme, values] of Object.entries(highContrast)) {
  for (const name of values.keys()) {
    if (!light.has(name))
      throw new Error(
        `theme-tokens: high contrast (${theme}) sets ${name}, which the default does not define`,
      );
  }
}
for (const [density, values] of presets) {
  for (const name of values.keys()) {
    if (!light.has(name))
      throw new Error(
        `theme-tokens: density ${density} sets ${name}, which the default does not define`,
      );
  }
}
const text = `${JSON.stringify(
  {
    $comment:
      "The editor's theme tokens: what handle.setTheme({ tokens }) may set. Generated from packages/shell/src/styles/theme.css by scripts/theme-tokens.mjs; do not edit.",
    tokens: contract,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    /* missing */
  }
  if (committed !== text) {
    console.error(
      "theme-tokens: docs/theme-tokens.json is stale — run `bun scripts/theme-tokens.mjs`",
    );
    process.exit(1);
  }
  console.log(`theme tokens OK — ${names.length} tokens`);
} else {
  writeFileSync(OUT, text);
  console.log(`theme-tokens: wrote ${names.length} tokens`);
}
