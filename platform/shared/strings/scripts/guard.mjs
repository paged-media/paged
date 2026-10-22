#!/usr/bin/env node
/**
 * The strings guard (apps/editor docs/composable-editor-plan.md, E10).
 *
 * Reads every `defineMessages("<namespace>", { … })` in the repository's
 * TypeScript sources and every German catalogue (this package's
 * `locales/de.json` and each package's own `locales/de.json`), and fails
 * when a message has no German text, when a German key names no message,
 * or when the two disagree on their {parameters}. Static: no bundle needs
 * to load for the check.
 *
 *   bun platform/shared/strings/scripts/guard.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SKIP =
  /(^|\/)(node_modules|dist|target|\.git|\.moon|tooling\/import|test-results|playwright-report)(\/|$)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(ROOT, path);
    if (SKIP.test(rel)) continue;
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(join(ROOT, "apps")).concat(
  walk(join(ROOT, "modules")),
  walk(join(ROOT, "platform")),
);
const english = new Map();
const call = /defineMessages\(\s*"([\w.-]+)"\s*,\s*\{([\s\S]*?)\n?\s*\}\s*\)/g;
const entry =
  /(?:^|[\s,{])(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+|`[^`]*`)/g;
for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file) || /\.d\.ts$/.test(file)) continue;
  if (/\/test\/|\.test\.|\.spec\./.test(file)) continue;
  const source = readFileSync(file, "utf8");
  if (!source.includes("defineMessages(")) continue;
  // Comments may show the call as an example.
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const m of text.matchAll(call)) {
    const ns = m[1];
    for (const e of m[2].matchAll(entry)) {
      const name = e[1] ?? e[2];
      const raw = e[3].trim();
      const value = raw.startsWith("`")
        ? raw.slice(1, -1)
        : raw
            .split(/"\s*\+\s*"/)
            .join("")
            .replace(/^"|"$/g, "")
            .replace(/\\"/g, '"');
      english.set(`${ns}.${name}`, { value, file: relative(ROOT, file) });
    }
  }
}

const german = new Map();
for (const file of files) {
  if (!/\/locales\/de\.json$/.test(file)) continue;
  for (const [key, value] of Object.entries(
    JSON.parse(readFileSync(file, "utf8")),
  ))
    german.set(key, { value, file: relative(ROOT, file) });
}

const params = (s) =>
  [...s.matchAll(/\{(\w+)[},]/g)]
    .map((m) => m[1])
    .sort()
    .join(",");
const problems = [];
for (const [key, { value, file }] of english) {
  const de = german.get(key);
  if (!de) problems.push(`${key} (${file}) has no German text`);
  else if (params(de.value) !== params(value))
    problems.push(
      `${key}: German {${params(de.value)}} but English {${params(value)}} (${de.file})`,
    );
}
for (const [key, { file }] of german)
  if (!english.has(key)) problems.push(`${key} in ${file} names no message`);

if (problems.length) {
  console.error(
    `strings guard: ${problems.length} problem(s)\n${problems.join("\n")}`,
  );
  process.exit(1);
}
console.log(`strings guard OK — ${english.size} messages, all in German`);
