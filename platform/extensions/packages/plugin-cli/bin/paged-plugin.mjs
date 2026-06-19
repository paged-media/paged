#!/usr/bin/env node
// @paged-media/plugin-cli — `paged-plugin validate <manifest.json>`.
//
// Plain ESM, zero dependencies, no build step. Validates a plugin
// manifest against the contract in
// `../../plugin-api/src/manifest.schema.json` — hand-rolled checks
// rather than a generic JSON-schema engine, so the CLI stays
// dependency-free; the schema file remains the formal artifact and
// the two are kept in sync by the checks below mirroring it 1:1.
//
// Beyond the schema, `validate` enforces the namespace rule (every
// contributed tool/command id starts with `<manifest.id>.`) and that
// referenced `*.panel.json` files exist relative to the manifest.

import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// The closed capability vocabularies below are PROJECTIONS of the enums in
// plugin-api `manifest.schema.json` (the single source of truth, ADR 019). They
// stay hand-mirrored here because this CLI is zero-dep and runs standalone — but
// plugin-sdk/test/capability-vocabulary.spec.ts now GATES them against the schema,
// so drift fails CI. Change a vocabulary in the schema first, then mirror here.
const RENDERING = new Set([
  "sceneLayer",
  "overlay",
  "hitTest",
  "resourceProvider",
]);
const CLIPBOARD = new Set(["none", "vector", "full"]);
const SCOPES = new Set(["broad", "scoped"]);
const ENTRIES = new Set(["doubleClick", "command"]);
const BAKED_FALLBACKS = new Set(["group", "rectangle", "raster"]);
const WASM_PURPOSES = new Set(["layout", "codec", "compute", "engine"]);
// GPU (WebGPU) realm vocabulary (I-07 / C-1 Stage B realm-local; ADR-018).
// "bundle" = the plugin uses WebGPU in its own JS realm (DECLARE-ONLY; no
// device handed). "shared" is RESERVED for the future host-device-sharing
// path and rejected today (the zero-copy walls — Vello external-texture +
// cross-realm device transfer — are unlifted; ADR-018).
const GPU_REALMS = new Set(["bundle"]);
const GPU_REALMS_RESERVED = new Set(["shared"]);
// Asset-store kinds. "fonts" gates getFontFace (W-06); "images" gates
// getPlacedImage (C-5 / I-04 — OPEN since core v42; the former v2
// reservation is honored). Mirrors AssetKind in plugin-api.
const ASSET_KINDS = new Set(["fonts", "images"]);
const ASSET_KINDS_RESERVED = new Set([]);

// WASM packaging budgets (W-07). Keep in sync with the host loader's
// WASM_BUDGETS in plugin-sdk/src/wasm-bundle-loader.ts and the schema's
// `maxBytes` maximum (8 MiB) — the CLI hand-mirrors the contract.
const WASM_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024; // 8 MiB layout/codec/compute
const WASM_MAX_ENGINE_ARTIFACT_BYTES = 64 * 1024 * 1024; // D-07b: purpose:"engine" (DuckDB-WASM)
const WASM_MAX_TOTAL_BYTES = 80 * 1024 * 1024; // declared total

// Bundle-relative wasm path: no leading slash, no `..` segment, .wasm.
const WASM_PATH_OK = /^(?!\/)(?!.*\.\.).+\.wasm$/;

