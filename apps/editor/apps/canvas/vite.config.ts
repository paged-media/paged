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

import { defineConfig } from "vite";
import { buildModuleManifest, MODULE_HOST } from "./scripts/module-index.mjs";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { resolve, sep } from "node:path";
import {
  appendFileSync,
  createReadStream,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import {
  DATA_ORIGINS_ENV,
  connectSrc,
  parseDataOrigins,
  rewriteHeadersCsp,
} from "./src/boot/network-policy";
import {
  REPORT_PATH as TRUSTED_TYPES_REPORT_PATH,
  TRUSTED_TYPES_POLICY,
} from "./src/boot/trusted-types";
import { reactCompiler } from "../../../../tooling/js/react-compiler.mjs";

// The monorepo root: apps/editor/apps/canvas → four levels up.
const MONOREPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

// An installed InDesign's own fonts directory (macOS), for the fidelity
// suite: a vendor pack whose reference PDF InDesign set in its substitute,
// Myriad Pro, maps the missing families to the copy InDesign ships
// (corpus config/overrides/<pack>/fonts.sh). The face is read in place and
// never copied into a repository.
const INDESIGN_FONT_DIRS = (() => {
  try {
    return readdirSync("/Applications")
      .filter((n) => n.startsWith("Adobe InDesign"))
      .map((n) => `/Applications/${n}/Resources/Required/fonts`)
      .filter((d) => existsSync(d));
  } catch {
    return [];
  }
})();

// Resolve a corpus subdir, preferring a copy colocated in the editor
// (`apps/editor/corpus/<name>`, a local symlink) but falling back to the
// repository-root corpus (`<repo root>/corpus/<name>`, gitignored; a local
// symlink to the private corpus checkout).
function resolveCorpusSubdir(name: string): string {
  const candidates = [
    resolve(__dirname, "..", "..", "corpus", name), // apps/editor/corpus/<name>
    resolve(MONOREPO_ROOT, "corpus", name), // <repo root>/corpus/<name>
  ];
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // try next candidate
    }
  }
  return candidates[0]; // colocated path; the route 404s if it's absent
}

// The corpus root with symlinks resolved, when it exists.
function realCorpusRoot(): string[] {
  try {
    return [realpathSync(resolve(CORPUS_ENVATO, ".."))];
  } catch {
    return [];
  }
}

const CORPUS_FONTS = resolveCorpusSubdir("fonts");
const CORPUS_ENVATO = resolveCorpusSubdir("idml");

// paged.data's engine (data_js.js + data_js_bg.wasm, the query store inside
// it) ships in the package's own `bin/`, and the bundle loads it relative to
// its own module (`../bin/<file>`). DATA_BIN is that installed `bin/`, copied
// into `dist/bin/` by `dataBundleBin` in a build.
const DATA_BIN = resolve(
  __dirname,
  "node_modules",
  "@paged-media",
  "data",
  "bin",
);
// SharedArrayBuffer requires cross-origin isolation. Set the two
// COOP / COEP headers Vite's dev server needs so the worker can
// allocate a SAB for the camera transform. Production hosts must
// serve the same headers — without them, `new SharedArrayBuffer(...)`
// throws `SecurityError`.
function isolate(
  _req: unknown,
  res: { setHeader(name: string, value: string): void },
  next: () => void,
) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // credentialless (lock-step with public/_headers) so the docs playground
  // can embed the dev server cross-origin; still crossOriginIsolated for SAB.
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  // Opt in to cross-origin embedding (a COEP parent blocks the iframe otherwise).
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}
// A response carries each CSP as a header line of its own (the browser
// enforces every one): a policy is added to the ones already set, never
// replaces them, so the middlewares' order does not matter.
type PolicyResponse = {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string | string[]): void;
};
function addPolicy(res: PolicyResponse, policy: string) {
  const prev = res.getHeader("Content-Security-Policy");
  const list = prev === undefined ? [] : [prev].flat().map(String);
  if (!list.includes(policy)) list.push(policy);
  res.setHeader("Content-Security-Policy", list.length === 1 ? list[0] : list);
}

