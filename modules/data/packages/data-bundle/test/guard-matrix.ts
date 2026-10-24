// The query guard's security matrix, shared by the Node lane
// (test/query-guard.spec.ts), the real-browser lane
// (test/store-browser.spec.ts) and the unit lane (src/__tests__/query-lane),
// so they prove the same property. The cases live in
// conformance/query-guard/cases.json, which the engine's guard
// (paged-data-store/src/guard.rs) replays too.
//
// Fixture tables: `people(name, role)` (2 rows) and `orders(name, qty)`
// (3 rows), both imported as sources.
import cases from "../../../conformance/query-guard/cases.json";

export const FIXTURE_CSV: { people: string; orders: string } =
  cases.fixtureCsv;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every reach outside the imported tables: each must be refused. */
export const REFUSED: [sql: string, why: RegExp][] = cases.refused.map(
  ({ sql, why }) => [sql, new RegExp(escape(why))],
);

/** Ordinary queries over the source tables: each must be admitted AND run.
 *  `rows` is the expected result (cells as text). */
export const ALLOWED: [sql: string, rows: (string | null)[][]][] =
  cases.allowed.map(({ sql, rows }) => [sql, rows]);
