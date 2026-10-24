// The InDesign Data Merge oracle over the SHIPPED query path
// (docs/design/oracles.md). data-conformance/tests/it/oracle.rs replays the
// recordings with every CSV field ingested as TEXT, the way Data Merge reads
// it. Here the same CSVs go the way a user's file goes: into the engine's
// query store (types inferred and all, ADR 561) → the store's rows into the
// binding session → the data-js record flow; and each merged record's text is
// compared with what InDesign wrote into its frame. Placement is oracle.rs's
// job; this lane is text only.
//
// GATE: skips without the data-js wasm, fails under REQUIRE_REAL_ENGINE=1
// (store-real.spec.ts carries the gate).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { loadIntoStore } from "../src/query/import";
import { storeHandle } from "../src/query/store";
import { bootEngine } from "./pipeline-parts.mjs";
import { HAVE_ENGINE } from "./real-engine";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANE = join(PKG, "..", "..", "conformance", "indesign-merge");
const spec = JSON.parse(readFileSync(join(LANE, "fixtures.json"), "utf8"));

/** Where the shipped path's text differs from InDesign's, per fixture: the
 *  number of records whose text agrees, pinned. A moved count fails; the
 *  commit that moves it updates the pin. */
const PINS: Record<string, { agree: number; why?: string }> = {
  // A typed price keeps its written scale (DECIMAL, `1234.50`) and a code
  // keeps its leading zeros: DM-8 is closed on the typed path too (ADR 561;
  // DuckDB's sniffer agreed on 81 of 90).
  "single-record": { agree: 3 },
  "multi-record-column": { agree: 12 },
  "multi-record-grid": { agree: 7 },
  "long-record-set": { agree: 57 },
  "empty-field-lines": {
    agree: 2,
    why: "DEFECT DM-5 the empty field's line is kept (the record flow's; the merge writer removes it)",
  },
  overset: { agree: 2 },
  "number-text": { agree: 3 },
  "image-field": { agree: 3 },
};

function normalise(s: string): string {
  return s.replace(/\r/g, "\n").replace(/\uFEFF/g, "");
}

function indesignTexts(id: string): Array<{ text: string; overset: boolean }> {
  const rec = JSON.parse(
    readFileSync(join(LANE, "recorded", `${id}.json`), "utf8"),
  );
  return rec.merged.pages.flatMap((p: any) =>
    p.text_frames.map((t: any) => ({
      text: normalise(t.text),
      overset: t.overset,
    })),
  );
}

describe.skipIf(!HAVE_ENGINE)(
  "InDesign Data Merge texts over the shipped store path [data.lower.content]",
  () => {
    for (const fx of spec.fixtures as any[]) {
      const pin = PINS[fx.id];
      it(`${fx.id}: ${pin.agree} record texts agree with InDesign${pin.why ? ` (${pin.why})` : ""}`, async () => {
        await agreeing(fx, pin.agree, "typed");
      });
    }
  },
);

/** What a Data Merge reads (session.ts `asWritten`): the CSV fields as the
 *  file has them. It agrees with InDesign as often as the typed read does
 *  now; DM-5 (Remove Blank Lines) is the record flow's, which the merge
 *  writer closes on its own lane. */
const AS_WRITTEN_PINS = PINS;

describe.skipIf(!HAVE_ENGINE)(
  "InDesign Data Merge texts over the merge's as-written read (DM-8 closed) [data.lower.content]",
  () => {
    for (const fx of spec.fixtures as any[]) {
      const pin = AS_WRITTEN_PINS[fx.id]!;
      it(`${fx.id}: ${pin.agree} record texts agree with InDesign${pin.why ? ` (${pin.why})` : ""}`, async () => {
        await agreeing(fx, pin.agree, "asWritten");
      });
    }
  },
);

async function agreeing(
  fx: any,
  expected: number,
  read: "typed" | "asWritten",
): Promise<void> {
  const table = `dm_${fx.id.replace(/-/g, "_")}`;
  const sql = `SELECT * FROM ${table}`;

  const text = fx.frames.find((f: any) => f.kind === "text");
  const fields = text.lines.map((line: string) => {
    const at = line.indexOf("<<");
    return { label: line.slice(0, at), expr: line.slice(at + 2, -2) };
  });
  const engine = await bootEngine();
  const store = storeHandle(engine)!;
  await loadIntoStore(
    store,
    table,
    "csv",
    readFileSync(join(LANE, "csv", `${fx.id}.csv`)),
  );
  engine.define_source({
    id: "s",
    kind: { kind: "inlineSeed", table },
    capability: "inline",
  });
  engine.define_query({
    id: "q",
    sql: `SELECT * FROM ${table}`,
    params: [],
    shape: { shape: "recordStream" },
  });
  engine.define_template({
    id: "t",
    fields,
    lineHeightPt: spec.text.leading,
  });
  engine.define_binding({
    id: "rf",
    kind: "recordFlow",
    chain: "c",
    query: "q",
    template: "t",
    options: {},
  });
  const rows =
    read === "asWritten"
      ? await store.ingestAsWritten("q", sql, [table])
      : await store.ingest("q", sql);
  if (rows === null) throw new Error(`${table}: no as-written twin`);
  const chain = Array.from({ length: rows }, (_, i) => ({
    frame: `f${i}`,
    page: `p${i}`,
    heightPt: 1e6,
  }));
  const flow = engine.lower_record_flow("rf", chain, undefined);
  const ours: string[] = flow.frames.flatMap((f: any) =>
    f.blocks
      .filter((b: any) => b.block === "record")
      .map((b: any) => b.cells.join("\n")),
  );
  expect(ours.length).toBe(rows);

  const theirs = indesignTexts(fx.id);
  const used = new Set<number>();
  let agree = 0;
  const disagree: string[] = [];
  for (const t of theirs) {
    const i = ours.findIndex(
      (o, j) =>
        !used.has(j) &&
        (t.overset ? o.startsWith(t.text.trimEnd()) : o === t.text),
    );
    if (i >= 0) {
      used.add(i);
      agree++;
    } else disagree.push(JSON.stringify(t.text));
  }
  if (agree !== expected) console.log(fx.id, read, { ours, disagree });
  expect(
    agree,
    `${fx.id}: InDesign texts with no match: ${disagree.join(", ")}`,
  ).toBe(expected);
}
