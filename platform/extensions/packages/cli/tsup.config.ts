import { defineConfig } from "tsup";

// The CLI ships as ONE self-contained ESM build: the plugin-sdk host
// (createHeadlessHost, the object registry) is bundled in, so the bin runs on
// plain Node with no TypeScript workspace sources; the engine
// (@paged-media/canvas-wasm), DuckDB's Node build and every plugin bundle stay
// external and are resolved at run time.
export default defineConfig({
  entry: { bin: "src/bin.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: true,
  dts: { entry: { index: "src/index.ts" }, resolve: [/@paged-media\/plugin-(api|sdk)/] },
  noExternal: [/^@paged-media\/plugin-(api|sdk)$/],
  external: ["@paged-media/canvas-wasm", "@duckdb/duckdb-wasm", "react", "react-dom"],
});