// ADR 240, ADR 273 — Trusted Types, enforced (src/boot/trusted-types.ts holds
// the policy; public/_headers ships the same). The dev and preview servers
// answer the report route themselves: a report is appended to the file
// PAGED_CSP_REPORT_LOG names (one JSON line each, so a test run's violations
// can be counted afterwards), and dropped when it is unset.
function trustedTypesPolicy(
  req: {
    method?: string;
    url?: string;
    on(e: string, f: (c?: Buffer) => void): void;
  },
  res: PolicyResponse & {
    statusCode: number;
    end(): void;
  },
  next: () => void,
) {
  if (req.method === "POST" && req.url?.startsWith(TRUSTED_TYPES_REPORT_PATH)) {
    const chunks: Buffer[] = [];
    req.on("data", (c?: Buffer) => {
      if (c) chunks.push(c);
    });
    req.on("end", () => {
      const log = process.env.PAGED_CSP_REPORT_LOG;
      if (log) {
        const body = Buffer.concat(chunks).toString("utf8").replace(/\n/g, " ");
        appendFileSync(log, `${body}\n`);
      }
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  addPolicy(res, TRUSTED_TYPES_POLICY);
  next();
}

const crossOriginIsolation = {
  name: "cross-origin-isolation-headers",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use(isolate);
    server.middlewares.use(trustedTypesPolicy);
  },
  // `vite preview` serves the production build with the same headers, so
  // a built app boots locally (the React Compiler's latency probe runs
  // against it, ADR 229).
  configurePreviewServer(server: import("vite").PreviewServer) {
    server.middlewares.use(isolate);
    server.middlewares.use(trustedTypesPolicy);
  },
};

// D-03 network wall. The editor mediates plugin network access through the
// `host.network` consent door, but a same-realm (or worker) bundle could call
// `window.fetch` directly and bypass the in-process door entirely. The browser
// CSP `connect-src` is the only hard wall against that: it bounds EVERY fetch /
// XHR / WebSocket the page (and its workers) can make, no matter who issues it.
//
// The floor admits only same-origin + local-bytes schemes — the editor app's
// real network surface (corpus/fonts/wasm under `/`, swatch blob: reads). A
// deployment may add EXACT data origins at build time through
// `PAGED_DATA_ORIGINS` (ADR 218): a consented remote data source on such an
// origin is reachable; nothing else is. A header CSP cannot follow runtime
// consent grants, so this is a reviewed, build-time list — never `https:`.
// We scope the policy to `connect-src` only (no `default-src`) so script/style/
// img execution is untouched — minimal blast radius, just the egress wall. The
// floor, the parsing and the `_headers` rewrite live in
// src/boot/network-policy.ts (tested by scripts/network-policy.test.mjs).
// ADR 225 — the paged.server this build syncs with, if any. Its origin joins
// the wall exactly like a data origin (same parser: exact https, or http on
// loopback); without it the editor has no server and stays browser-only.
const PAGED_SERVER = parseDataOrigins(process.env.PAGED_SERVER_URL)[0] ?? "";
const DATA_ORIGINS = [
  ...new Set([
    ...parseDataOrigins(process.env[DATA_ORIGINS_ENV]),
    ...(PAGED_SERVER ? [PAGED_SERVER] : []),
  ]),
];
const CONNECT_SRC = connectSrc(DATA_ORIGINS);
// Dev adds the Vite HMR WebSocket (client live-reload) — without it `pnpm dev`
// and the Playwright runs lose hot updates.
const CONNECT_SRC_DEV = `${CONNECT_SRC} ws://127.0.0.1:* ws://localhost:*`;

const networkConnectSrcPolicy = {
  name: "network-connect-src-policy",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((_req, res, next) => {
      addPolicy(res, CONNECT_SRC_DEV);
      next();
    });
  },
  // Build only: inject the policy as a `<meta>` so a static host that ignores
  // `_headers` still ships the wall. Skipped in dev (the header above is the
  // single source — two policies would intersect and drop the HMR socket).
  transformIndexHtml(html: string, ctx: { server?: unknown }) {
    if (ctx.server) return html;
    return html.replace(
      "</title>",
      `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CONNECT_SRC}" />`,
    );
  },
  // Build only: `public/_headers` carries the floor (committed, reviewed);
  // when the build admits data origins, the copy in the output carries the
  // same policy as the `<meta>` — the two must never disagree (they
  // intersect, so a stale floor would silently block the listed origins).
  writeBundle(options: { dir?: string }) {
    if (DATA_ORIGINS.length === 0 || !options.dir) return;
    const file = resolve(options.dir, "_headers");
    if (!existsSync(file)) return;
    writeFileSync(
      file,
      rewriteHeadersCsp(readFileSync(file, "utf8"), CONNECT_SRC),
    );
  },
};

// Embedding plan E6 — the pages that may frame embed.html: the floor in
// public/_headers is the editor's own origin; a build with
// VITE_EMBED_ORIGINS writes the list into the output's copy, the same list
// the bridge checks messages against.
const EMBED_ORIGINS = parseDataOrigins(process.env.VITE_EMBED_ORIGINS);

const embedFrameAncestors = {
  name: "embed-frame-ancestors",
  writeBundle(options: { dir?: string }) {
    if (EMBED_ORIGINS.length === 0 || !options.dir) return;
    const file = resolve(options.dir, "_headers");
    if (!existsSync(file)) return;
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "frame-ancestors 'self'",
        `frame-ancestors 'self' ${EMBED_ORIGINS.join(" ")}`,
      ),
    );
  },
};

