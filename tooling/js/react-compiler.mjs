// The React Compiler's one configuration (apps/editor/docs/adr/229-react-compiler.md).
//
// Everything that runs the compiler reads it, so the build and the ratchet
// cannot disagree about what is compiled or how:
//
//   - the editor's and the devtools' Vite builds (vite.config.ts:
//     `@vitejs/plugin-react`'s `reactCompilerPreset` through
//     `@rolldown/plugin-babel`), which compile every first-party package from
//     source, the module bundles included;
//   - plugin-sdk's library build (ahead of time, `target: "19"`);
//   - the coverage ratchet (tooling/js/react-compiler-coverage.mjs), which
//     writes every bailout into the package's compiler-coverage.json;
//   - the compiled bun-test preload (tooling/js/bun-react-compiler.ts), which
//     runs the DOM lanes on compiled code.
//
// Plain JavaScript without dependencies: the callers hand in Babel, the
// preset and the plugin, resolved from their own packages (the isolated
// linker gives tooling/ none of them).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** The compiler's options, the same everywhere. React 19.3 ships
 *  `react/compiler-runtime`, so the target is 19 and no
 *  `react-compiler-runtime` package is needed. `infer` compiles what is
 *  shaped like a component or a hook; `panicThreshold: "none"` makes a
 *  function the compiler cannot prove safe a bailout (left as written,
 *  logged) instead of a build error. */
export function compilerOptions(extra = {}) {
  return {
    target: "19",
    compilationMode: "infer",
    panicThreshold: "none",
    environment: {
      // babel-plugin-react-compiler 1.0.0 moves a closure that captures
      // nothing reactive out to MODULE scope, also when it captures a
      // variable of the function the component is declared in: in
      // `function makePanel(host) { const Component = () => <button
      // onClick={() => run(host)} />; … }` the click handler becomes a
      // top-level `function _temp() { return run(host); }`, where `host`
      // does not exist. Every module's panels are built that way (a
      // factory closing over the BundleHost), and the compiled DOM lane
      // caught it (draw's Symbols and Appearance panels did nothing on
      // click). Outlining only saves a cache slot; without it the closure
      // stays where it was and is memoized like any other value.
      enableFunctionOutlining: false,
    },
    ...extra,
  };
}

/** Off only when asked: `PAGED_REACT_COMPILER=0` builds and serves the
 *  sources as written (the before/after measurements, and bisecting a
 *  behaviour change to the compiler). */
export function compilerEnabled(env = process.env) {
  return env.PAGED_REACT_COMPILER !== "0";
}

// First-party React sources, relative to the repository root: the `src`
// trees of the editor's apps and packages, of every module package, of the
// internal shared packages and of plugin-sdk. Not tests, not type
// declarations, not the render worker and not packages/client (both
// React-free by lint, apps/editor ADR 206).
const SOURCE_DIRS =
  "(?:apps/editor/(?:apps|packages)/[^/]+|modules/[^/]+/(?:packages/[^/]+|glue|manifest)|platform/shared/[^/]+|platform/extensions/packages/plugin-sdk)/src/";
const SOURCE_EXT = "\\.[cm]?[jt]sx?";
const EXCLUDED_FILES = "(?:\\.d\\.[cm]?ts|\\.(?:test|spec)\\.[cm]?[jt]sx?)";
const EXCLUDED_DIRS = "/(?:test|tests|__tests__)/";
const EXCLUDED_TREES =
  "(?:apps/editor/apps/canvas/src/worker/|apps/editor/packages/client/)";

const SOURCE = new RegExp(`^${SOURCE_DIRS}.+${SOURCE_EXT}$`);
const NOT_SOURCE = new RegExp(
  `${EXCLUDED_FILES}$|${EXCLUDED_DIRS}|^${EXCLUDED_TREES}`,
);

