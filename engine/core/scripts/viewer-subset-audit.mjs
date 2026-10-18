#!/usr/bin/env node
// The viewer subset audit: @paged-media/idml-viewer and its `./session` entry
// carry the renderer core only (PM-0008; "sibling, not a shrunk app").
//
//   node scripts/viewer-subset-audit.mjs                       # the crate graph only
//   node scripts/viewer-subset-audit.mjs <idml-viewer dir|tgz> # and the package's files
//   node scripts/viewer-subset-audit.mjs --no-cargo <dir|tgz>  # the package's files only
//
// Two proofs, one per layer:
//
//   1. The crate graph. `cargo tree -p paged-sdk` (wasm32, the shipped `gpu`
//      feature, normal edges) names none of the editor's crates: no mutation
//      engine (paged-mutate), no editing canvas (paged-canvas,
//      paged-canvas-wasm), no scripting (paged-script) and no introspection
//      (paged-introspect, paged-introspect-wasm).
//   2. The package. The session files are the paged-sdk build and nothing
//      else: wasm/ holds paged_sdk.{js,d.ts} and paged_sdk_bg.wasm, there is
//      no other .wasm, the declarations name none of the other surfaces'
//      classes, the wasm module exports none of their functions, and the
//      manifest has no runtime dependencies.
//
// Exit 1 on any breach. Plain Node: tar and cargo are the only tools it runs.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const noCargo = args.includes("--no-cargo");
const target = args.find((a) => !a.startsWith("--"));

const EDITOR_CRATES = /^paged-(mutate|canvas|script|introspect)(-|$)/;
// The classes and free functions of the other wasm surfaces
// (canvas-wasm, canvas-wasm/introspect, canvas-wasm/repo).
const FOREIGN_DECLS =
  /\bclass\s+(CanvasWorker|Inspector|Repository|Flush)\b|\bfunction\s+(describeCatalog|cameraSabLayout|cameraSabBytes|gestureSabLayout|gestureSabBytes)\b/;
const FOREIGN_EXPORTS =
  /^(canvasworker|inspector|repository|flush)_|^(describecatalog|camerasab|gesturesab)/i;
const SESSION_FILES = ["paged_sdk.d.ts", "paged_sdk.js", "paged_sdk_bg.wasm"];

const failures = [];
const fail = (m) => failures.push(m);

if (!noCargo) {
  const tree = execFileSync(
    "cargo",
    [
      "tree",
      "-p",
      "paged-sdk",
      "--target",
      "wasm32-unknown-unknown",
      "--features",
      "gpu",
      "-e",
      "normal",
      "--prefix",
      "none",
    ],
    { cwd: CORE, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const crates = new Set(
    tree
      .split("\n")
      .map((l) => l.trim().split(" ")[0])
      .filter(Boolean),
  );
  const breach = [...crates].filter((c) => EDITOR_CRATES.test(c)).sort();
  if (breach.length) {
    fail(`paged-sdk's crate graph links editor crates: ${breach.join(", ")}`);
  } else {
    const paged = [...crates].filter((c) => c.startsWith("paged-")).sort();
    console.log(
      `crate graph OK — paged-sdk links ${paged.length} paged crates, none of paged-mutate/-canvas/-script/-introspect`,
    );
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (target) {
  let pkgDir = target;
  let scratch = null;
  if (target.endsWith(".tgz")) {
    scratch = mkdtempSync(join(tmpdir(), "viewer-audit-"));
    execFileSync("tar", ["-xzf", target, "-C", scratch]);
    pkgDir = join(scratch, "package");
  }
  try {
    const manifest = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8"),
    );
    if (manifest.name !== "@paged-media/idml-viewer") {
      fail(`${target} is ${manifest.name}, not @paged-media/idml-viewer`);
    }
    const deps = Object.keys(manifest.dependencies ?? {});
    if (deps.length) {
      fail(`the viewer has runtime dependencies: ${deps.join(", ")}`);
    }
    const wasmDir = join(pkgDir, "wasm");
    const present = existsSync(wasmDir) ? readdirSync(wasmDir).sort() : [];
    // In a source checkout wasm/ may also hold wasm-bindgen's
    // paged_sdk_bg.wasm.d.ts, which `files` does not ship.
    const extra = present.filter(
      (f) => !SESSION_FILES.includes(f) && f !== "paged_sdk_bg.wasm.d.ts",
    );
    const missing = SESSION_FILES.filter((f) => !present.includes(f));
    if (missing.length) fail(`wasm/ lacks ${missing.join(", ")}`);
    if (extra.length)
      fail(`wasm/ holds more than the session: ${extra.join(", ")}`);
    const otherWasm = walk(pkgDir)
      .filter((f) => f.endsWith(".wasm"))
      .map((f) => relative(pkgDir, f))
      .filter(
        (f) => f !== "wasm/paged_sdk_bg.wasm" && !f.startsWith("node_modules/"),
      );
    if (otherWasm.length)
      fail(`other wasm in the package: ${otherWasm.join(", ")}`);
    if (!missing.length) {
      const dts = readFileSync(join(wasmDir, "paged_sdk.d.ts"), "utf8");
      const decl = dts.match(FOREIGN_DECLS);
      if (decl) fail(`the session declarations name ${decl[0]}`);
      const mod = new WebAssembly.Module(
        readFileSync(join(wasmDir, "paged_sdk_bg.wasm")),
      );
      const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
      const foreign = exports.filter((n) => FOREIGN_EXPORTS.test(n));
      if (foreign.length) {
        fail(
          `the session wasm exports other surfaces' functions: ${foreign.slice(0, 8).join(", ")}`,
        );
      }
      if (!exports.some((n) => n.startsWith("viewersession_"))) {
        fail(
          "the session wasm exports no viewersession_* function: is it the paged-sdk build?",
        );
      }
      if (!decl && !foreign.length) {
        console.log(
          `package OK — wasm/ is the paged-sdk session (${exports.length} exports, none of canvas/introspect/repo)`,
        );
      }
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (failures.length) {
  for (const f of failures) console.error(`::error::viewer subset audit: ${f}`);
  process.exit(1);
}
console.log("viewer subset audit OK");