// Worker budgets (K-3 / S-07). Keep in sync with WORKER_BUDGETS in
// plugin-sdk/src/host-impl.ts and the schema — the CLI hand-mirrors them.
const WORKERS_MAX = 8; // hard worker-count cap (min(declared, hwConcurrency, 8))
const WORKERS_MAX_SHARED_BYTES = 268435456; // 256 MiB per-bundle SAB ceiling

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function usage() {
  console.error("usage: paged-plugin validate <manifest.json>");
  process.exit(2);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Collect schema violations; returns an array of error strings. */
function validateManifest(manifest, manifestDir) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return ["manifest must be a JSON object"];
  }

  const known = new Set([
    "id", "name", "version", "apiVersion", "publisher",
    "capabilities", "contributes",
  ]);
  for (const key of Object.keys(manifest)) {
    if (!known.has(key)) err(`unknown top-level key "${key}"`);
  }

  // Required identity fields.
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) {
    err(`"id" must match ${ID_PATTERN} (reverse-DNS, e.g. "media.paged.draw")`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    err(`"name" must be a non-empty string`);
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    err(`"version" must be semver (got ${JSON.stringify(manifest.version)})`);
  }
  if (typeof manifest.apiVersion !== "string" || manifest.apiVersion.length === 0) {
    err(`"apiVersion" must be a non-empty semver range`);
  }
  if ("publisher" in manifest && typeof manifest.publisher !== "string") {
    err(`"publisher" must be a string`);
  }

  // Capabilities.
  const caps = manifest.capabilities;
  if (caps !== undefined) {
    if (typeof caps !== "object" || caps === null) {
      err(`"capabilities" must be an object`);
    } else {
      for (const key of Object.keys(caps)) {
        if (!["document", "rendering", "keybindings", "editContext", "assets", "storage", "network", "dataProviders", "clipboard", "wasm", "workers", "secrets", "gpu"].includes(key)) {
          err(`unknown capability "${key}"`);
        }
      }
      // D-09: data-provider roles — publish/consume are category string arrays.
      if (caps.dataProviders !== undefined) {
        const dp = caps.dataProviders;
        if (typeof dp !== "object" || dp === null || Array.isArray(dp)) {
          err(`"capabilities.dataProviders" must be an object`);
        } else {
          for (const role of ["publish", "consume"]) {
            if (dp[role] !== undefined && (!Array.isArray(dp[role]) || !dp[role].every((c) => typeof c === "string"))) {
              err(`"capabilities.dataProviders.${role}" must be an array of category strings`);
            }
          }
        }
      }
      const doc = caps.document;
      if (doc !== undefined) {
        if (typeof doc !== "object" || doc === null) err(`"capabilities.document" must be an object`);
        else {
          if (doc.read !== undefined && !SCOPES.has(doc.read)) err(`"capabilities.document.read" must be broad|scoped`);
          if (doc.write !== undefined && !SCOPES.has(doc.write)) err(`"capabilities.document.write" must be broad|scoped`);
        }
      }
      if (caps.rendering !== undefined) {
        if (!Array.isArray(caps.rendering) || !caps.rendering.every((r) => RENDERING.has(r))) {
          err(`"capabilities.rendering" entries must be sceneLayer|overlay|hitTest|resourceProvider`);
        }
      }
      // Asset-store kinds: "fonts" (W-06) | "images" (C-5, core v42).
      if (caps.assets !== undefined) {
        if (!Array.isArray(caps.assets)) {
          err(`"capabilities.assets" must be an array of asset kinds`);
        } else {
          for (const a of caps.assets) {
            if (ASSET_KINDS.has(a)) continue;
            if (ASSET_KINDS_RESERVED.has(a)) {
              err(
                `"capabilities.assets" entry "${a}" is reserved — ` +
                  `supported today: "fonts", "images" (W-06 / C-5)`,
              );
            } else {
              err(`"capabilities.assets" entries must be "fonts" or "images"`);
            }
          }
        }
      }
      // W3.10: the keybindings capability is the declaration for the
      // `contribute.keybinding` door (keybindings carry no id to list).
      if (caps.keybindings !== undefined && typeof caps.keybindings !== "boolean") {
        err(`"capabilities.keybindings" must be a boolean`);
      }
      if (caps.editContext !== undefined && !isStringArray(caps.editContext)) {
        err(`"capabilities.editContext" must be a string array`);
      }
      // K-4 / S-08: persistent binary storage — { blob?: boolean, quotaBytes?: integer }.
      if (caps.storage !== undefined) {
        const s = caps.storage;
        if (typeof s !== "object" || s === null || Array.isArray(s)) {
          err(`"capabilities.storage" must be an object`);
        } else {
          const extra = Object.keys(s).filter((k) => !["blob", "quotaBytes"].includes(k));
          if (extra.length) err(`"capabilities.storage" unknown key(s): ${extra.join(", ")}`);
          if (s.blob !== undefined && typeof s.blob !== "boolean") {
            err(`"capabilities.storage.blob" must be a boolean`);
          }
          if (s.quotaBytes !== undefined && !Number.isInteger(s.quotaBytes)) {
            err(`"capabilities.storage.quotaBytes" must be an integer`);
          }
        }
      }
      // D-03: network is the legacy boolean OR a structured per-origin
      // declaration { origins: string[] | "consent", purpose?: string }. Reach
      // is always consent-gated at runtime; this is the OUTER allow-list bound.
      if (caps.network !== undefined) {
        const n = caps.network;
        if (typeof n === "boolean") {
          // ok — legacy shorthand
        } else if (typeof n === "object" && n !== null && !Array.isArray(n)) {
          const extra = Object.keys(n).filter((k) => !["origins", "purpose"].includes(k));
          if (extra.length) err(`"capabilities.network" unknown key(s): ${extra.join(", ")}`);
          if (n.origins === "consent") {
            // ok — no fixed allow-list; every reach runtime-consented
          } else if (Array.isArray(n.origins)) {
            for (const o of n.origins) {
              if (typeof o !== "string" || !/^https?:\/\/[^/]+$/.test(o)) {
                err(`"capabilities.network.origins" entry "${o}" must be scheme://host[:port]`);
              }
            }
          } else {
            err(`"capabilities.network.origins" must be a string[] or "consent"`);
          }
          if (n.purpose !== undefined && typeof n.purpose !== "string") {
            err(`"capabilities.network.purpose" must be a string`);
          }
        } else {
          err(`"capabilities.network" must be a boolean or { origins, purpose }`);
        }
      }
      if (caps.clipboard !== undefined && !CLIPBOARD.has(caps.clipboard)) {
        err(`"capabilities.clipboard" must be none|vector|full`);
      }
      // K-3 / S-07: worker spawn + SAB — { max: integer 1..8, sharedMemory?:
      // boolean, maxSharedBytes?: integer 1..256 MiB }.
      if (caps.workers !== undefined) {
        const w = caps.workers;
        if (typeof w !== "object" || w === null || Array.isArray(w)) {
          err(`"capabilities.workers" must be an object`);
        } else {
          const extra = Object.keys(w).filter(
            (k) => !["max", "sharedMemory", "maxSharedBytes"].includes(k),
          );
          if (extra.length) err(`"capabilities.workers" unknown key(s): ${extra.join(", ")}`);
          if (!Number.isInteger(w.max) || w.max < 1 || w.max > WORKERS_MAX) {
            err(`"capabilities.workers.max" must be an integer 1..${WORKERS_MAX}`);
          }
          if (w.sharedMemory !== undefined && typeof w.sharedMemory !== "boolean") {
            err(`"capabilities.workers.sharedMemory" must be a boolean`);
          }
          if (
            w.maxSharedBytes !== undefined &&
            (!Number.isInteger(w.maxSharedBytes) ||
              w.maxSharedBytes < 1 ||
              w.maxSharedBytes > WORKERS_MAX_SHARED_BYTES)
          ) {
            err(
              `"capabilities.workers.maxSharedBytes" must be an integer ` +
                `1..${WORKERS_MAX_SHARED_BYTES}`,
            );
          }
        }
      }
      // D-11 (rfc-credential-store): the host credential-store door —
      // { sources: boolean }. REFERENCE-ONLY; gates host.secrets (set/exists/
      // forget, NO get). Closed object vocabulary, hand-mirrors the schema.
      if (caps.secrets !== undefined) {
        const s = caps.secrets;
        if (typeof s !== "object" || s === null || Array.isArray(s)) {
          err(`"capabilities.secrets" must be an object`);
        } else {
          const extra = Object.keys(s).filter((k) => !["sources"].includes(k));
          if (extra.length) err(`"capabilities.secrets" unknown key(s): ${extra.join(", ")}`);
          if (typeof s.sources !== "boolean") {
            err(`"capabilities.secrets.sources" must be a boolean`);
          }
        }
      }
      // I-07 / C-1 Stage B (realm-local; ADR-018): the WebGPU usage
      // declaration — { realm: "bundle" }. DECLARE-ONLY (no device handed;
      // the bundle already has navigator.gpu in its own realm). Closed
      // vocabulary, hand-mirrors the schema. "shared" is RESERVED for the
      // future host-device-sharing path and rejected today.
      if (caps.gpu !== undefined) {
        const g = caps.gpu;
        if (typeof g !== "object" || g === null || Array.isArray(g)) {
          err(`"capabilities.gpu" must be an object`);
        } else {
          const extra = Object.keys(g).filter((k) => !["realm"].includes(k));
          if (extra.length) err(`"capabilities.gpu" unknown key(s): ${extra.join(", ")}`);
          if (g.realm === undefined) {
            err(`"capabilities.gpu.realm" is required (must be "bundle")`);
          } else if (!GPU_REALMS.has(g.realm)) {
            if (GPU_REALMS_RESERVED.has(g.realm)) {
              err(
                `"capabilities.gpu.realm" value "${g.realm}" is reserved — ` +
                  `host-device-sharing is deferred (ADR-018); only "bundle" ` +
                  `(realm-local WebGPU) validates today`,
              );
            } else {
              err(`"capabilities.gpu.realm" must be "bundle"`);
            }
          }
        }
      }
      // WASM packaging (W-07): declared-only artifacts, closed purpose
      // vocabulary, path-traversal rejected, per-artifact + total budget.
      const wasm = caps.wasm;
      if (wasm !== undefined) {
        if (!Array.isArray(wasm)) {
          err(`"capabilities.wasm" must be an array of artifacts`);
        } else {
          const seenNames = new Set();
          let declaredTotal = 0;
          for (let i = 0; i < wasm.length; i++) {
            const a = wasm[i];
            const at = `capabilities.wasm[${i}]`;
            if (typeof a !== "object" || a === null || Array.isArray(a)) {
              err(`${at} must be an object`);
              continue;
            }
            for (const k of Object.keys(a)) {
              if (!["name", "path", "purpose", "maxBytes"].includes(k)) {
                err(`${at} has unknown key "${k}"`);
              }
            }
            if (typeof a.name !== "string" || a.name.length === 0) {
              err(`${at}.name must be a non-empty string`);
            } else if (seenNames.has(a.name)) {
              err(`${at}.name "${a.name}" is declared more than once`);
            } else {
              seenNames.add(a.name);
            }
            if (typeof a.path !== "string" || !WASM_PATH_OK.test(a.path)) {
              err(
                `${at}.path "${a.path}" must be a bundle-relative *.wasm ` +
                  `path (no leading "/", no ".." segment)`,
              );
            } else {
              const resolved = resolve(manifestDir, a.path);
              if (existsSync(resolved)) {
                const size = statSync(resolved).size;
                const hostCeiling =
                  a.purpose === "engine"
                    ? WASM_MAX_ENGINE_ARTIFACT_BYTES
                    : WASM_MAX_ARTIFACT_BYTES;
                const ceiling =
                  typeof a.maxBytes === "number" && a.maxBytes > 0
                    ? Math.min(a.maxBytes, hostCeiling)
                    : hostCeiling;
                if (size > ceiling) {
                  err(
                    `${at} file "${a.path}" is ${size} bytes, over its ` +
                      `${ceiling}-byte ceiling`,
                  );
                }
                declaredTotal += size;
              } else {
                // File not present at validate time (the bundle may not
                // be built yet); count the declared budget toward the
                // total so an over-budget DECLARATION is still caught.
                declaredTotal +=
                  typeof a.maxBytes === "number" ? a.maxBytes : 0;
              }
            }
            if (a.purpose === undefined || !WASM_PURPOSES.has(a.purpose)) {
              err(`${at}.purpose must be layout|codec|compute|engine`);
            }
            if (a.maxBytes !== undefined) {
              if (!Number.isInteger(a.maxBytes) || a.maxBytes < 1) {
                err(`${at}.maxBytes must be a positive integer`);
              } else {
                const cap =
                  a.purpose === "engine"
                    ? WASM_MAX_ENGINE_ARTIFACT_BYTES
                    : WASM_MAX_ARTIFACT_BYTES;
                if (a.maxBytes > cap) {
                  err(
                    `${at}.maxBytes (${a.maxBytes}) exceeds the host ` +
                      `per-artifact ceiling (${cap})`,
                  );
                }
              }
            }
          }
          if (declaredTotal > WASM_MAX_TOTAL_BYTES) {
            err(
              `"capabilities.wasm" total (${declaredTotal} bytes) exceeds ` +
                `the bundle ceiling (${WASM_MAX_TOTAL_BYTES})`,
            );
          }
        }
      }
    }
  }

  // Contributions + namespace rule.
  const contributes = manifest.contributes;
  if (contributes !== undefined) {
    if (typeof contributes !== "object" || contributes === null) {
      err(`"contributes" must be an object`);
    } else {
      for (const key of Object.keys(contributes)) {
        if (!["tools", "panels", "commands", "editContexts", "objectTypes", "importers", "exporters", "partTypes"].includes(key)) {
          err(`unknown contribution kind "${key}"`);
        }
      }
      const ns = typeof manifest.id === "string" ? `${manifest.id}.` : null;
      for (const kind of ["tools", "commands", "importers", "exporters"]) {
        const ids = contributes[kind];
        if (ids === undefined) continue;
        if (!isStringArray(ids)) {
          err(`"contributes.${kind}" must be a string array`);
          continue;
        }
        if (ns) {
          for (const id of ids) {
            if (!id.startsWith(ns)) {
              err(`contributed ${kind.slice(0, -1)} "${id}" must be namespaced under "${ns}"`);
            }
          }
        }
      }
      const panels = contributes.panels;
      if (panels !== undefined) {
        if (!isStringArray(panels)) {
          err(`"contributes.panels" must be a string array`);
        } else {
          const ns2 = typeof manifest.id === "string" ? `${manifest.id}.` : null;
          for (const p of panels) {
            if (p.endsWith(".panel.json")) {
              const path = resolve(manifestDir, p);
              if (!existsSync(path)) err(`panel file not found: ${p} (resolved ${path})`);
            } else if (ns2 && !p.startsWith(ns2)) {
              err(`contributed panel "${p}" must be namespaced under "${ns2}" (or be a *.panel.json path)`);
            }
          }
        }
      }
      const ecs = contributes.editContexts;
      if (ecs !== undefined) {
        if (!Array.isArray(ecs)) {
          err(`"contributes.editContexts" must be an array`);
        } else {
          for (const ec of ecs) {
            if (typeof ec !== "object" || ec === null ||
                typeof ec.type !== "string" || !ENTRIES.has(ec.entry) ||
                (ec.priority !== undefined && !Number.isInteger(ec.priority))) {
              err(`each editContext needs { type: string, entry: doubleClick|command }`);
            }
          }
        }
      }
      const ots = contributes.objectTypes;
      if (ots !== undefined) {
        if (!Array.isArray(ots)) {
          err(`"contributes.objectTypes" must be an array`);
        } else {
          for (const ot of ots) {
            if (typeof ot !== "object" || ot === null ||
                typeof ot.type !== "string" || !BAKED_FALLBACKS.has(ot.bakedFallback)) {
              err(`each objectType needs { type: string, bakedFallback: group|rectangle|raster }`);
            }
          }
        }
      }
      // `.paged` container part-types (file-format.md §8.1) — declarative.
      const pts = contributes.partTypes;
      if (pts !== undefined) {
        if (!Array.isArray(pts)) {
          err(`"contributes.partTypes" must be an array`);
        } else {
          for (const pt of pts) {
            if (typeof pt !== "object" || pt === null ||
                typeof pt.type !== "string" ||
                !["spec", "source", "derived"].includes(pt.role) ||
                typeof pt.format !== "string" ||
                (pt.linkable !== undefined && typeof pt.linkable !== "boolean")) {
              err(`each partType needs { type: string, role: spec|source|derived, format: string, linkable?: boolean }`);
            }
          }
        }
      }
    }
  }

  return errors;
}

// ── main ─────────────────────────────────────────────────────────
const [command, target] = process.argv.slice(2);
if (command !== "validate" || !target) usage();

const manifestPath = resolve(process.cwd(), target);
if (!existsSync(manifestPath)) fail(`no such file: ${manifestPath}`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`invalid JSON in ${manifestPath}: ${e.message}`);
}

const errors = validateManifest(manifest, dirname(manifestPath));
if (errors.length > 0) {
  console.error(`✗ ${manifestPath}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ ${manifest.id}@${manifest.version} valid (apiVersion ${manifest.apiVersion})`);
