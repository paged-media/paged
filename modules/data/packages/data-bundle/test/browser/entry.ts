// The browser lane's page entry: the bundle's REAL engine boot (bootEngine,
// the shipped data-js wasm from bin/ or the module host) with its query
// store, the query guard and the importer, exposed on `window.lane` for
// test/store-browser.spec.ts to drive through Playwright. Bundled by
// test/browser-lane.ts with esbuild and served at /lane/entry.js, so
// `binUrl()` (../bin/) resolves to the served bin/.
import { bootEngine } from "../../src/engine";
import { loadIntoStore } from "../../src/query/import";
import { guardQuery } from "../../src/query/sql";
import { storeHandle } from "../../src/query/store";

(window as unknown as { lane: unknown }).lane = {
  bootEngine,
  guard: (sql: string) => guardQuery(sql),
  loadIntoStore,
  storeHandle,
};