/**
 * Dev only: the Claude proxy at /api/ai (ADR 221), the same handler the
 * Pages Function mounts in production (functions/api/ai). Active when the
 * dev server is started with ANTHROPIC_API_KEY set; otherwise /api/ai
 * answers 503 as an unconfigured deployment does. No spend cap here — it
 * is your key.
 */
function aiProxyDev(): import("vite").Plugin {
  return {
    name: "paged-ai-proxy-dev",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/ai/")) return next();
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "ai_unavailable",
                message:
                  "Start the dev server with ANTHROPIC_API_KEY set to use Claude.",
              },
            }),
          );
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers))
            if (typeof v === "string") headers.set(k, v);
          const origin = `http://${req.headers.host}`;
          const request = new Request(new URL(req.url, origin), {
            method: req.method,
            headers,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          });
          const { handleAiProxy } = (await server.ssrLoadModule(
            "@paged-media/ai/proxy",
          )) as typeof import("@paged-media/ai/proxy");
          const { default: catalog } = (await server.ssrLoadModule(
            "@paged-media/ai/catalog",
          )) as typeof import("@paged-media/ai/catalog");
          const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
          const response = await handleAiProxy(request, {
            apiKey,
            catalog,
            ...(workspaceId ? { workspaceId } : {}),
          });
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (!response.body) return res.end();
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
            res.write(chunk);
          res.end();
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

/**
 * Serve `/fonts/<name>` from `<repo>/corpus/fonts/<name>`. Lets the
 * canvas auto-fetch a default font when the user drops an IDML so
 * the editor demo shows real glyphs in dev. Path traversal blocked
 * by a flat name check.
 */
function fontsRoute(): import("vite").Plugin {
  return {
    name: "static-prefix:/fonts/",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/fonts/")) return next();
        const rel = decodeURIComponent(
          req.url.slice("/fonts/".length).split("?")[0],
        );
        if (rel.includes("/") || rel.includes("..") || rel === "") {
          res.statusCode = 400;
          return res.end("bad path");
        }
        const abs = resolve(CORPUS_FONTS, rel);
        try {
          if (!statSync(abs).isFile()) {
            return next();
          }
        } catch {
          return next();
        }
        const ext = abs.split(".").pop()?.toLowerCase() ?? "";
        const mime =
          ext === "ttf"
            ? "font/ttf"
            : ext === "otf"
              ? "font/otf"
              : "application/octet-stream";
        res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(abs).pipe(res);
      });
    },
  };
}

