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

// CROSS-SURFACE PARITY (test layer 5). Every case of `cases.ts` is applied
// to the parity fixture through the wire (the reference), then through
// every door of every surface that reaches its operation, each from the
// same precondition; the model dumps must be identical. A door that
// disagrees is a FINDING, on record in `findings.ts` as an expected
// failure. A surface with no door to an operation is a gap of the matrix
// (`matrix.test.ts`), not a failure here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { covers } from "@paged-media/test-kit";
import { canonicalJson, dumpDiff } from "@paged-media/test-kit/headless";

import { PARITY_CASES, caseName, type ParityCase } from "./cases";
import {
  CLI_DOORS,
  IN_PROCESS_DOORS,
  run as runCli,
  unavailable,
  type CliDoor,
  type Door,
} from "./doors";
import { parityFixture } from "./fixture";
import {
  buildMatrix,
  renderCovers,
  renderMarkdown,
  withoutCli,
  type Matrix,
} from "./matrix";
import {
  READ_CASES,
  READ_DOORS,
  cliValue,
  readCaseName,
  readValue,
  type ReadCase,
} from "./reads";
import { KNOWN_FINDINGS } from "./findings";
import {
  compare,
  compareValues,
  DUMP_OPTIONS,
  ensureLive,
  ROOT,
  parity,
  precondition,
  record,
  type CaseState,
} from "./suite";
import { coversDoor, coversRead } from "./script-door.covers.generated";

const s = await parity();
afterAll(() => {
  if (s.traps.length > 0)
    console.log(`engine traps: ${JSON.stringify(s.traps, null, 1)}`);
});

async function reference(c: ParityCase): Promise<CaseState> {
  await ensureLive(s, caseName(c));
  s.lastCase = caseName(c);
  const { ed } = s;
  await precondition(ed, c);
  const pre = await ed.dump(DUMP_OPTIONS);
  const args = typeof c.args === "function" ? c.args(pre) : c.args;
  const saved = s.bin ? await ed.client.exportPaged() : new Uint8Array();
  const reply = await ed.client.mutate({ op: c.op, args } as never);
  await ed.idle();
  if (reply.kind !== "mutationApplied") {
    throw new Error(
      `the reference (wire) refused ${caseName(c)}: ${JSON.stringify(reply.payload).slice(0, 400)}`,
    );
  }
  const ref = await ed.dump(DUMP_OPTIONS);
  let refReloaded = null;
  if (s.bin) {
    await ed.load(await ed.client.exportPaged());
    refReloaded = await ed.dump(DUMP_OPTIONS);
  }
  return {
    pre,
    args,
    ref,
    saved,
    refReloaded,
    changed: compare(pre, ref).length > 0,
  };
}

function stateOf(name: string): CaseState {
  const st = s.cases.get(name);
  if (!st) throw new Error(`${name}: the reference never ran`);
  if ("error" in st) throw new Error(`${name}: ${st.error}`);
  return st;
}

async function runDoor(c: ParityCase, door: Door) {
  const name = caseName(c);
  const st = stateOf(name);
  await ensureLive(s, name);
  s.lastCase = `${name} ${door.id}`;
  await precondition(s.ed, c);
  try {
    await door.run(s.ctx, c, st.args);
    await s.ed.idle();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    record(s, name, { status: "refused", door: door.id, detail });
    throw err;
  }
  const got = await s.ed.dump(DUMP_OPTIONS);
  const diff = compare(st.ref, got);
  record(
    s,
    name,
    diff.length === 0
      ? { status: "parity", door: door.id }
      : { status: "differs", door: door.id, detail: diff },
  );
  return diff;
}

async function runCliDoor(c: ParityCase, door: CliDoor) {
  const name = caseName(c);
  const st = stateOf(name);
  await ensureLive(s, name);
  s.lastCase = `${name} ${door.id}`;
  let out: Uint8Array;
  try {
    out = await door.run(s.bin!, c, st.args, st.saved);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    record(s, name, { status: "refused", door: door.id, detail });
    throw err;
  }
  await s.ed.load(out);
  const got = await s.ed.dump(DUMP_OPTIONS);
  const diff = compare(st.refReloaded!, got);
  record(
    s,
    name,
    diff.length === 0
      ? { status: "parity", door: door.id }
      : { status: "differs", door: door.id, detail: diff },
  );
  return diff;
}

