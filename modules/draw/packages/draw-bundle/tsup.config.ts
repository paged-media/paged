import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/geometry.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [/^@paged-media\/draw-/],
});
