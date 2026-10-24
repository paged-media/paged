/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The build of `@paged-media/editor` (docs/adr/PM-0013, plan E8): the
// editor's embedding API, compiled from the editor's own sources
// (apps/canvas/src/embed), into an ES module package in dist/:
//
//   index.js     `.`          createEditor, mountEditor (the editor loads
//                             lazily, from the first call)
//   iframe.js    `./iframe`   connectEditor (no React, no engine)
//   presets.js   `./presets`  the presets, as data
//   style.css    `./style.css`
//   assets/      the chunks, the workers and the module wasm
//   bin/         paged.data's engine loaders (their wasm is hosted)
//   fonts/       the default faces (Inter, SIL OFL 1.1)
//
// Every private workspace package (the shell, the client, the module
// bundles, the plugin SDK the editor hosts them with, ...) is bundled: a
// public package depends on no private one (PM-0008). React and react-dom
// are the host's (peer dependencies); the engine is `@paged-media/paged`
// (a dependency), never a copy: the build drops the engine wasm and the
// entry points the worker at the dependency's (`__PAGED_ENGINE_WASM__`).
//
// Not Vite's library mode: it inlines every asset as base64 (28 MiB of
// engine, 30 MiB of module wasm, the workers). An application build with
// script entries keeps them files. Its output names each file the way a
// host's bundler recognises, `new URL("./file", import.meta.url)` and
// `new Worker(new URL("./file", import.meta.url), { type: "module" })`
// (`canonicalUrls` below), so a host that bundles the package copies the
// files, and one that serves it as it is finds them beside the modules.

import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import shellTailwind from "@paged-media/shell/tailwind.config";
import { reactCompiler } from "../../../../tooling/js/react-compiler.mjs";
import {
  buildModuleManifest,
  MODULE_HOST,
} from "../../apps/canvas/scripts/module-index.mjs";

const PKG = import.meta.dirname;
const EDITOR = resolve(PKG, "..", "..");
const CANVAS = resolve(EDITOR, "apps", "canvas");
const REPO = resolve(EDITOR, "..", "..");
const DATA_BUNDLE = resolve(REPO, "modules", "data", "packages", "data-bundle");

/** The data plugin's id: the one bundle whose wasm the package does not
 *  ship. Its engine (the query store inside it) loads from the module host
 *  (ADR 220, ADR 223), and only when a profile activates paged.data. */
const DATA_PLUGIN = "media.paged.data";

// ── The editor's sources, as the package's virtual modules ──────────────

const VIRTUAL: Record<string, string> = {
  "virtual:paged-editor/runtime": join(CANVAS, "src/embed/index.ts"),
  "virtual:paged-editor/presets": join(CANVAS, "src/profiles/presets.ts"),
};

/** `@paged-media/canvas-wasm`'s glue and wasm: the glue is bundled into the
 *  render worker (it is generated with the wasm, so the two must match:
 *  the package pins `@paged-media/paged` to its own version), the wasm is
 *  not (the worker is told the dependency's, worker.ts `engineWasm`). The
 *  repository wasm of the local library is left out with it: an embedded
 *  editor runs without the library (`library: false`). */
function engineFromDependency(): Plugin {
  const NO_URL = "\0paged-editor:no-url";
  return {
    name: "paged-editor:engine-from-dependency",
    enforce: "pre",
    resolveId(id) {
      if (
        /^@paged-media\/canvas-wasm\/(repo\/)?paged_(canvas|repo)_wasm_bg\.wasm\?url$/.test(
          id,
        )
      )
        return NO_URL;
      return null;
    },
    load(id) {
      return id === NO_URL ? "export default undefined;" : null;
    },
    transform(code, id) {
      // The glue's fallback, `new URL('<name>_bg.wasm', import.meta.url)`,
      // would make the build copy the wasm. The worker always names it.
      if (!/paged_(canvas|repo)_wasm\.js$/.test(id)) return null;
      const out = code.replace(
        /new URL\('paged_(canvas|repo)_wasm_bg\.wasm', import\.meta\.url\)/,
        "undefined",
      );
      if (out === code)
        this.error(`${id}: the glue's wasm fallback was not found`);
      return { code: out, map: null };
    },
  };
}

/** The build's module manifest (ADR 223): paged.data's wasm at the module
 *  host, nothing else. Every other bundle loads the wasm this package ships
 *  next to it. */
function moduleManifest(): Plugin {
  const ID = "virtual:paged-modules";
  let manifest: ReturnType<typeof buildModuleManifest> | null = null;
  return {
    name: "paged-editor:module-manifest",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      const all = buildModuleManifest({ host: MODULE_HOST });
      const plugin = all.plugins[DATA_PLUGIN];
      manifest = {
        host: all.host,
        packages: plugin
          ? { [plugin.package]: all.packages[plugin.package]! }
          : {},
        plugins: plugin ? { [DATA_PLUGIN]: plugin } : {},
      };
      return `export default ${JSON.stringify(manifest)};`;
    },
    generateBundle() {
      // What the release hosts before it publishes (scripts/host-modules.mjs).
      if (manifest)
        this.emitFile({
          type: "asset",
          fileName: "modules.json",
          source: `${JSON.stringify(manifest, null, 1)}\n`,
        });
    },
  };
}

