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

// @feat: plugin-platform.object-model.node-cli
//
// ADR 324 — the Node CLI end to end over the REAL engine (the published
// canvas-wasm, booted in Node): typed get/set round-trips through a saved
// file, schema-parsed values that fail by name, selectors by name and label,
// batch = one undo step, run scripts, core exports, exit codes.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseArgs } from "../src/args";
import { openSession, type CliSession } from "../src/session";
import { GLOBAL_OPTIONS, VERBS } from "../src/verbs";
import { cli, tempDir, writeFixture } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
});
afterAll(() => tmp.done());

const NP = "--no-plugins";

describe("get / set", () => {
  it("set story content, save to .paged, get it back from the file", async () => {
    const out = join(tmp.dir, "content.paged");
    const set = await cli(["set", fx.paged, "story", "content", "Price: 12 €", "-o", out, NP]);
    expect(set.code).toBe(0);
    expect(set.json.result).toMatchObject({ applied: true, undoSteps: 1 });
    expect(set.json.saved.path).toBe(out);
    const got = await cli(["get", out, "story", "content", NP]);
    expect(got.code).toBe(0);
    expect(got.json.results[0]).toMatchObject({ path: "content", value: "Price: 12 €" });
    // The input is untouched (-o wrote elsewhere).
    expect((await cli(["get", fx.paged, fx.story, "content", NP])).json.value).toBe("Hello");
  });

  it("values parse through the schema: a length with a unit becomes points", async () => {
    const out = join(tmp.dir, "stroke.paged");
    const set = await cli(["set", fx.paged, "rectangle:urect", "frameStrokeWeight", "2mm", "-o", out, NP]);
    expect(set.code).toBe(0);
    expect(set.json.value).toBeCloseTo((2 * 72) / 25.4, 6);
    const got = await cli(["get", out, "rectangle:urect", "frameStrokeWeight", NP]);
    expect(got.json.value).toBeCloseTo((2 * 72) / 25.4, 3);
  });

  it("no silent coercion: a bad value is refused naming the path and the expected type (exit 1)", async () => {
    const bad = await cli(["set", fx.paged, "rectangle:urect", "frameStrokeWeight", "thick", "--no-save", NP]);
    expect(bad.code).toBe(1);
    expect(bad.json.error.message).toMatch(/frameStrokeWeight/);
    expect(bad.json.error.message).toMatch(/expected length/);
    const en = await cli(["set", fx.paged, "swatch:Black", "space", "Pantone", "--no-save", NP]);
    expect(en.code).toBe(1);
    expect(en.json.error.message).toMatch(/space.*expected enum \(CMYK \| RGB \| LAB \| Gray\)/);
    const ro = await cli(["set", fx.paged, "doc", "pageCount", "3", "--no-save", NP]);
    expect(ro.code).toBe(1);
    expect(ro.json.error.message).toMatch(/pageCount: is derived/);
  });

  it("get without a path reads every row; a refused read exits 1", async () => {
    const all = await cli(["get", fx.paged, "swatch:Black", NP]);
    expect(all.code).toBe(0);
    expect(all.json.values).toMatchObject({ name: "Black", value: [0, 0, 0, 100] });
    const miss = await cli(["get", fx.paged, "page:#9", "index", NP]);
    expect(miss.code).toBe(1);
    expect(miss.json.result).toMatchObject({ kind: "refused", code: "unknownAddress" });
  });

  it("a selector sets every match in one write", async () => {
    const out = join(tmp.dir, "sel.paged");
    const set = await cli(["set", fx.paged, "swatch[name=Black]", "value", "[0,0,0,40]", "-o", out, NP]);
    expect(set.code).toBe(0);
    expect(set.json.targets).toEqual(["swatch:Color/Black"]);
    expect((await cli(["get", out, "swatch:Black", "value", NP])).json.value).toEqual([0, 0, 0, 40]);
  });
});

