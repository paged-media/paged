import type { BundleHost, HostedModule } from "@paged-media/plugin-api";

// The bundle's wasm, and where it comes from: the host's copy through the
// module door (`hostWasm`), else the bundle's own `bin/`.
//
// The bundle's own `bin/` directory, resolved against THIS module's URL — the
// same mechanism engine.ts uses for `../bin/data_js.js`. It holds for the
// layout the bundle runs from, the source tree (`src/bin-url.ts` → `bin/`),
// which the editor builds. A host serves `bin/` next to the code that imports
// it; see the editor's DuckDB route for the dev server and the build-output
// copy.
//
// The path is kept out of a `new URL("<literal>", import.meta.url)` expression
// on purpose: Vite rewrites that literal form into a hashed asset at build time,
// which would move the file away from the siblings the DuckDB worker expects.
const BIN_DIR = "../bin/";

/** The absolute URL of a file in the bundle's `bin/`. */
export function binUrl(file: string): string {
  return new URL(BIN_DIR + file, import.meta.url).href;
}

/** Resolves a declared `capabilities.wasm` artifact name to the host's copy,
 *  or null (the bundle then loads its own). */
export type WasmResolver = (name: string) => Promise<Pick<HostedModule, "url" | "integrity"> | null>;

/** The manifest's artifact names this bundle resolves through the module door. */
export const WASM_ARTIFACTS = {
  engine: "data-engine",
  duckdb: "duckdb-engine",
} as const;

/** The module door (plugin-sdk ADR 326) as a resolver: the host's URL and
 *  Subresource Integrity for a declared artifact. `null` without a module
 *  backend (`modules@1` false), and the door is then not called. */
export function hostWasm(host: BundleHost): WasmResolver {
  return (name) => (host.supports("modules@1") ? host.modules.resolve(name) : Promise.resolve(null));
}