/**
 * Dev-only: browse + load the staged Envato fidelity corpus from the
 * running editor. The loadable IDML for each pack is
 * `corpus/idml/packs/<name>/template.idml` — note the *raw* Envato
 * `.zip` bundles often ship only an `.indd`, which the engine can't
 * parse, so we deliberately serve the staged `template.idml` that the
 * Playwright fidelity suite already relies on (manifest.json). Mirrors
 * `fontsRoute`'s flat-name guard. Not wired in production (no corpus
 * there) — the `CorpusPicker` control self-hides when /list is empty.
 *
 * Three fixture groups are exposed so the whole corpus is loadable from
 * the editor's header (`generated/*` feature fixtures, `samples/*`, and
 * the envato `packs/*`):
 *
 *   GET /corpus/idml/list              -> [{ id, label, group, stage? }]
 *   GET /corpus/idml/file/<group>/<x>  -> the IDML bytes
 *        generated/<base>  -> corpus/idml/generated/<base>.idml
 *        samples/<base>    -> corpus/idml/samples/<base>.idml
 *        packs/<name>      -> corpus/idml/packs/<name>/template.idml
 *   (legacy `file/<name>` with no group still resolves a pack.)
 */
function corpusIdmlRoute(): import("vite").Plugin {
  // Resolve the corpus ROOT directly. It used to be
  // `resolve(CORPUS_ENVATO, "..")` — derived from the envato path — and
  // that broke the moment envato moved one level deeper into
  // `vendor/envato`: the root silently became `corpus/vendor`, the
  // generated/samples routes pointed at directories that do not exist,
  // the corpus picker rendered nothing, and the failure surfaced as
  // `getByLabel('Load corpus IDML')` not found. Deriving one path from
  // another is exactly the coupling the restructure exists to remove.
  const CORPUS_ROOT = resolveCorpusSubdir(".");
  const PACKS_DIR = resolve(CORPUS_ENVATO, "packs");
  // Assets are grouped by FORMAT since the corpus grew past IDML.
  const GENERATED_DIR = resolve(CORPUS_ROOT, "idml", "generated");
  const SAMPLES_DIR = resolve(CORPUS_ROOT, "idml", "samples");
  const MANIFEST = resolve(CORPUS_ENVATO, "manifest.json");
  const STAGE_RANK: Record<string, number> = { smoke: 0, gated: 1, skip: 2 };
  const GROUP_RANK: Record<string, number> = {
    generated: 0,
    sample: 1,
    pack: 2,
  };
  // List the *.idml basenames in a flat dir (generated / samples).
  const listIdml = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".idml"))
        .map((f) => f.slice(0, -".idml".length));
    } catch {
      return [];
    }
  };
  return {
    name: "static-prefix:/corpus/idml/",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/corpus/idml/")) return next();
        const rest = decodeURIComponent(
          req.url.slice("/corpus/idml/".length).split("?")[0],
        );

        if (rest === "list") {
          const entries: Array<{
            id: string;
            label: string;
            group: string;
            stage?: string;
          }> = [];
          // generated/* + samples/* — flat dirs of <base>.idml
          for (const base of listIdml(GENERATED_DIR)) {
            entries.push({
              id: `generated/${base}`,
              label: base,
              group: "generated",
            });
          }
          for (const base of listIdml(SAMPLES_DIR)) {
            entries.push({
              id: `samples/${base}`,
              label: base,
              group: "sample",
            });
          }
          // packs/* — <name>/template.idml, stage from the fidelity manifest
          const stageByName = new Map<string, string>();
          try {
            const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
              packs?: Array<{ name?: string; stage?: string }>;
            };
            for (const p of manifest.packs ?? []) {
              if (p.name) stageByName.set(p.name, p.stage ?? "gated");
            }
          } catch {
            // manifest is optional — fall back to scanning the dir
          }
          try {
            for (const name of readdirSync(PACKS_DIR)) {
              try {
                if (
                  !statSync(resolve(PACKS_DIR, name, "template.idml")).isFile()
                )
                  continue;
              } catch {
                continue; // not a pack dir / no staged idml
              }
              entries.push({
                id: `packs/${name}`,
                label: name,
                group: "pack",
                stage: stageByName.get(name) ?? "gated",
              });
            }
          } catch {
            // no packs dir
          }
          entries.sort(
            (a, b) =>
              (GROUP_RANK[a.group] ?? 3) - (GROUP_RANK[b.group] ?? 3) ||
              (STAGE_RANK[a.stage ?? ""] ?? 1) -
                (STAGE_RANK[b.stage ?? ""] ?? 1) ||
              a.label.localeCompare(b.label),
          );
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-cache");
          return res.end(JSON.stringify(entries));
        }

        if (rest.startsWith("file/")) {
          const id = rest.slice("file/".length);
          const parts = id.split("/");
          // Accept "<group>/<name>" or legacy "<name>" (defaults to a pack).
          const [group, name] =
            parts.length === 2 ? parts : ["packs", parts[0]];
          const bad = (s: string) =>
            s === "" || s.includes("..") || s.includes("\\");
          let abs: string | null = null;
          if (bad(name)) {
            res.statusCode = 400;
            return res.end("bad name");
          }
          if (group === "generated")
            abs = resolve(GENERATED_DIR, `${name}.idml`);
          else if (group === "samples" || group === "sample")
            abs = resolve(SAMPLES_DIR, `${name}.idml`);
          else if (group === "packs" || group === "pack")
            abs = resolve(PACKS_DIR, name, "template.idml");
          if (!abs) {
            res.statusCode = 400;
            return res.end("bad group");
          }
          try {
            if (!statSync(abs).isFile()) {
              res.statusCode = 404;
              return res.end("no such fixture");
            }
          } catch {
            res.statusCode = 404;
            return res.end("no such fixture");
          }
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Cache-Control", "no-cache");
          return createReadStream(abs).pipe(res);
        }

        return next();
      });
    },
  };
}

