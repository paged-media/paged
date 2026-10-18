import { defineConfig } from "tsup";
// The image-trace wasm artifact in ../wasm is left for the CONSUMING
// bundler (the editor's Vite): the `?url` asset import and the
// wasm-bindgen glue must not be bundled by esbuild. `dist/` is flat and
// sits at the same depth as `src/`, which is why src/trace-engine.ts's
// `../wasm/…` resolves from both.
//
// `src/trace-worker.ts` is an entry of its own: it is the module
// `host.workers` spawns (package export `./trace-worker`), and the host
// builds a worker chunk from it. It shares `trace-engine` with `index`
// through a split chunk — which also lands in the flat `dist/`, so the
// same `../wasm/…` holds there.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/geometry.ts",
    "src/machines.ts",
    "src/trace-worker.ts",
  ],
  format: ["esm"],
  // The JS inlines the workspace packages (noExternal); the types must too,
  // or the published .d.ts imports @paged-media/draw-geometry / draw-tools,
  // which are never published, and a consumer sees `any`. tsconfig.build.json
  // maps both to their sources, so the declaration bundle reads them as local
  // code and inlines them.
  dts: true,
  tsconfig: "tsconfig.build.json",
  clean: true,
  noExternal: [/^@paged-media\/draw-/],
  external: [/\?url$/, /wasm\//],
});
