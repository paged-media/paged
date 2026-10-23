#!/usr/bin/env node
/**
 * The theme-token contract (docs/composable-editor-plan.md, E4).
 *
 * An embedding host restyles the editor through `handle.setTheme({ tokens })`
 * with the editor's own custom properties. Once hosts set them, their names
 * are a contract, so they are published as one generated file,
 * `docs/theme-tokens.json`: every token `packages/shell/src/styles/theme.css`
 * defines, its group (the section comment above it) and its light and dark
 * values. `--check` regenerates and fails when the committed file differs.
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

const css = readFileSync(CSS, "utf8");
const light = tokens(block(css, ":root"));
const dark = tokens(block(css, ".dark"));
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