/** paged.data finds its engine loader in `bin/` beside its chunk's
 *  directory, or under the host's `assetBase`; its engine wasm is not copied
 *  (the module host serves it). */
function dataBin(): Plugin {
  const BIN = join(DATA_BUNDLE, "bin");
  const BIN_URL = join(DATA_BUNDLE, "src", "bin-url.ts");
  const ASSET_BASE = join(PKG, "src", "asset-base.ts");
  return {
    name: "paged-editor:data-bin",
    transform(code, id) {
      if (id !== BIN_URL) return null;
      const call = "new URL(BIN_DIR + file, import.meta.url).href";
      if (!code.includes(call)) this.error(`${id}: binUrl() changed`);
      return {
        code:
          `import { assetBase as __assetBase } from ${JSON.stringify(ASSET_BASE)};\n` +
          code.replace(
            call,
            '(__assetBase() ? new URL("bin/" + file, __assetBase()) : new URL(BIN_DIR + file, import.meta.url)).href',
          ),
        map: null,
      };
    },
    generateBundle() {
      // The engine comes from the module door.
      const hosted = new Set(["data_js_bg.wasm"]);
      let names: string[];
      try {
        names = (readdirSync(BIN, { recursive: true }) as string[]).map((n) =>
          n.split(sep).join("/"),
        );
      } catch {
        this.error(
          `${BIN} is missing: build paged.data first (moon run data:wasm)`,
        );
      }
      for (const name of names) {
        const abs = join(BIN, name);
        if (!statSync(abs).isFile() || name.endsWith(".d.ts")) continue;
        if (name === "SOURCE_HASH" || hosted.has(name)) continue;
        this.emitFile({
          type: "asset",
          fileName: `bin/${name}`,
          source: readFileSync(abs),
        });
      }
    },
  };
}

/** The default faces (the editor app serves them from public/fonts/):
 *  shipped in dist/fonts/ under their own names, with the licence. */
function fonts(): Plugin {
  const ID = "virtual:paged-editor/fonts";
  const DIR = join(CANVAS, "public", "fonts");
  return {
    name: "paged-editor:fonts",
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      const ref = (name: string) =>
        this.emitFile({
          type: "asset",
          fileName: `fonts/${name}`,
          source: readFileSync(join(DIR, name)),
        });
      const roman = ref("Inter.ttf");
      const italic = ref("Inter-Italic.ttf");
      ref("OFL-inter.txt");
      return `export default { roman: import.meta.ROLLUP_FILE_URL_${roman}, italic: import.meta.ROLLUP_FILE_URL_${italic} };`;
    },
  };
}

function virtualSources(): Plugin {
  const IFRAME = "virtual:paged-editor/iframe";
  return {
    name: "paged-editor:sources",
    enforce: "pre",
    resolveId: (id) => (id === IFRAME ? `\0${IFRAME}` : (VIRTUAL[id] ?? null)),
    load(id) {
      if (id !== `\0${IFRAME}`) return null;
      const embed = join(CANVAS, "src/embed");
      return [
        `export { connectEditor } from ${JSON.stringify(join(embed, "connect.ts"))};`,
        `export { BRIDGED_METHODS } from ${JSON.stringify(join(embed, "protocol.ts"))};`,
      ].join("\n");
    },
  };
}

// ── The output, in the form a host's bundler reads ───────────────────────

/** The marker `renderBuiltUrl` writes for a file the code refers to: its
 *  path relative to the chunk that refers to it. */
const MARK = "__pagedEditorFile__";

/**
 * Vite writes a built file's URL as `new URL(/* @vite-ignore *\/ "x",
 * '' + import.meta.url)`, a form no later bundler reads (it is meant as an
 * application's last step). The package is not: rewrite each reference
 * into `new URL("./x", import.meta.url)`, a worker into
 * `new Worker(new URL("./x", import.meta.url), { type: "module" })`, and
 * the engine's wasm into its place in the `@paged-media/paged` dependency.
 */
