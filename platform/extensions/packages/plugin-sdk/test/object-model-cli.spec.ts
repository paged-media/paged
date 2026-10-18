/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @feat: plugin-platform.object-model
//
// ADR 323 rule 4 — plugin-cli `validate` over `contributes.objectModel`
// (a kind with no schema rows, a row whose type is not a ValueType, a
// command with no args FAIL; schema files resolve bundle-relative) and the
// shrink-only untyped-command baseline. Drives the real zero-dep CLI as a
// subprocess, and gates its hand-mirrored ValueType list + the manifest
// schema against the SDK's.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { VALUE_TYPE_KINDS } from "../src/object-schema";
import { notesManifest } from "./fixtures/notes-bundle";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../plugin-cli/bin/paged-plugin.mjs");

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function run(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function validate(manifest: unknown, files: Record<string, unknown> = {}, extra: string[] = []) {
  dir = mkdtempSync(join(tmpdir(), "paged-om-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return run(["validate", path, ...extra]);
}

const base = { id: "media.paged.om", name: "om", version: "1.0.0", apiVersion: "^0.2" };
const om = (objectModel: unknown, commands?: string[]) => ({
  ...base,
  contributes: { objectModel, ...(commands ? { commands } : {}) },
});

describe("plugin-cli validate — contributes.objectModel (ADR 323)", () => {
  it("accepts the reference notes manifest (inline schema + typed command)", () => {
    const r = validate(notesManifest);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });

  it("accepts a schema and args held in bundle-relative files", () => {
    const r = validate(
      om({
        kinds: [{ kind: "layer", title: "Layer", schema: "layer.schema.json" }],
        commands: [{ id: "media.paged.om.go", title: "Go", args: "go.args.json" }],
      }),
      {
        "layer.schema.json": [{ path: "opacity", type: { kind: "number", unit: "percent" }, range: { min: 0, max: 100 } }],
        "go.args.json": { kind: "struct", fields: { n: { kind: "number" } } },
      },
    );
    expect(r.code).toBe(0);
  });

  it("fails a kind with no schema rows, or no schema at all", () => {
    expect(validate(om({ kinds: [{ kind: "layer", title: "Layer", schema: [] }] })).err).toMatch(/has no schema rows/);
    expect(validate(om({ kinds: [{ kind: "layer", title: "Layer" }] })).err).toMatch(/has no schema/);
    const r = validate(om({ kinds: [{ kind: "layer", title: "Layer", schema: "missing.json" }] }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/file not found: missing\.json/);
  });

  it("fails a row whose type is not a ValueType, and a repeated path", () => {
    const bad = validate(om({ kinds: [{ kind: "k", title: "K", schema: [{ path: "a", type: { kind: "float" } }] }] }));
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/"float" is not a ValueType/);
    expect(
      validate(om({ kinds: [{ kind: "k", title: "K", schema: [{ path: "a", type: { kind: "enum", members: [] } }] }] })).err,
    ).toMatch(/enum needs/);
    expect(
      validate(
        om({
          kinds: [
            { kind: "k", title: "K", schema: [{ path: "a", type: { kind: "bool" } }, { path: "a", type: { kind: "bool" } }] },
          ],
        }),
      ).err,
    ).toMatch(/repeated/);
  });

  it("fails a typed command with no args schema, or outside the namespace", () => {
    const k = { kind: "k", title: "K", schema: [{ path: "a", type: { kind: "bool" } }] };
    expect(validate(om({ kinds: [k], commands: [{ id: "media.paged.om.x", title: "X" }] })).err).toMatch(/has no args schema/);
    expect(
      validate(om({ kinds: [k], commands: [{ id: "other.x", title: "X", args: { kind: "struct", fields: {} } }] })).err,
    ).toMatch(/namespaced/);
  });
});

describe("plugin-cli — the untyped-command baseline (shrink-only)", () => {
  const k = { kind: "k", title: "K", schema: [{ path: "a", type: { kind: "bool" } }] };
  const baselineFile = (plugins: Record<string, string[]>) => ({ "baseline.json": { adr: "323", plugins } });

  it("a plugin NOT in the baseline: untyped commands only warn", () => {
    const r = validate(om({ kinds: [k] }, ["media.paged.om.a"]), baselineFile({}), []);
    expect(r.code).toBe(0);
  });

  it("a plugin in the baseline: a NEW untyped command fails; a typed twin clears it; stale entries warn", () => {
    const files = baselineFile({ "media.paged.om": ["media.paged.om.a", "media.paged.om.gone"] });
    const args = () => ["--untyped-baseline", join(dir!, "baseline.json")];
    // writes the files first, then validates with the baseline flag
    dir = mkdtempSync(join(tmpdir(), "paged-om-"));
    for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(c));
    const write = (m: unknown) => {
      const p = join(dir!, "manifest.json");
      writeFileSync(p, JSON.stringify(m));
      return run(["validate", p, ...args()]);
    };
    const grown = write(om({ kinds: [k] }, ["media.paged.om.a", "media.paged.om.b"]));
    expect(grown.code).toBe(1);
    expect(grown.err).toMatch(/"media\.paged\.om\.b" is untyped and not in the baseline/);
    expect(grown.err).toMatch(/warning: baseline lists "media\.paged\.om\.gone"/);

    const typed = write(
      om({ kinds: [k], commands: [{ id: "media.paged.om.b", title: "B", args: { kind: "struct", fields: {} } }] }, [
        "media.paged.om.a",
        "media.paged.om.b",
      ]),
    );
    expect(typed.code).toBe(0);
  });

  it("the shipped baseline is well formed and the untyped generator reproduces a plugin's list", () => {
    const shipped = JSON.parse(readFileSync(resolve(here, "../../plugin-cli/untyped-commands.baseline.json"), "utf8"));
    expect(shipped.adr).toBe("323");
    expect(Object.keys(shipped.plugins)).toEqual(expect.arrayContaining(["media.paged.draw", "media.paged.image"]));
    dir = mkdtempSync(join(tmpdir(), "paged-om-"));
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify(om({ kinds: [k] }, ["media.paged.om.z", "media.paged.om.a"])));
    const r = run(["untyped", p]);
    expect(JSON.parse(r.out).plugins).toEqual({ "media.paged.om": ["media.paged.om.a", "media.paged.om.z"] });
  });
});

describe("hand mirrors stay in sync", () => {
  it("the CLI's ValueType list and the manifest schema's enum equal the SDK's", () => {
    const cli = readFileSync(CLI, "utf8");
    const m = /const VALUE_TYPE_KINDS = new Set\(\[([\s\S]*?)\]\)/.exec(cli);
    const cliKinds = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    expect(cliKinds.sort()).toEqual([...VALUE_TYPE_KINDS].sort());
    const schema = JSON.parse(readFileSync(resolve(here, "../../plugin-api/src/manifest.schema.json"), "utf8"));
    const kinds = schema.properties.contributes.properties.objectModel.properties.kinds.items.properties.schema.oneOf[1].items.properties.type.properties.kind.enum;
    expect([...kinds].sort()).toEqual([...VALUE_TYPE_KINDS].sort());
  });
});
