import { defineConfig } from "tsup";

// Keep `?url` wasm imports external (a bundler affordance the consuming app
// resolves); the wasm-bindgen glue under bin/ ships beside dist/.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: [/\?url$/, /\.\.\/bin\//, "react", "react/jsx-runtime"],
});
