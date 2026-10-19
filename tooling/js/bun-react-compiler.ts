// A bun test preload that runs the code under test COMPILED by the React
// Compiler, with the build's own options (tooling/js/react-compiler.mjs,
// apps/editor ADR 229):
//
//   bun test --preload <…the lane's own preloads…> \
//            --preload <repo>/tooling/js/bun-react-compiler.ts …
//
// `bun test` runs the sources as written; the builds ship them compiled.
// This preload is the other half of "test both ways": a DOM lane run with
// it renders exactly what the editor ships (the render-count harness and
// the compiled lane runs in docs/migration/react-compiler.md use it). It
// goes LAST: Bun gives a file to the first plugin whose onLoad filter
// matches it, so a lane's own source plugin (the canvas lane's vite-shim)
// keeps the file and hands its result to `__pagedCompileReact`.
//
// `PAGED_REACT_COMPILER=0` turns it into a no-op, for an A/B run with the
// same command.

import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  compileSource,
  compilerEnabled,
  createCollector,
  isReactSource,
} from "./react-compiler.mjs";

const require = createRequire(import.meta.url);
const babel = require("@babel/core") as typeof import("@babel/core");
const PLUGIN = require.resolve("babel-plugin-react-compiler");

const collector = createCollector();

// A test that calls a component as a plain function, outside React (the
// hook-store harnesses in data and image), would reach the compiled
// `useMemoCache` with no dispatcher. Inside a render the cache is React's
// own, as in the build; outside one, each call gets a fresh cache, which is
// what the uncompiled function does: compute everything.
const RUNTIME_IMPORT =
  /import\s*\{\s*c\s+as\s+([\w$]+)\s*\}\s*from\s*["']react\/compiler-runtime["'];?/;
const SENTINEL = 'Symbol.for("react.memo_cache_sentinel")';

function outsideRenderFallback(code: string): string {
  // One line in place of the import line, so the inline source map's lines
  // still match.
  return code.replace(
    RUNTIME_IMPORT,
    (_m, name: string) =>
      `import * as __pagedReact from "react"; const ${name} = (size) => { const H = __pagedReact.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.H; return H ? H.useMemoCache(size) : new Array(size).fill(${SENTINEL}); };`,
  );
}

/** Compile one source file; anything that is not a first-party React
 *  source comes back unchanged. */
export function compileReact(path: string, source: string): string {
  if (!isReactSource(path)) return source;
  const code = compileSource({
    babel,
    pluginPath: PLUGIN,
    file: path,
    code: source,
    logger: collector.logger,
    sourceMaps: "inline",
  });
  return code === source ? source : outsideRenderFallback(code);
}

/** What the compiler did in this process, per file. */
export const compiledFiles = collector.files;

if (compilerEnabled()) {
  (
    globalThis as { __pagedCompileReact?: typeof compileReact }
  ).__pagedCompileReact = compileReact;

  plugin({
    name: "paged-react-compiler",
    setup(build) {
      build.onLoad({ filter: /\/src\/.+\.[cm]?tsx?$/ }, ({ path }) => {
        const source = readFileSync(path, "utf8");
        return {
          contents: compileReact(path, source),
          loader: /x$/.test(path) ? "tsx" : "ts",
        };
      });
    },
  });
}