for (const c of PARITY_CASES) {
  const name = caseName(c);
  describe(name, () => {
    test("reference: the wire applies it", async () => {
      try {
        s.cases.set(name, await reference(c));
      } catch (err) {
        s.cases.set(name, { error: String(err) });
        throw err;
      }
    });
    for (const door of IN_PROCESS_DOORS) {
      if (!door.reaches(s.ctx, c)) continue;
      const finding = KNOWN_FINDINGS[`${name} ${door.id}`];
      const label = finding
        ? `${door.id} (finding ${finding.id}: ${finding.actual})`
        : door.id;
      (finding ? test.failing : test)(label, async () => {
        coversDoor(door.id, c.op, c.command?.id);
        expect(await runDoor(c, door)).toEqual([]);
      });
    }
    for (const door of CLI_DOORS) {
      if (!s.bin) continue;
      if (!door.reaches(s.ctx, c)) continue;
      const finding = KNOWN_FINDINGS[`${name} ${door.id}`];
      const label = finding
        ? `${door.id} (finding ${finding.id}: ${finding.actual})`
        : door.id;
      (finding ? test.failing : test)(label, async () => {
        coversDoor(door.id, c.op, undefined);
        expect(await runCliDoor(c, door)).toEqual([]);
      });
    }
  });
}

if (!s.bin) {
  test("cli doors", () => {
    unavailable(
      "paged-cli",
      "no paged binary (PAGED_CLI_BIN, or `cargo build -p paged-cli` in engine/core); the CLI column is not measured",
    );
  });
}

// The comparison itself: two different edits dump differently, so an
// identical dump is evidence, not an artefact of what the dump leaves out.
describe("the comparison", () => {
  test("two different edits of the fixture dump differently", async () => {
    const edit = async (text: string) => {
      await s.ed.load(parityFixture());
      await s.ed.client.mutate({
        op: "insertText",
        args: { storyId: "ust1", offset: 0, text },
      } as never);
      return s.ed.dump(DUMP_OPTIONS);
    };
    expect(compare(await edit("a"), await edit("b")).length).toBeGreaterThan(0);
  });
});

// Addresses: what the object query lists, the object model can read. The
// query is how every typed surface finds objects (host.objects.query,
// paged.query, editor.query, `paged query`), and `get` how it reads them.
describe("addresses", () => {
  const listed = async () => {
    await s.ed.load(parityFixture());
    const r = await s.ed.send({
      kind: "requestQuery",
      payload: { selector: "frame" },
    } as never);
    return (r.payload as { addresses: string[] }).addresses;
  };
  const readable = async (address: string) => {
    const r = await s.ed.send({
      kind: "requestGet",
      payload: { address, path: "frameBounds" },
    } as never);
    return (r.payload as { code?: string | null }).code ?? null;
  };
  test("every page item the query lists, get reads", async () => {
    covers("script:paged.query", "script:paged.get");
    const items = (await listed()).filter(
      (a) => !a.includes(" > ") && !a.startsWith("oval:"),
    );
    expect(items.length).toBeGreaterThan(10);
    for (const a of items)
      expect(`${a}: ${await readable(a)}`).toBe(`${a}: null`);
  });
  test.failing(
    "PAR-5: an oval's frameBounds reads (get answers noSuchPath, inspect has no frameBounds entry)",
    async () => {
      covers("script:paged.get", "script:paged.inspect");
      const ovals = (await listed()).filter((a) => a.startsWith("oval:"));
      expect(ovals).toEqual(["oval:ugB"]);
      expect(`oval:ugB: ${await readable("oval:ugB")}`).toBe("oval:ugB: null");
    },
  );
  test.failing(
    "PAR-4: a master's item the query lists, get reads (it answers notFound)",
    async () => {
      covers("script:paged.query", "script:paged.get");
      const items = (await listed()).filter((a) => a.includes(" > "));
      expect(items).toEqual(["master:um > rectangle:umast"]);
      for (const a of items)
        expect(`${a}: ${await readable(a)}`).toBe(`${a}: null`);
    },
  );
});

// ------------------------------------------------------------------ reads

