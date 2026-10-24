// The query lane in a REAL browser: the shipped data-js wasm and the query
// store inside it (ADR 561), booted by the bundle's own bootEngine in headless
// Chromium, served with the editor's headers (cross-origin isolated, CSP
// connect-src 'self'). See test/browser-lane.ts for why this lane exists:
// code that passes every Node spec can still fail in the browser (the Wave 6
// guard did, and the store's clock would: std::time has no wasm32 clock).
//
// Opt-in like the other real lanes: skips without playwright-core or a
// Chromium; REQUIRE_REAL_BROWSER=1 makes that a failure.
import { afterAll, describe, expect, it } from "bun:test";
import { REQUIRE_REAL_ENGINE } from "./real-engine";
import {
  REQUIRE_REAL_BROWSER,
  startBrowserLane,
  type BrowserLane,
} from "./browser-lane";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED, FIXTURE_CSV, REFUSED } from "./guard-matrix";

const SOURCES = join(__dirname, "..", "..", "..", "conformance", "sources");
const PARQUET = readFileSync(join(SOURCES, "products.parquet"));
const XLSX = readFileSync(join(SOURCES, "products.xlsx"));

const REQUIRED = REQUIRE_REAL_BROWSER || REQUIRE_REAL_ENGINE;
const LANE_OFF = !REQUIRED && process.env.PAGED_BROWSER_LANE === "0";

// The lane starts while the file loads, not in a beforeAll: bun:test has no
// runtime skip (vitest's `ctx.skip()`), so the tests that need the lane are
// skipped up front when it did not start, exactly where they used to skip.
const started = LANE_OFF
  ? { lane: undefined, error: "PAGED_BROWSER_LANE=0" }
  : await startBrowserLane();
const lane: BrowserLane | undefined = started.lane;
const why = started.error ?? "";
const NO_LANE = !lane && !REQUIRED;
// Closing Chromium can outlast the 5 s default hook timeout on a loaded machine.
afterAll(async () => {
  await lane?.close();
}, 30_000);

const TRAPS = /unreachable|RuntimeError|out of bounds|panicked|Content Security Policy/;

/** Requests outside the page's origin, the module host's (the door test's,
 *  which the editor's connect-src lists) left out: the lane must make none. */
const stray = () =>
  lane!.offOrigin.filter((u) => !u.startsWith(lane!.moduleOrigin));

// The module door (plugin-sdk ADR 326) in the real browser, FIRST: the glue
// is initialised once per realm, so the page's first boot is the one that can
// take the engine from a CROSS-ORIGIN module host (brotli, CORS *, as
// modules.paged.media serves it).
describe.skipIf(LANE_OFF)(
  "the engine loads through the host's module door [data.query.seam]",
  () => {
    const DATA_WASM = join(__dirname, "..", "bin", "data_js_bg.wasm");
    const sri = (bytes: Buffer) =>
      "sha384-" + createHash("sha384").update(bytes).digest("base64");

    it.skipIf(NO_LANE)(
      "the data engine loads from the module host with its integrity; a wrong digest is refused by the fetch",
      async () => {
        const good = sri(readFileSync(DATA_WASM));
        const bad = sri(Buffer.from("not the engine"));
        const out = await lane!.page.evaluate(
          async ({
            origin,
            good,
            bad,
          }: {
            origin: string;
            good: string;
            bad: string;
          }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const L = (window as any).lane;
            const url = `${origin}/@paged-media/data/0.0.0-test/bin/data_js_bg.wasm`;
            const fallbacks: string[] = [];
            const e = await L.bootEngine(Date.UTC(2026, 9, 11) / 86400000, {
              resolveWasm: async (name: string) =>
                name === "data-engine" ? { url, integrity: good } : null,
              onFallback: (r: string) => fallbacks.push(r),
            });
            const okType = typeof e.payload;
            // The glue is initialised once per realm, so a second boot cannot
            // show the fallback; prove that the browser refuses a wrong digest
            // for the same response (bootEngine then loads bin/ — the unit
            // test in src/__tests__/wasm-door.test.ts drives that branch).
            let refused = false;
            try {
              await fetch(url, { integrity: bad });
            } catch {
              refused = true;
            }
            return { okType, fallbacks, refused };
          },
          { origin: lane!.moduleOrigin, good, bad },
        );
        expect(out.fallbacks).toEqual([]);
        expect(out.okType).toBe("function");
        expect(out.refused).toBe(true);
        expect(lane!.moduleServed).toContain(
          "/@paged-media/data/0.0.0-test/bin/data_js_bg.wasm",
        );
      },
      60_000,
    );
  },
);

