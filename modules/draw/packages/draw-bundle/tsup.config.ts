import { defineConfig } from "tsup";
// The image-trace wasm artifact in ../wasm is left for the CONSUMING
// bundler (the editor's Vite): the `?url` asset import and the
// wasm-bindgen glue must not be bundled by esbuild. `dist/` is flat and
// sits at the same depth as `src/`, which is why src/trace-engine.ts's
// `../wasm/…` resolves from both.
export default defineConfig({
  entry: ["src/index.ts", "src/geometry.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [/^@paged-media\/draw-/],
  external: [/\?url$/, /wasm\//],
});
