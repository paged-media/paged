#!/usr/bin/env bun
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

// The CLI as ONE file for npm: the `paged` bin of @paged-media/paged
// (PM-0008, amendment 3; packages/paged/scripts/assemble.mjs calls this).
//
//   bun scripts/bundle.mjs <out dir> [--bin <name>]
//
// writes <out dir>/<name>.js (default name `paged`) and
// <out dir>/THIRD-PARTY-NOTICES.md.
//
// - Every module the CLI imports is inlined: the workspace's private
//   packages (plugin-sdk's runtime, @paged-media/ai, …) and the third-party
//   ones (the Anthropic SDK and its dependencies), so the package that ships
//   the file has no dependencies at all. React stays OUTSIDE: plugin-sdk
//   loads it only if a bundle brings it (src/react-optional.ts there), and
//   one copy of React is the bundle's host's to provide.
// - `__PAGED_CLI_BIN__` is defined as <name>: the help, usage and error
//   lines then name the command the way npm installs it (src/errors.ts).
// - The engine is not bundled: plugin-sdk's headless loader finds it at run
//   time, in the package the file ships in (`@paged-media/paged`), or the
//   workspace's `@paged-media/canvas-wasm`.
// - The check: the file imports nothing but `node:` builtins (React by a
//   dynamic import only), and THIRD-PARTY-NOTICES.md carries the licence of
//   every third-party package inlined.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const args = process.argv.slice(2);
const binAt = args.indexOf("--bin");
const bin = binAt >= 0 ? args[binAt + 1] : "paged";
const outArg = args.find(
  (a, i) => !a.startsWith("--") && (binAt < 0 || i !== binAt + 1),
);
if (!outArg || !bin) {
  console.error("usage: bun scripts/bundle.mjs <out dir> [--bin <name>]");
  process.exit(2);
}
const outdir = resolve(outArg);
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(pkg, "src/bin.ts")],
  outdir,
  naming: `${bin}.js`,
  target: "node",
  format: "esm",
  external: ["react", "react-dom", "react/*", "react-dom/*"],
  define: { __PAGED_CLI_BIN__: JSON.stringify(bin) },
  metafile: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const file = join(outdir, `${bin}.js`);
const code = readFileSync(file, "utf8");

// Nothing but node: builtins, statically or dynamically; React dynamically.
const specs = [
  ...code.matchAll(
    /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']/gm,
  ),
  ...code.matchAll(/(?:^|[\s;])import\s*["']([^"']+)["']/gm),
].map((m) => m[1]);
const dynamic = [...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(
  (m) => m[1],
);
const bad = [
  ...specs.filter((s) => !s.startsWith("node:")),
  ...dynamic.filter(
    (s) => !s.startsWith("node:") && !/^react(-dom)?(\/|$)/.test(s),
  ),
];
if (bad.length) {
  console.error(
    `bundle: ${file} still imports ${[...new Set(bad)].join(", ")}`,
  );
  process.exit(1);
}

// The third-party packages inlined, from the inputs under node_modules.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = input.split("\\").join("/");
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) continue;
  const rest = path.slice(at + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = resolve(pkg, path.slice(0, at), "node_modules", name);
  if (packages.has(dir)) continue;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenceFile = existsSync(dir)
    ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f))
    : undefined;
  packages.set(dir, {
    name: manifest.name,
    version: manifest.version,
    license:
      typeof manifest.license === "string"
        ? manifest.license
        : JSON.stringify(manifest.license ?? null),
    text: licenceFile
      ? readFileSync(join(dir, licenceFile), "utf8").trim()
      : null,
  });
}
const sorted = [...packages.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);
const missing = sorted.filter((p) => !p.text && !p.license);
if (missing.length) {
  console.error(
    `bundle: no licence found for ${missing.map((p) => p.name).join(", ")}`,
  );
  process.exit(1);
}
writeFileSync(
  join(outdir, "THIRD-PARTY-NOTICES.md"),
  [
    `# Third-party notices`,
    "",
    `\`${bin}.js\` (the \`${bin}\` command) includes the following packages, each under its own licence.`,
    "",
    ...sorted.flatMap((p) => [
      `## ${p.name} ${p.version}`,
      "",
      `Licence: ${p.license}`,
      "",
      ...(p.text ? ["```text", p.text, "```", ""] : []),
    ]),
  ].join("\n"),
);

const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
console.log(
  `bundle: ${file} (${kib(code.length)}), ${Object.keys(result.metafile.inputs).length} modules, third-party: ${sorted.map((p) => `${p.name}@${p.version}`).join(", ") || "none"}`,
);