function toRelative(file) {
  const path = file.replace(/[?#].*$/, "");
  const rel = isAbsolute(path) ? relative(REPO_ROOT, path) : path;
  return rel.split(sep).join("/");
}

/** Whether the compiler compiles this file (an absolute path, a Vite module
 *  id with a query, or a repository-relative path). */
export function isReactSource(file) {
  const rel = toRelative(file);
  return SOURCE.test(rel) && !NOT_SOURCE.test(rel);
}

/** The same test as `{ include, exclude }` RegExps over absolute module ids,
 *  for a bundler's `filter.id`: Rolldown applies it before it reads a file,
 *  so Babel never parses the wasm-bindgen glue or a vendored dist. */
export function reactSourceIdFilter(root = REPO_ROOT) {
  const base = root
    .split(sep)
    .join("/")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = "(?:$|\\?)";
  return {
    include: [new RegExp(`^${base}/${SOURCE_DIRS}.+${SOURCE_EXT}${end}`)],
    exclude: [
      new RegExp(`${EXCLUDED_FILES}${end}`),
      new RegExp(EXCLUDED_DIRS),
      new RegExp(`^${base}/${EXCLUDED_TREES}`),
    ],
  };
}

/** A file can hold something the compiler compiles only if it can hold
 *  JSX or calls a hook (a `.ts` component without either is not inferred
 *  as one). The coverage run and the bun preload skip the rest unread by
 *  Babel. */
export function mayHoldReact(file, code) {
  return /\.[cm]?[jt]sx$/.test(file) || /\buse[A-Z0-9]\w*\s*[(<]/.test(code);
}

/** The compiler's version, for the reports. */
export function compilerVersion(resolvePackageJson) {
  try {
    return JSON.parse(readFileSync(resolvePackageJson, "utf8")).version;
  } catch {
    return "unknown";
  }
}

/** Compile one TypeScript/TSX source with the compiler alone (Babel only
 *  parses the types and the JSX; it strips nothing). `babel` and
 *  `pluginPath` are the caller's (`@babel/core`,
 *  `require.resolve("babel-plugin-react-compiler")`). Returns the source
 *  unchanged when the compiler memoized nothing in it. */
export function compileSource({
  babel,
  pluginPath,
  file,
  code,
  logger = null,
  sourceMaps = false,
}) {
  if (!mayHoldReact(file, code)) return code;
  const out = babel.transformSync(code, {
    filename: file,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    sourceMaps,
    parserOpts: {
      plugins: /x$/.test(file) ? ["typescript", "jsx"] : ["typescript"],
    },
    plugins: [[pluginPath, compilerOptions({ logger })]],
  });
  // Nothing memoized: keep the file as written (Babel would only have
  // reprinted it).
  if (!out?.code || !/["']react\/compiler-runtime["']/.test(out.code))
    return code;
  return out.code;
}

// --- Events ----------------------------------------------------------------
//
// The compiler's logger reports, per function it considers: CompileSuccess
// (compiled), CompileError (a rule it could not prove: the function is left
// as written), CompileSkip (an opt-out, e.g. "use no memo") or PipelineError
// (the compiler itself failed). One function can raise several errors; the
// function is one bailout.

function lineOf(loc) {
  return loc?.start?.line ?? null;
}

function detailOf(detail) {
  // CompilerErrorDetail keeps its fields under `options`; CompilerDiagnostic
  // has them on itself.
  const d = detail?.options ?? detail ?? {};
  return {
    category: d.category ?? "Unknown",
    reason: String(d.reason ?? d.description ?? "").split("\n")[0],
  };
}

/** A logger that collects events per file (an absolute path). */
export function createCollector() {
  const files = new Map();
  const at = (filename) => {
    const key = filename ?? "(unknown)";
    if (!files.has(key)) files.set(key, { compiled: [], bailouts: new Map() });
    return files.get(key);
  };
  const logger = {
    logEvent(filename, event) {
      const entry = at(filename);
      switch (event.kind) {
        case "CompileSuccess":
          entry.compiled.push({
            fn: event.fnName ?? "(anonymous)",
            line: lineOf(event.fnLoc),
            // 0 when nothing in the function needs a cache (a hook that
            // only reads a context): compiled, and no runtime import.
            memoSlots: event.memoSlots ?? 0,
          });
          break;
        case "CompileError":
        case "CompileSkip":
        case "PipelineError": {
          const line = lineOf(event.fnLoc);
          const key = `${line}`;
          const found = entry.bailouts.get(key);
          const { category, reason } =
            event.kind === "CompileError"
              ? detailOf(event.detail)
              : event.kind === "CompileSkip"
                ? { category: "OptOut", reason: String(event.reason) }
                : { category: "PipelineError", reason: String(event.data) };
          if (found) {
            if (!found.categories.includes(category))
              found.categories.push(category);
          } else {
            entry.bailouts.set(key, {
              line,
              categories: [category],
              reason,
            });
          }
          break;
        }
        default:
          break;
      }
    },
  };
  return { logger, files };
}

/** The function name a bailout belongs to: the compiler reports names only
 *  for compiled functions, so read it from the source line (`function X`,
 *  `const X =`, `X(`), falling back to the line. */
export function functionNameAt(code, line) {
  if (!line) return "(unknown)";
  const text = code.split("\n")[line - 1] ?? "";
  const m =
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text) ??
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/.exec(text) ??
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(:=]/.exec(
      text,
    ) ??
    /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/.exec(text);
  return m ? m[1] : `(line ${line})`;
}

/** The package directory (holding package.json) a source file belongs to. */
export function packageDirOf(file, exists) {
  let dir = dirname(isAbsolute(file) ? file : join(REPO_ROOT, file));
  while (dir.startsWith(REPO_ROOT) && dir !== REPO_ROOT) {
    if (exists(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return null;
}

// --- Vite -------------------------------------------------------------------

/** The compiler in a Vite build: `@vitejs/plugin-react`'s
 *  `reactCompilerPreset` run by `@rolldown/plugin-babel`, limited to the
 *  first-party sources, plus a build check. Put it after `react()` in
 *  `plugins`; the Babel plugin is `enforce: "pre"`, so the compiler sees the
 *  sources before Oxc strips the types and transforms the JSX (it is the
 *  only Babel plugin, so it runs first in the Babel pipeline).
 *
 *  The packages are the caller's, so that they resolve from the app:
 *  `reactCompiler({ reactCompilerPreset, babel })`.
 *
 *  The check (build only): every module the compiler compiled imports
 *  `react/compiler-runtime`, and every chunk that holds one reaches the
 *  chunk holding the runtime through its static imports. A build where the
 *  compiler did not run, ran on nothing, or resolved a second React fails
 *  here instead of shipping uncompiled. `PAGED_REACT_COMPILER_REPORT=<file>`
 *  writes what it found as JSON. */
export function reactCompiler({
  reactCompilerPreset,
  babel,
  root = REPO_ROOT,
}) {
  if (!compilerEnabled()) return [];
  const { logger, files } = createCollector();
  const preset = reactCompilerPreset(compilerOptions({ logger }));
  preset.rolldown.filter = {
    ...preset.rolldown.filter,
    id: reactSourceIdFilter(root),
  };
  return [babel({ presets: [preset] }), compiledChunksCheck(files)];
}

function compiledChunksCheck(files) {
  return {
    name: "paged:react-compiler-check",
    apply: "build",
    // The editor's workers are bundled by their own plugin pipeline; the
    // compiler runs on the client environment only.
    applyToEnvironment: (env) => env.config.consumer === "client",
    generateBundle(_options, bundle) {
      const compiled = [...files.entries()].filter(([, e]) =>
        e.compiled.some((f) => f.memoSlots > 0),
      );
      const functions = [...files.values()].reduce(
        (n, e) => n + e.compiled.length,
        0,
      );
      const skipped = [...files.values()].reduce(
        (n, e) => n + e.bailouts.size,
        0,
      );
      const problems = [];
      let runtime = null;
      const modules = [];
      for (const [file] of compiled) {
        const info = this.getModuleInfo(file);
        if (!info) continue; // compiled, then tree-shaken away
        const dep = info.importedIds.find((id) =>
          /[/\\]react[/\\](?:cjs[/\\])?compiler-runtime(?:\.[cm]?js)?(?:$|\?)/.test(
            id,
          ),
        );
        if (!dep) {
          problems.push(
            `${relative(REPO_ROOT, file)} was compiled but does not import react/compiler-runtime`,
          );
          continue;
        }
        if (runtime && runtime !== dep) {
          problems.push(
            `two copies of react/compiler-runtime: ${runtime} and ${dep}`,
          );
        }
        runtime ??= dep;
        modules.push(file);
      }
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const holder = runtime
        ? chunks.find((c) => c.moduleIds.includes(runtime))
        : null;
      if (modules.length === 0) {
        problems.push(
          "the React Compiler memoized nothing that reached the bundle",
        );
      } else if (!holder) {
        problems.push(`no chunk holds ${runtime}`);
      }
      const byName = new Map(chunks.map((c) => [c.fileName, c]));
      const reaches = (chunk) => {
        const seen = new Set();
        const stack = [chunk];
        while (stack.length > 0) {
          const c = stack.pop();
          if (c === holder) return true;
          if (seen.has(c.fileName)) continue;
          seen.add(c.fileName);
          for (const name of c.imports) {
            const next = byName.get(name);
            if (next) stack.push(next);
          }
        }
        return false;
      };
      const set = new Set(modules);
      const compiledChunks = chunks.filter((c) =>
        c.moduleIds.some((id) => set.has(id)),
      );
      if (holder) {
        for (const c of compiledChunks) {
          if (!reaches(c)) {
            problems.push(
              `chunk ${c.fileName} holds compiled code but does not import the chunk with react/compiler-runtime (${holder.fileName})`,
            );
          }
        }
      }
      const summary = {
        compiledFunctions: functions,
        skippedFunctions: skipped,
        compiledModules: modules.length,
        compiledChunks: compiledChunks.map((c) => c.fileName).sort(),
        runtimeChunk: holder?.fileName ?? null,
        problems,
      };
      if (process.env.PAGED_REACT_COMPILER_REPORT) {
        writeFileSync(
          process.env.PAGED_REACT_COMPILER_REPORT,
          `${JSON.stringify(summary, null, 2)}\n`,
        );
      }
      if (problems.length > 0) {
        this.error(`React Compiler check failed:\n${problems.join("\n")}`);
      }
      this.info(
        `React Compiler: ${functions} components and hooks compiled in ${modules.length} modules, ${skipped} skipped; ${compiledChunks.length} chunks import react/compiler-runtime (${holder.fileName})`,
      );
    },
  };
}