describe("query / schema", () => {
  it("query by name and by label", async () => {
    expect((await cli(["query", fx.paged, "swatch[name=Black]", NP])).json.addresses).toEqual(["swatch:Color/Black"]);
    const byLabel = await cli(["query", fx.paged, "frame[label.x-paged:media.paged.harness*=hero]", NP]);
    expect(byLabel.code).toBe(0);
    expect(byLabel.json.addresses).toEqual(["rectangle:urect"]);
    expect((await cli(["query", fx.paged, "frame[label.x-paged:media.paged.harness*=villain]", NP])).json.addresses).toEqual([]);
    expect((await cli(["query", fx.paged, "page:#1 > frame", NP])).json.addresses).toEqual(expect.arrayContaining(["rectangle:urect", fx.frame]));
  });

  it("schema lists kinds and a kind's typed rows", async () => {
    const kinds = await cli(["schema", fx.paged, NP]);
    expect(kinds.json.kinds.map((k: { kind: string }) => k.kind)).toEqual(expect.arrayContaining(["doc", "frame", "story", "swatch", "style"]));
    const story = await cli(["schema", fx.paged, "story", NP]);
    expect(story.json.rows.find((r: { path: string }) => r.path === "content")).toMatchObject({ type: { kind: "text" } });
    const text = await cli(["schema", fx.paged, "swatch", "--format", "text", NP]);
    expect(text.out).toMatch(/space\s+enum \(CMYK \| RGB \| LAB \| Gray\)/);
  });
});

describe("batch", () => {
  it("applies every op as ONE undo step (checked on the session) and saves", async () => {
    const ops = join(tmp.dir, "ops.json");
    writeFileSync(
      ops,
      JSON.stringify({
        label: "two writes",
        ops: [
          { op: "set", address: fx.story, path: "content", value: "Batched" },
          { op: "set", address: "swatch:Black", path: "value", value: [0, 0, 0, 70] },
        ],
      }),
    );
    // In-process with a kept session, so the undo history is observable.
    let s: CliSession | null = null;
    const verb = VERBS.find((v) => v.name === "batch")!;
    const args = parseArgs([fx.paged, ops, "--no-save"], [...verb.options, ...GLOBAL_OPTIONS]);
    const res = await verb.run({ args, cwd: tmp.dir, session: async (doc) => (s ??= await openSession(doc, { plugins: [] })) });
    expect(res.exit ?? 0).toBe(0);
    expect(res.json).toMatchObject({ ops: 2, result: { applied: true, undoSteps: 1 }, saved: null });
    const o = s!.h.objects;
    expect(await o.get(fx.story, "content")).toEqual({ kind: "value", value: "Batched" });
    await s!.driver.document.undo();
    expect(await o.get(fx.story, "content")).toEqual({ kind: "value", value: "Hello" });
    expect(await o.get("swatch:Black", "value")).toEqual({ kind: "value", value: [0, 0, 0, 100] });
    s!.dispose();

    const out = join(tmp.dir, "batched.paged");
    const viaCli = await cli(["batch", fx.paged, ops, "-o", out, NP]);
    expect(viaCli.code).toBe(0);
    expect((await cli(["get", out, "swatch:Black", "value", NP])).json.value).toEqual([0, 0, 0, 70]);
  });

  it("a refused op applies nothing and exits 1", async () => {
    const ops = join(tmp.dir, "bad-ops.json");
    writeFileSync(ops, JSON.stringify([
      { op: "set", address: fx.story, path: "content", value: "never" },
      { op: "set", address: "swatch:Black", path: "space", value: "Pantone" },
    ]));
    const r = await cli(["batch", fx.paged, ops, "--no-save", NP]);
    expect(r.code).toBe(1);
    expect(r.json.result).toMatchObject({ applied: false, code: "invalidValue", index: 1, undoSteps: 0 });
  });
});

describe("run", () => {
  it("a JS module drives `paged` (host.objects) and the write is saved", async () => {
    const script = join(tmp.dir, "script.mjs");
    writeFileSync(
      script,
      `export default async function (paged) {
        const [story] = await paged.query("story");
        await paged.set(story, "content", "From a script " + paged.args.join(","));
        paged.log("kinds", (await paged.kinds()).length);
        return paged.value(story, "content");
      }`,
    );
    const out = join(tmp.dir, "ran.paged");
    const r = await cli(["run", fx.paged, script, "-o", out, NP, "--", "a", "b"]);
    expect(r.code).toBe(0);
    expect(r.json.result).toBe("From a script a,b");
    expect(r.json.writes).toBe(1);
    expect(r.json.logs[0]).toMatch(/^kinds \d+/);
    expect((await cli(["get", out, "story", "content", NP])).json.results[0].value).toBe("From a script a,b");
  });

  it("a throwing script exits 1 with its message", async () => {
    const script = join(tmp.dir, "boom.mjs");
    writeFileSync(script, "export default async (paged) => { await paged.value('page:#9', 'index'); };");
    const r = await cli(["run", fx.paged, script, "--no-save", NP]);
    expect(r.code).toBe(1);
    expect(r.json.error.message).toMatch(/unknownAddress/);
  });
});

