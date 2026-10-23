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

/**
 * The `defineMessages("ns", { key: "text", … })` calls of a source, read by
 * a small scanner that knows comments and the three kinds of quotes, so a
 * message may hold `})`, quotes of either kind, and `+`-joined pieces.
 */
function messagesOf(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const skipSpace = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith("//", i))
        i = src.indexOf("\n", i) < 0 ? n : src.indexOf("\n", i);
      else if (src.startsWith("/*", i))
        i = src.indexOf("*/", i + 2) < 0 ? n : src.indexOf("*/", i + 2) + 2;
      else return;
    }
  };
  /** A string literal at `i` (a template literal only without `${`), or null. */
  const literal = () => {
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== "`") return null;
    let j = i + 1;
    let text = "";
    while (j < n && src[j] !== q) {
      if (src[j] === "\\") {
        const c = src[j + 1];
        text +=
          c === "n"
            ? "\n"
            : c === "t"
              ? "\t"
              : c === "u"
                ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16))
                : c;
        j += c === "u" ? 6 : 2;
        continue;
      }
      if (q === "`" && src.startsWith("${", j)) return null;
      text += src[j++];
    }
    i = j + 1;
    return text;
  };
  /** Skips a string, comment or template at `i` as code would. */
  const skipToken = () => {
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      let j = i + 1;
      while (j < n && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
      i = j + 1;
      return true;
    }
    if (src.startsWith("//", i) || src.startsWith("/*", i)) {
      skipSpace();
      return true;
    }
    return false;
  };
  while (i < n) {
    if (skipToken()) continue;
    if (
      src.startsWith("defineMessages(", i) &&
      !/[\w$.]/.test(src[i - 1] ?? "")
    ) {
      i += "defineMessages(".length;
      skipSpace();
      const ns = literal();
      skipSpace();
      if (ns === null || src[i] !== ",") continue;
      i++;
      skipSpace();
      if (src[i] !== "{") continue;
      i++;
      for (;;) {
        skipSpace();
        if (src[i] === "}") break;
        let key = literal();
        if (key === null) {
          const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
          if (!m) break;
          key = m[0];
          i += key.length;
        }
        skipSpace();
        if (src[i] !== ":") break;
        i++;
        skipSpace();
        let value = literal();
        if (value === null) break;
        for (;;) {
          skipSpace();
          if (src[i] !== "+") break;
          i++;
          skipSpace();
          const more = literal();
          if (more === null) break;
          value += more;
        }
        out.push([`${ns}.${key}`, value]);
        skipSpace();
        if (src[i] === ",") i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

const english = new Map();
const problems = [];
for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file) || /\.d\.ts$/.test(file)) continue;
  if (/\/test\/|\.test\.|\.spec\./.test(file)) continue;
  const source = readFileSync(file, "utf8");
  if (!source.includes("defineMessages(")) continue;
  for (const [key, value] of messagesOf(source)) {
    const known = english.get(key);
    if (known && known.value !== value)
      problems.push(
        `${key} is defined twice with different English (${known.file}, ${relative(ROOT, file)}): it would throw when both load`,
      );
    english.set(key, { value, file: relative(ROOT, file) });
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

// A parameter is `{name}` or a plural's `{name, plural, …}`; a plural
// branch (`{Kept, though …}`) is text, not a parameter.
const params = (s) =>
  [...new Set([...s.matchAll(/\{(\w+)(?:\}|,\s*plural\b)/g)].map((m) => m[1]))]
    .sort()
    .join(",");
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