/**
 * BUILD output: copy the installed @paged-media/data package's `bin/` into
 * `dist/bin/`. The bundle loads its engine with runtime-relative URLs
 * (`new URL("../bin/<file>", import.meta.url)` — data_js.js +
 * data_js_bg.wasm). Vite cannot see those (they are computed, not literal),
 * so it bundles the code into `dist/assets/*.js` and leaves the files behind;
 * from `assets/`, `../bin/` is `dist/bin/`. Without this a built editor has
 * no data engine at all.
 *
 * Only the package's own files are copied, so a build is exactly as complete
 * as the published package. A missing engine is a warning, not an error: the
 * plugin degrades to "engine-missing", and REQUIRE_REAL_ENGINE=1 journeys
 * turn that into a failure.
 */
function dataBundleBin(): import("vite").Plugin {
  return {
    name: "paged-data-bundle-bin",
    apply: "build",
    generateBundle() {
      let names: string[] = [];
      try {
        names = (readdirSync(DATA_BIN, { recursive: true }) as string[])
          .map((n) => n.split(sep).join("/"))
          .filter((n) => !n.endsWith(".d.ts"));
      } catch {
        this.warn(
          `@paged-media/data has no bin/ at ${DATA_BIN} — paged.data will not boot in this build`,
        );
        return;
      }
      for (const name of names) {
        const abs = resolve(DATA_BIN, name);
        if (!statSync(abs).isFile()) continue;
        this.emitFile({
          type: "asset",
          fileName: `bin/${name}`,
          source: readFileSync(abs),
        });
      }
      if (!names.includes("data_js_bg.wasm"))
        this.warn(
          "@paged-media/data ships no data_js_bg.wasm — paged.data will report engine-missing in this build " +
            "(build it: modules/data/scripts/build-wasm.sh)",
        );
    },
  };
}

/**
 * ADR 223 — the module manifest behind the editor's module door
 * (src/plugin-modules.ts): every installed plugin package's declared wasm,
 * with sha384 and host version, as `virtual:paged-modules`. A build with
 * PAGED_MODULES_HOSTED=1 (the playground deploy, whose modules-sync hosts
 * every listed module) answers the module host; the dev server answers the
 * installed files under /@fs/; any other build answers null (bundles load
 * their own copy).
 */
function pagedModules(): import("vite").Plugin {
  const ID = "virtual:paged-modules";
  let dev = false;
  return {
    name: "paged-modules",
    configResolved(config) {
      dev = config.command === "serve";
    },
    resolveId(id) {
      return id === ID ? `\0${ID}` : null;
    },
    load(id) {
      if (id !== `\0${ID}`) return null;
      const hosted = !dev && process.env.PAGED_MODULES_HOSTED === "1";
      const manifest = buildModuleManifest({
        host: hosted ? MODULE_HOST : null,
        dev,
      });
      return `export default ${JSON.stringify(manifest)};`;
    },
  };
}