describe("get without a path (getAll)", () => {
  it("skips heavy rows and content unless --content", async () => {
    const lean = await cli(["get", fx.paged, fx.story, NP]);
    expect(lean.code).toBe(0);
    expect(lean.json.values).not.toHaveProperty("content");
    expect(Object.keys(lean.json.values).length).toBeGreaterThan(0);
    const full = await cli(["get", fx.paged, fx.story, "--content", NP]);
    expect(full.code).toBe(0);
    expect(full.json.values.content).toBe("Hello");
    expect(Object.keys(full.json.values)).toEqual(expect.arrayContaining(Object.keys(lean.json.values)));
  });
});

describe("export", () => {
  it("PDF: a complete PDF file", async () => {
    const out = join(tmp.dir, "out.pdf");
    const r = await cli(["export", fx.paged, "--format", "pdf", "-o", out, NP]);
    expect(r.code).toBe(0);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.subarray(-8).toString("latin1")).toMatch(/%%EOF\s*$/);
    expect(bytes.toString("latin1")).toMatch(/\/Type\s*\/Page\b/);
  });

  it("IDML: an IDML package that reopens with the same content", async () => {
    const out = join(tmp.dir, "out.idml");
    const r = await cli(["export", fx.paged, "-o", out, NP]);
    expect(r.code).toBe(0);
    expect(r.json.format).toBe("idml");
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(bytes.subarray(30, 38).toString("latin1")).toBe("mimetype");
    expect(bytes.toString("latin1")).toContain("application/vnd.adobe.indesign-idml-package");
    expect((await cli(["get", out, "story", "content", NP])).json.results[0].value).toBe("Hello");
  });

  it("an unknown format names the known ones (exit 2)", async () => {
    const r = await cli(["export", fx.paged, "--format", "psd", "-o", join(tmp.dir, "x.psd"), NP]);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/no exporter for "psd" — known: pdf, idml, paged/);
  });
});

describe("usage, help and exit codes", () => {
  it("help is generated from the verb table", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    for (const v of VERBS) expect(r.out).toContain(`  ${v.name} ${v.usage}`);
    const verb = await cli(["merge", "--help"]);
    expect(verb.out).toContain("--records-per-page <single|multiple>");
  });

  it("usage errors exit 2", async () => {
    expect((await cli(["frobnicate"])).code).toBe(2);
    expect((await cli(["get", fx.paged])).code).toBe(2);
    expect((await cli(["get", fx.paged, "doc", "--bogus"])).code).toBe(2);
    expect((await cli(["get", join(tmp.dir, "missing.paged"), "doc", NP])).code).toBe(2);
    expect((await cli(["get", join(tmp.dir, "x.txt"), "doc", NP])).code).toBe(2);
    expect((await cli(["query", fx.paged, "]]", NP])).code).toBe(2);
    const text = await cli(["get", fx.paged, "doc", "--format", "yaml", NP]);
    expect(text.code).toBe(2);
  });

  it("--text renders for humans and errors go to stderr", async () => {
    const r = await cli(["get", fx.paged, "swatch:Black", "value", "--text", NP]);
    expect(r.out).toBe("swatch:Black value = [0,0,0,100]");
    const e = await cli(["set", fx.paged, "swatch:Black", "space", "X", "--text", "--no-save", NP]);
    expect(e.code).toBe(1);
    expect(e.out).toBe("");
    expect(e.err).toMatch(/^paged: swatch:Black space/);
  });
});

describe("cli_surface — every host.objects member is reached by a verb", () => {
  it("mirrors core's cli_surface gate", async () => {
    const s = await openSession(null, { plugins: [] });
    try {
      const members = Object.keys(s.h.objects).filter((k) => typeof (s.h.objects as unknown as Record<string, unknown>)[k] === "function" && k !== "register");
      const reached = new Set(VERBS.flatMap((v) => v.reaches));
      expect(members.filter((m) => !reached.has(m))).toEqual([]);
      expect([...reached].filter((m) => !members.includes(m))).toEqual([]);
    } finally {
      s.dispose();
    }
  });
});
