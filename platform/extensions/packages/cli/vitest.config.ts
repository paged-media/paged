import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The suites boot the real engine (and DuckDB) in-process; one file at a
    // time keeps the wasm heaps bounded.
    fileParallelism: false,
    server: {
      deps: {
        // @paged-media/data peers on @paged-media/plugin-sdk, which in this
        // workspace is TypeScript source: let Vite transform the bundle so
        // that import resolves (an npm install gets the built SDK instead).
        inline: [/@paged-media\/data/],
      },
    },
  },
});
