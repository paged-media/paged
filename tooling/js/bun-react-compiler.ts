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
//
// The output is cached by content in node_modules/.cache: `bun test
// --parallel` gives every test file a fresh module registry, so without the
// cache each file compiled the whole graph it imports again (the canvas DOM
// lane: 79 files, each compiling the shell's ~300 sources, inside the tests
// that import lazily).

import { plugin } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  compileSource,
  compilerEnabled,
  compilerOptions,
  isReactSource,
} from "./react-compiler.mjs";

const require = createRequire(import.meta.url);
const babel = require("@babel/core") as typeof import("@babel/core");
const PLUGIN = require.resolve("babel-plugin-react-compiler");

const CACHE = join(REPO_ROOT, "node_modules", ".cache", "paged-react-compiler");
// What else decides the output: the compiler's version and options, and
// the code of this preload and of the configuration it reads.
const SALT = createHash("sha256")
  .update(require("babel-plugin-react-compiler/package.json").version)
  .update(JSON.stringify(compilerOptions()))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(join(REPO_ROOT, "tooling", "js", "react-compiler.mjs")))
  .digest("hex");

function cached(path: string, source: string, compile: () => string): string {
  const key = createHash("sha256")
    .update(SALT)
    .update(path)
    .update("\0")
    .update(source)
    .digest("hex");
  const file = join(CACHE, `${key}.js`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    // not cached yet
  }
  const code = compile();
  try {
    mkdirSync(CACHE, { recursive: true });
    // Parallel workers compile the same file: each writes its own copy and
    // renames it into place, so a reader never sees half a file.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, code);
    renameSync(tmp, file);
  } catch {
    // a cache that cannot be written only costs time
  }
  return code;
}

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
  return cached(path, source, () => {
    const code = compileSource({
      babel,
      pluginPath: PLUGIN,
      file: path,
      code: source,
      sourceMaps: "inline",
    });
    return code === source ? source : outsideRenderFallback(code);
  });
}

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