/** Boot the engine in the page (once), open its store, import the fixture
 *  tables, run `body` there with `L` (the lane), `d` (the store) and `e` (the
 *  engine). */
async function inPage<T>(body: string, arg?: unknown): Promise<T> {
  if (!lane) throw new Error(`the browser lane did not start: ${why}`);
  return lane.page.evaluate(
    async ({
      body,
      arg,
      csv,
    }: {
      body: string;
      arg: unknown;
      csv: Record<string, string>;
    }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const L = (window as any).lane;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (!w.store) {
        w.engine = await L.bootEngine(Date.UTC(2026, 9, 24) / 86400000);
        w.store = L.storeHandle(w.engine);
        for (const [name, text] of Object.entries(csv))
          await L.loadIntoStore(
            w.store,
            name,
            "csv",
            new TextEncoder().encode(text),
          );
      }
      // eslint-disable-next-line no-new-func
      return new Function(
        "L",
        "d",
        "e",
        "arg",
        `return (async () => { ${body} })();`,
      )(L, w.store, w.engine, arg);
    },
    { body, arg, csv: FIXTURE_CSV },
  );
}

describe.skipIf(LANE_OFF)(
  "the query store in the browser [data.security.gates] [data.store.turso]",
  () => {
    it.skipIf(NO_LANE)(
      "the lane starts (fails under REQUIRE_REAL_BROWSER / REQUIRE_REAL_ENGINE when it cannot)",
      () => {
        expect(lane, why).toBeDefined();
      },
    );

    it.skipIf(NO_LANE)(
      "the guard admits a SELECT over a source table, and the store runs it [data.query.seam]",
      async () => {
        const out = await inPage<{ verdict: unknown; rows: unknown }>(
          `const verdict = await L.guard("SELECT name FROM people ORDER BY name");
         const rows = (await d.preview("SELECT name FROM people ORDER BY name", 10)).rows;
         return { verdict, rows };`,
        );
        expect(out.verdict).toBeNull();
        expect(out.rows).toEqual([["Ada"], ["Grace"]]);
        expect(lane!.errors.filter((e) => TRAPS.test(e))).toEqual([]);
        expect(stray()).toEqual([]);
      },
    );

    it.skipIf(NO_LANE)(
      "refuses every reach outside the source tables [data.security.gates]",
      async () => {
        const verdicts = await inPage<
          (null | { kind: string; message: string })[]
        >(
          `const out = [];
         for (const sql of arg) out.push(await L.guard(sql));
         return out;`,
          REFUSED.map(([sql]) => sql),
        );
        REFUSED.forEach(([sql, msg], i) => {
          expect(verdicts[i]?.kind, sql).toBe("Guard");
          expect(verdicts[i]?.message, sql).toMatch(msg);
        });
        expect(stray()).toEqual([]);
      },
    );

    it.skipIf(NO_LANE)(
      "admits ordinary queries — joins, CTEs, aggregates — and the store runs them [data.query.seam]",
      async () => {
        const out = await inPage<
          { verdict: unknown; rows: unknown; error?: string }[]
        >(
          `const out = [];
         for (const sql of arg) {
           const verdict = await L.guard(sql);
           try { out.push({ verdict, rows: (await d.preview(sql, 100)).rows }); }
           catch (e) { out.push({ verdict, rows: null, error: String(e && e.message || e) }); }
         }
         return out;`,
          ALLOWED.map(([sql]) => sql),
        );
        ALLOWED.forEach(([sql, rows], i) => {
          expect(out[i].verdict, sql).toBeNull();
          expect(out[i].error, sql).toBeUndefined();
          expect(out[i].rows, sql).toEqual(rows);
        });
      },
    );

    it.skipIf(NO_LANE)(
      "the query connection refuses writes, and imports still work after it [data.security.gates]",
      async () => {
        const out = await inPage<{ refused: string[]; late: unknown }>(
          `const refused = [];
         for (const sql of ["INSERT INTO people VALUES ('Eve', 'Spy')", "DELETE FROM orders",
                            "DROP TABLE people", "CREATE TABLE x (a)"]) {
           try { await d.preview(sql, 1); refused.push("ran: " + sql); }
           catch (err) { refused.push(err.kind || "Error"); }
         }
         await L.loadIntoStore(d, "late", "csv", new TextEncoder().encode("a,b\\n1,2\\n"));
         return { refused, late: (await d.preview("SELECT * FROM late", 10)).rows };`,
        );
        for (const r of out.refused) expect(r).not.toMatch(/^ran: /);
        expect(out.late).toEqual([["1", "2"]]);
      },
    );

    it.skipIf(NO_LANE)(
      "JSON imports — an array of objects and newline-delimited records — read in the engine [data.source.adapters]",
      async () => {
        const out = await inPage<{ arr?: unknown; nd?: unknown; error?: string }>(
          `try {
           const enc = new TextEncoder();
           await L.loadIntoStore(d, "catalog", "json",
             enc.encode('[{"sku":"A-1","price":9.99,"tags":"x"},{"sku":"B-2","price":19.5,"tags":null}]'));
           await L.loadIntoStore(d, "events", "json",
             enc.encode('{"id":1,"at":"2026-01-15"}\\n{"id":2,"at":"2026-02-01"}\\n'));
           return {
             arr: (await d.preview("SELECT sku, price, tags FROM catalog ORDER BY sku", 10)).rows,
             nd: (await d.describe("SELECT id, at FROM events")).map((c) => c.type),
           };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
        );
        expect(out.error).toBeUndefined();
        expect(out.arr).toEqual([
          ["A-1", "9.99", "x"],
          ["B-2", "19.5", null],
        ]);
        expect(out.nd).toEqual(["INTEGER", "DATE"]);
        expect(stray()).toEqual([]);
        expect(lane!.errors.filter((e) => TRAPS.test(e))).toEqual([]);
      },
    );

    it.skipIf(NO_LANE)(
      "a Parquet import: DECIMAL keeps its scale, DATE stays a date [data.source.adapters]",
      async () => {
        const out = await inPage<{
          types?: unknown;
          rows?: unknown;
          error?: string;
        }>(
          `try {
           await L.loadIntoStore(d, "products", "parquet", new Uint8Array(arg));
           return {
             types: (await d.describe("SELECT * FROM products")).map((c) => [c.name, c.type]),
             rows: (await d.preview("SELECT * FROM products ORDER BY sku", 10)).rows,
           };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
          [...PARQUET],
        );
        expect(out.error).toBeUndefined();
        expect(out.types).toEqual([
          ["sku", "TEXT"],
          ["price", "DECIMAL(18,2)"],
          ["qty", "INTEGER"],
          ["launched", "DATE"],
        ]);
        expect(out.rows).toEqual([
          ["A-1", "9.99", "3", "2026-01-15"],
          ["B-2", "19.50", "10", "2026-02-01"],
          ["C-3", "7.00", null, null],
        ]);
        expect(stray()).toEqual([]);
        expect(lane!.errors.filter((e) => TRAPS.test(e))).toEqual([]);
      },
    );

    it.skipIf(NO_LANE)(
      "an XLSX import reads its first worksheet in the engine [data.source.adapters]",
      async () => {
        const out = await inPage<{
          rows?: unknown;
          sheet?: unknown;
          error?: string;
        }>(
          `try {
           const r = await L.loadIntoStore(d, "xl", "xlsx", new Uint8Array(arg));
           return {
             sheet: r.sheet,
             rows: (await d.preview("SELECT sku, price, qty, launched, active FROM xl ORDER BY sku", 10)).rows,
           };
         } catch (e) { return { error: String(e && e.message || e) }; }`,
          [...XLSX],
        );
        expect(out.error).toBeUndefined();
        expect(out.sheet).toBe("Products");
        expect(out.rows).toEqual([
          ["A-1", "9.99", "3", "2026-01-15", "true"],
          ["B-2", "19.5", "10", "2026-02-01", "false"],
          ["C-3", "7", null, null, "true"],
          ["D-4", null, "5", "2026-04-01", null],
        ]);
        expect(stray()).toEqual([]);
      },
    );

    it.skipIf(NO_LANE)(
      "a query's rows reach the binding session in the page, and the store's clock is the page's [data.store.turso]",
      async () => {
        const out = await inPage<{ rows: number; count: number }>(
          `e.define_query({ id: "q", sql: "SELECT * FROM orders", params: [], shape: { shape: "recordStream" } });
           const rows = await d.ingest("q", "SELECT * FROM orders");
           return { rows, count: e.query_record_count("q") };`,
        );
        expect(out).toEqual({ rows: 3, count: 3 });
        expect(lane!.errors.filter((e) => TRAPS.test(e))).toEqual([]);
      },
    );

    it.skipIf(NO_LANE)(
      "the whole lane made no request outside its origin [data.security.gates]",
      () => {
        expect(stray()).toEqual([]);
      },
    );
  },
);
