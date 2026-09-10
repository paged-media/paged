#!/usr/bin/env node
// Capability-catalog vendoring (ADR 019). Sibling of sync-wire.mjs: where
// sync-wire vendors the engine WIRE TYPES (.d.ts), this vendors the engine
// CAPABILITY CATALOG (host fns + the settable property paths + id grammar +
// constraints) — the single generated contract core publishes as
// `catalog.json` inside @paged-media/introspect-wasm.
//
//   node scripts/sync-catalog.mjs              # copy from the published pkg
//   node scripts/sync-catalog.mjs --check      # fail if the copy drifted
//   node scripts/sync-catalog.mjs --source <f> # explicit catalog.json override
//
// SOURCE resolution (in order):
//   1. --source <path> to a catalog.json, OR
//   2. @paged-media/introspect-wasm resolved from the editor's node_modules
//      (Decision B: the editor consumes introspect-wasm). NOTE: the catalog ships
//      in introspect-wasm from the FIRST release after ADR 019 Phase 2 — until
//      then `--check` against the published package reports the file missing;
//      that is the cross-repo release-ordering signal, not a script bug.
// If neither resolves the script EXITS NONZERO (the vendored catalog is a
// contract coupling; a check that can't see its source is not a passing check).

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET = resolve(ROOT, "packages/plugin-api/src/catalog.json");
const PROVENANCE = resolve(ROOT, "packages/plugin-api/src/catalog.provenance.json");
// TWO layouts, the same probe sync-wire.mjs carries: the plugin repos
// moved under `~/paged/plugins/` on 2026-08-03, so a bare `../editor`
// now points at `~/paged/plugins/editor`, which does not exist. First
// existing candidate wins.
const RESOLVE_CANDIDATES = [
  resolve(ROOT, "../../editor/packages/client"), // ~/paged/editor — local
  resolve(ROOT, "../editor/packages/client"), // sibling — CI checkout
];
const RESOLVE_FROM =
  process.env.PAGED_INTROSPECT_WASM_FROM ??
  RESOLVE_CANDIDATES.find((c) => existsSync(resolve(c, "package.json"))) ??
  RESOLVE_CANDIDATES[0];
// core's own generated catalog, when a checkout is beside us. It is the
// SOURCE the published package is built from, so comparing against it is
// stricter than comparing against npm — and it is the only comparison
// that can be made while the vendored copy legitimately leads a publish.
const CORE_CANDIDATES = [
  resolve(ROOT, "../../core/crates/paged-introspect/catalog.json"),
  resolve(ROOT, "../core/crates/paged-introspect/catalog.json"),
];
const CORE_CATALOG =
  process.env.CORE_REPO
    ? resolve(process.env.CORE_REPO, "crates/paged-introspect/catalog.json")
    : CORE_CANDIDATES.find((c) => existsSync(c));
const PKG = "@paged-media/introspect-wasm";
const CATALOG_FILE = "catalog.json";

/**
 * The recorded provenance of the vendored copy.
 *
 * The vendored catalog is allowed to LEAD the published engine — that is
 * what the protocol bump chain looks like from the middle of it — but
 * only while this file says so and says why. Silence is not permission.
 */
export function provenance() {
  if (!existsSync(PROVENANCE)) {
    throw new Error(
      `sync-catalog: ${PROVENANCE} is missing. The vendored catalog must record where it came from; ` +
        "without it, a difference from the published package cannot be told apart from a mistake.",
    );
  }
  return validateProvenance(JSON.parse(readFileSync(PROVENANCE, "utf8")));
}

/** The claims a provenance record must actually make. */
export function validateProvenance(p) {
  for (const key of ["source", "targetsProtocol", "aheadOfPublished", "why"]) {
    if (p[key] === undefined) throw new Error(`sync-catalog: provenance is missing "${key}"`);
  }
  if (p.aheadOfPublished && String(p.why).length < 120) {
    throw new Error("sync-catalog: leading the published engine costs a real explanation, not a phrase");
  }
  return p;
}

/** `0.<protocol>.<patch>` — the scheme every engine package is versioned by. */
function protocolOf(version) {
  const m = /^0\.(\d+)\./.exec(String(version));
  return m ? Number(m[1]) : null;
}