export default defineConfig({
  // The page learns which data origins its wall admits, so the consent
  // dialog can say when a consented origin stays unreachable (ADR 218).
  define: {
    __PAGED_DATA_ORIGINS__: JSON.stringify(DATA_ORIGINS),
    __PAGED_SERVER__: JSON.stringify(PAGED_SERVER),
  },
  // apps/canvas/ lives one extra level deep than web/ — adjust the
  // workspace root so node_modules + the Cargo target dir resolve.
  root: resolve(__dirname),
  plugins: [
    react(),
    // The React Compiler (ADR 229) over every first-party package, the
    // module bundles included: they resolve to their sources, so this build
    // compiles them. `PAGED_REACT_COMPILER=0` turns it off.
    ...reactCompiler({ reactCompilerPreset, babel }),
    crossOriginIsolation,
    networkConnectSrcPolicy,
    embedFrameAncestors,
    aiProxyDev(),
    fontsRoute(),
    corpusIdmlRoute(),
    dataBundleBin(),
    pagedModules(),
  ],
  server: {
    // Pin to IPv4 so Playwright's `127.0.0.1` health-check resolves.
    // Node ≥20 may resolve `localhost` to IPv6 first, in which case
    // Vite's default "localhost" bind misses 127.0.0.1.
    host: "127.0.0.1",
    fs: {
      allow: [
        resolve(__dirname),
        resolve(__dirname, "..", ".."),
        // Corpus root (resolved to `<repo root>/corpus`, or
        // `apps/editor/corpus` if colocated) so the
        // fidelity driver + ad-hoc `/@fs/` loads can fetch fixtures
        // under corpus/idml/generated/* and corpus/idml/samples/*, not just the
        // envato packs the /corpus/idml/ route serves.
        resolve(CORPUS_ENVATO, ".."),
        // ...and where that symlink points: Vite checks a /@fs/ request
        // against the file's real path, so a corpus linked in from outside
        // the repository 403s on every font and fixture without it.
        ...realCorpusRoot(),
        // The workspace packages outside apps/editor (`<repo root>/modules`,
        // `platform/extensions`, `engine/core/packages`): their wasm
        // artifacts (canvas-wasm, sheet-js, image-js, data-js) are served via
        // /@fs/ — without this the engine boot 403s (the K-1
        // live-validation e2e surfaced it).
        MONOREPO_ROOT,
        "/tmp",
        // System CMYK ICC profile dir — the fidelity suite fetches
        // CoatedFOGRA39.icc via /@fs/ to match `pdftoppm`'s output.
        "/Library/Application Support/Adobe/Color/Profiles",
        ...INDESIGN_FONT_DIRS,
      ],
    },
  },
  resolve: {
    // One React only: a plugin bundle is a workspace package, linked to
    // its source directory, so its imports resolve from ITS realpath (its
    // own node_modules). Should that ever resolve another React than the
    // app's, panel components would mount against a second instance and
    // break hooks.
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    // No `exclude`: every @paged-media package is a workspace package,
    // linked to its source directory outside node_modules, and Vite never
    // pre-bundles a linked dependency (it serves it through the module
    // graph, as source). The list here kept the PUBLISHED copies out of the
    // pre-bundle (canvas-wasm, pdf, doc, slide: `?url` wasm imports esbuild
    // cannot read; plugin-sdk: a top-level await below the optimizer's
    // target; data: a runtime-relative `../bin/` import that 404s from
    // .vite/deps). The linked packages have none of those problems.
  },
  worker: {
    format: "es",
  },
  // The editor page plus the embedding demos (`demos/*.html`), each a host
  // page that mounts the editor through `createEditor`.
  build: {
    rolldownOptions: {
      input: Object.fromEntries([
        ["main", resolve(__dirname, "index.html")],
        // The editor as an iframe a host drives (embedding plan E6).
        ["embed", resolve(__dirname, "embed.html")],
        ...readdirSync(resolve(__dirname, "demos"))
          .filter((n) => n.endsWith(".html"))
          .map((n) => [
            `demos/${n.slice(0, -5)}`,
            resolve(__dirname, "demos", n),
          ]),
      ]),
    },
  },
});
