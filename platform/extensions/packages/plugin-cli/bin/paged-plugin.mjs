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

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const RENDERING = new Set(["sceneLayer", "overlay", "hitTest"]);
const CLIPBOARD = new Set(["none", "vector", "full"]);
const SCOPES = new Set(["broad", "scoped"]);
const ENTRIES = new Set(["doubleClick", "command"]);
const BAKED_FALLBACKS = new Set(["group", "rectangle", "raster"]);

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
        if (!["document", "rendering", "editContext", "network", "clipboard"].includes(key)) {
          err(`unknown capability "${key}"`);
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
          err(`"capabilities.rendering" entries must be sceneLayer|overlay|hitTest`);
        }
      }
      if (caps.editContext !== undefined && !isStringArray(caps.editContext)) {
        err(`"capabilities.editContext" must be a string array`);
      }
      if (caps.network !== undefined && typeof caps.network !== "boolean") {
        err(`"capabilities.network" must be a boolean`);
      }
      if (caps.clipboard !== undefined && !CLIPBOARD.has(caps.clipboard)) {
        err(`"capabilities.clipboard" must be none|vector|full`);
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
        if (!["tools", "panels", "commands", "editContexts", "objectTypes"].includes(key)) {
          err(`unknown contribution kind "${key}"`);
        }
      }
      const ns = typeof manifest.id === "string" ? `${manifest.id}.` : null;
      for (const kind of ["tools", "commands"]) {
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