/** Resolve the source catalog.json and its package version. */
export function resolveSource(opts = {}) {
  if (opts.source) {
    const path = resolve(opts.source);
    if (!existsSync(path)) throw new Error(`sync-catalog: --source not found: ${path}`);
    return { path, version: "unknown" };
  }
  const from = opts.resolveFrom ?? RESOLVE_FROM;
  let req;
  try {
    req = createRequire(pathToFileURL(resolve(from, "package.json")));
  } catch (err) {
    throw new Error(`sync-catalog: cannot anchor require at ${from} (${String(err)})`);
  }
  let pkgJsonPath;
  try {
    pkgJsonPath = req.resolve(`${PKG}/package.json`);
  } catch {
    throw new Error(
      `sync-catalog: ${PKG} is not resolvable from ${from}. Install it or pass ` +
        `--source <catalog.json>. No warn-skip: the vendored catalog is a contract coupling.`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const path = resolve(dirname(pkgJsonPath), CATALOG_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `sync-catalog: ${PKG}@${pkg.version} resolved but ${CATALOG_FILE} is missing — ` +
        `the catalog ships from the first release after ADR 019 Phase 2. Bump ${PKG}.`,
    );
  }
  return { path, version: pkg.version ?? "unknown" };
}

/** The vendored content (the catalog JSON verbatim, normalized to a trailing newline). */
export function buildVendored({ path }) {
  return readFileSync(path, "utf8").trimEnd() + "\n";
}

/**
 * Run a --check.
 *
 * Three outcomes, not two. A difference from the published package is
 * only a failure when nothing explains it: while the bump chain is in
 * flight the vendored copy is SUPPOSED to lead, and a gate that cannot
 * express that would either be switched off (which is what happened to
 * this one for months) or force a re-sync that undoes a real fix.
 *
 * The lead is also checked for rot, which is the half that usually
 * goes unwatched: once the published package reaches the protocol the
 * provenance targets, the marker must go, and this fails until it does.
 */
export function checkVendored(opts = {}) {
  const target = opts.target ?? TARGET;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";

  // Provenance is about THE vendored copy. A call that points target and
  // source somewhere else is exercising the pure vendor/drift logic, and
  // reading this repo's provenance into it would make an unrelated
  // comparison answer for the real one.
  const vendored = target === TARGET;
  let prov = null;
  try {
    if (opts.provenance) prov = validateProvenance(opts.provenance);
    else if (vendored) prov = provenance();
  } catch (err) {
    return { ok: false, reason: String(err.message ?? err).replace(/^sync-catalog:\s*/, "") };
  }

  // Strictest available comparison: core's own generated catalog, which
  // is what the published package is BUILT from.
  // `core: null` says "do not consult a core checkout" — the tests need
  // the npm path even on a machine that has core beside it.
  const coreCatalog = opts.core === undefined ? CORE_CATALOG : opts.core;
  if (prov && !opts.source && coreCatalog && existsSync(coreCatalog)) {
    const fresh = buildVendored({ path: coreCatalog });
    if (current !== fresh) {
      return {
        ok: false,
        reason:
          `vendored catalog.json differs from core's own ${coreCatalog} — run ` +
          "`node scripts/sync-catalog.mjs --source <that file>` and commit. " +
          "core is the source the published package is built from, so this comparison is the strict one.",
      };
    }
    return { ok: true, version: `core (protocol ${prov.targetsProtocol})`, against: "core" };
  }

  let src;
  try {
    src = resolveSource(opts);
  } catch (err) {
    return { ok: false, reason: String(err.message ?? err).replace(/^sync-catalog:\s*/, "") };
  }
  const fresh = buildVendored(src);
  const publishedProtocol = protocolOf(src.version);

  if (current === fresh) {
    if (prov?.aheadOfPublished) {
      return {
        ok: false,
        reason:
          `the vendored catalog matches ${PKG}@${src.version}, but the provenance still claims it LEADS the publish. ` +
          "The chain has caught up: set aheadOfPublished to false (and update rev / targetsProtocol) in " +
          "packages/plugin-api/src/catalog.provenance.json. An excuse that has outlived its gap is the half that rots.",
        version: src.version,
      };
    }
    return { ok: true, version: src.version, against: "npm" };
  }

  if (prov?.aheadOfPublished && publishedProtocol !== null && prov.targetsProtocol > publishedProtocol) {
    return {
      ok: true,
      version: src.version,
      against: "npm",
      ahead: `leads ${PKG}@${src.version} (protocol ${publishedProtocol}) by design, targeting protocol ${prov.targetsProtocol}: ${prov.why}`,
    };
  }

  return {
    ok: false,
    reason:
      `vendored catalog.json has drifted from ${PKG}@${src.version} and nothing explains it — either run ` +
      "`node scripts/sync-catalog.mjs` and commit, or record the lead in catalog.provenance.json with the reason. " +
      (publishedProtocol === null || !prov
        ? `(${src.version} does not parse as 0.<protocol>.<patch>, so the lead could not be checked.)`
        : `(published protocol ${publishedProtocol}, provenance targets ${prov.targetsProtocol}.)`),
    version: src.version,
  };
}

/** Write the vendored copy from the resolved source. */
export function writeVendored(opts = {}) {
  const src = resolveSource(opts);
  const target = opts.target ?? TARGET;
  writeFileSync(target, buildVendored(src));
  return { target, version: src.version, source: src.path };
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const out = { check: false, source: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--source") out.source = argv[++i];
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    const res = checkVendored({ source: args.source });
    if (!res.ok) {
      console.error(`sync-catalog: ${res.reason}`);
      process.exit(1);
    }
    console.log(
      `sync-catalog: vendored catalog in sync — checked against ${res.against ?? "the resolved source"} (${res.version})`,
    );
    if (res.ahead) console.log(`sync-catalog: ${res.ahead}`);
    process.exit(0);
  }
  try {
    const { target, version, source } = writeVendored({ source: args.source });
    console.log(`sync-catalog: wrote ${target} from ${PKG}@${version}`);
    console.log(`sync-catalog: source ${source}`);
  } catch (err) {
    console.error(`sync-catalog: ${err.message ?? err}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