function canonicalUrls(): Plugin {
  return {
    name: "paged-editor:canonical-urls",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        let code = chunk.code;
        const rel = (target: string) => {
          const r = posix.relative(posix.dirname(chunk.fileName), target);
          return r.startsWith(".") ? r : `./${r}`;
        };
        // `new URL(/* @vite-ignore */ MARK("x"), '' + import.meta.url)` and
        // its kin: any wrapper Vite put around the marker.
        code = code.replace(
          new RegExp(
            String.raw`new URL\(\s*(?:/\*\s*@vite-ignore\s*\*/\s*)?${MARK}\(("[^"]+")\)\s*,\s*(?:(?:""|'')\s*\+\s*)?import\.meta\.url\s*\)`,
            "g",
          ),
          (_m, file: string) =>
            `new URL(${JSON.stringify(rel(JSON.parse(file)))}, import.meta.url)`,
        );
        code = code.replace(
          new RegExp(String.raw`${MARK}\(("[^"]+")\)`, "g"),
          (_m, file: string) =>
            `new URL(${JSON.stringify(rel(JSON.parse(file)))}, import.meta.url).href`,
        );
        // Worker options a bundler can read: a literal object.
        code = code.replace(
          /new Worker\((new URL\("[^"]+", import\.meta\.url\))(?:\.href)?, \{\s*type: "module",\s*name: options\?\.name\s*\}\)/g,
          'new Worker($1, { type: "module" })',
        );
        // The engine's wasm, from the dependency: dist/ → the package →
        // its sibling @paged-media/paged, where every installer puts a
        // dependency (npm's flat tree, pnpm's and Bun's isolated stores).
        code = code.replace(
          /\b__PAGED_ENGINE_WASM__\b/g,
          `new URL(${JSON.stringify(rel("../../paged/paged_canvas_wasm_bg.wasm"))}, import.meta.url).href`,
        );
        // Vite's dynamic-import helper, under a name of the package's own: a
        // host's Vite adds its own `__vitePreload` to a module it builds.
        code = code.replace(/\b__vitePreload\b/g, "__pagedEditorPreload");
        const left = code.indexOf(MARK);
        if (left >= 0)
          this.error(
            `${chunk.fileName}: a file reference was not rewritten: ${code.slice(Math.max(0, left - 120), left + 120)}`,
          );
        chunk.code = code;
      }
    },
  };
}

/** One stylesheet, `dist/style.css`, for the host to import. */
function oneStylesheet(): Plugin {
  return {
    name: "paged-editor:style",
    enforce: "post",
    generateBundle(_options, bundle) {
      const css = Object.values(bundle).filter(
        (f) => f.type === "asset" && f.fileName.endsWith(".css"),
      );
      if (css.length !== 1)
        this.error(
          `expected one stylesheet, got ${css.map((f) => f.fileName).join(", ") || "none"}`,
        );
      const sheet = css[0] as Extract<(typeof css)[number], { type: "asset" }>;
      const from = posix.dirname(sheet.fileName);
      // Its url()s were written relative to assets/; it moves to the root.
      sheet.source = String(sheet.source).replace(
        /url\(\s*(["']?)(?!data:|https?:|\/|#)([^"')]+)\1\s*\)/g,
        (_m, q: string, ref: string) =>
          `url(${q}./${posix.normalize(posix.join(from, ref))}${q})`,
      );
      sheet.fileName = "style.css";
    },
  };
}

const reactExternal = /^react(-dom)?(\/.*)?$/;

const safe = (name: string) => name.replace(/[^\w.-]+/g, "-");

/** The plugins of the main build that the worker builds need too. */
const workerPlugins = () => [
  engineFromDependency(),
  virtualSources(),
  canonicalUrls(),
];

export default defineConfig({
  root: CANVAS,
  publicDir: false,
  base: "./",
  mode: "production",
  define: {
    // The embedded editor admits no build-time data origins and syncs with
    // no paged.server (the app's build sets both from the environment).
    __PAGED_DATA_ORIGINS__: "[]",
    __PAGED_SERVER__: '""',
  },
  plugins: [
    virtualSources(),
    engineFromDependency(),
    moduleManifest(),
    dataBin(),
    fonts(),
    react(),
    ...reactCompiler({ reactCompilerPreset, babel }),
    oneStylesheet(),
    canonicalUrls(),
  ],
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          ...shellTailwind,
          content: [
            join(CANVAS, "src/**/*.{ts,tsx}"),
            join(EDITOR, "packages/shell/src/**/*.{ts,tsx}"),
            join(EDITOR, "packages/ui/src/**/*.{ts,tsx}"),
          ],
        }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  worker: {
    format: "es",
    plugins: workerPlugins,
  },
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType !== "js") return undefined;
      return { runtime: `${MARK}(${JSON.stringify(filename)})` };
    },
  },
  build: {
    outDir: join(PKG, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    // The host's bundler minifies; the package stays readable, and its file
    // references keep the form `canonicalUrls` writes.
    minify: false,
    cssCodeSplit: false,
    modulePreload: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 8192,
    rolldownOptions: {
      input: {
        index: join(PKG, "src/index.ts"),
        iframe: join(PKG, "src/iframe.ts"),
        presets: join(PKG, "src/presets.ts"),
      },
      preserveEntrySignatures: "strict",
      external: (id) => reactExternal.test(id),
      output: {
        entryFileNames: "[name].js",
        // File names without spaces (the swatch libraries have them).
        chunkFileNames: (c) => `assets/${safe(c.name)}-[hash].js`,
        assetFileNames: (a) =>
          `assets/${safe((a.names[0] ?? "asset").replace(/\.[^.]*$/, ""))}-[hash][extname]`,
      },
    },
  },
});