const fixtureFile = (() => {
  if (!s.bin) return null;
  const dir = mkdtempSync(join(tmpdir(), "paged-parity-reads-"));
  const path = join(dir, "fixture.idml");
  writeFileSync(path, parityFixture());
  return { dir, path };
})();
afterAll(() => {
  if (fixtureFile) rmSync(fixtureFile.dir, { recursive: true, force: true });
});

const readRefs = new Map<string, unknown>();

async function readReference(r: ReadCase): Promise<unknown> {
  const name = readCaseName(r);
  if (readRefs.has(name)) return readRefs.get(name);
  await ensureLive(s, name);
  await s.ed.load(parityFixture());
  let ref = readValue(await r.wire((m) => s.ed.send(m as never)));
  // No wire read (the schema comes from the catalog): the plugin API's
  // answer is the reference the other surfaces are held to.
  if (ref === null && r.plugin) ref = readValue(await r.plugin(s.host));
  readRefs.set(name, ref);
  return ref;
}

async function readThrough(
  r: ReadCase,
  door: (typeof READ_DOORS)[number]["id"],
): Promise<unknown> {
  await s.ed.load(parityFixture());
  switch (door) {
    case "boa": {
      const out = await s.ed.script(`console.log(JSON.stringify(${r.boa!}))`);
      if (out.error) throw new Error(`script error: ${out.error}`);
      return readValue((out.output[0] ?? "").replace(/^\[log\] /, ""));
    }
    case "plugin":
      return readValue(await r.plugin!(s.host));
    case "automation":
      return readValue(await r.automation!(s.ed));
    case "cli": {
      const args = r.cli!.map((a) => (a === "{doc}" ? fixtureFile!.path : a));
      const res = runCli(s.bin!, args);
      if (!res.ok)
        throw new Error(`refused: paged ${args[0]}: ${res.out.slice(0, 300)}`);
      return readValue(cliValue(res.out));
    }
  }
}

describe("reads", () => {
  for (const r of READ_CASES) {
    const name = readCaseName(r);
    for (const door of READ_DOORS) {
      const has =
        door.id === "boa"
          ? !!r.boa
          : door.id === "plugin"
            ? !!r.plugin
            : door.id === "automation"
              ? !!r.automation
              : !!r.cli && !!s.bin;
      if (!has) continue;
      const finding = KNOWN_FINDINGS[`read:${name} ${door.id}`];
      const label = finding
        ? `${name} ${door.id} (finding ${finding.id}: ${finding.actual})`
        : `${name} ${door.id}`;
      (finding ? test.failing : test)(label, async () => {
        coversRead(door.id, r.fn);
        const ref = await readReference(r);
        let got: unknown;
        try {
          got = await readThrough(r, door.id);
        } catch (err) {
          record(s, `read:${name}`, {
            status: "refused",
            door: door.id,
            detail: String(err),
          });
          throw err;
        }
        const diff = compareValues(ref, got);
        record(
          s,
          `read:${name}`,
          diff.length === 0
            ? { status: "parity", door: door.id }
            : { status: "differs", door: door.id, detail: diff },
        );
        expect(diff).toEqual([]);
      });
    }
  }
});

// ----------------------------------------------------------------- matrix

const MATRIX_JSON = join(ROOT, "docs/development/surface-parity-matrix.json");
const MATRIX_MD = join(ROOT, "docs/development/surface-parity-matrix.md");
const COVERS_FILE = new URL(
  "./script-door.covers.generated.ts",
  import.meta.url,
).pathname;

describe("matrix", () => {
  test("the committed matrix is what this run measured", () => {
    const ran = PARITY_CASES.every((c) => s.cases.has(caseName(c)));
    if (!ran) {
      unavailable(
        "full parity run",
        "a filtered run measures part of the matrix; the check needs every case",
      );
      return;
    }
    const m = buildMatrix(s);
    if (process.env["PARITY_WRITE"] === "1") {
      writeFileSync(MATRIX_JSON, `${canonicalJson(m, 2)}\n`);
      writeFileSync(MATRIX_MD, renderMarkdown(m));
      writeFileSync(COVERS_FILE, renderCovers(s));
      return;
    }
    const committed = JSON.parse(readFileSync(MATRIX_JSON, "utf8")) as Matrix;
    const [want, got] = s.bin
      ? [committed, m]
      : [withoutCli(committed), withoutCli(m)];
    expect(dumpDiff(want, got, 20)).toEqual([]);
  });
});
