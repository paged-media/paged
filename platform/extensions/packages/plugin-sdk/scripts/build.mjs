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

// plugin-sdk's library build, its JavaScript half: the two entry points with
// `bun build`, the React Compiler run ahead of time over the sources first
// (the compiler's library guidance: compile before publishing, `target:
// "19"`, the build's one configuration in tooling/js/react-compiler.mjs;
// apps/editor ADR 229). The package's `build` script then runs tsc for the
// declarations.
//
// React is an OPTIONAL peer, and must stay optional at RUNTIME
// (src/react-optional.ts): the loader path imports without React
// installed. A component the compiler memoizes gains a static
// `import { c } from "react/compiler-runtime"`, which would break that.
// Today the compiler compiles nothing here (the two React-touching modules
// build their elements through `createElement` handed over by
// react-optional, with no hooks and no JSX), and this build fails if the
// output ever imports React statically, so the choice is made on purpose.

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compileSource,
  createCollector,
  isReactSource,
} from "../../../../../tooling/js/react-compiler.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

// `--outdir <dir>` builds elsewhere (test/react-free-import.spec.ts builds the
// shipped JavaScript into a temporary directory).
const args = process.argv.slice(2);
const outAt = args.indexOf("--outdir");
const outdir = outAt >= 0 ? args[outAt + 1] : join(pkg, "dist");
const require = createRequire(join(pkg, "package.json"));
const babel = require("@babel/core");
const pluginPath = require.resolve("babel-plugin-react-compiler");
const { logger, files } = createCollector();

rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(pkg, "src/index.ts"), join(pkg, "src/gesture-kit.ts")],
  outdir,
  format: "esm",
  target: "node",
  packages: "external",
  plugins: [
    {
      name: "react-compiler",
      setup(build) {
        build.onLoad({ filter: /\.tsx?$/ }, ({ path }) => {
          const code = readFileSync(path, "utf8");
          return {
            contents: isReactSource(path)
              ? compileSource({ babel, pluginPath, file: path, code, logger })
              : code,
            loader: path.endsWith(".tsx") ? "tsx" : "ts",
          };
        });
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const compiled = [...files.values()].reduce((n, e) => n + e.compiled.length, 0);
const skipped = [...files.values()].reduce((n, e) => n + e.bailouts.size, 0);
console.log(
  `plugin-sdk: React Compiler (target 19): ${compiled} compiled, ${skipped} skipped`,
);

// React stays optional: no static import of react (or its compiler
// runtime) anywhere in the output. The dynamic `import("react")` of
// react-optional is the one way in.
const STATIC_REACT =
  /(?:^|[;\n])\s*import\s*(?:[^'";]*\sfrom\s*)?["']react(?:\/[^"']*)?["']/;
for (const file of readdirSync(outdir)) {
  if (!file.endsWith(".js")) continue;
  const code = readFileSync(join(outdir, file), "utf8");
  if (STATIC_REACT.test(code)) {
    console.error(
      `plugin-sdk: dist/${file} imports React statically, so the package no longer loads without React (src/react-optional.ts). A compiled component is the likely cause: move it behind react-optional, or make React a required peer on purpose.`,
    );
    process.exit(1);
  }
}
