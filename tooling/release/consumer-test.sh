#!/usr/bin/env bash
# The clean-room consumer test of the four public npm packages (PM-0008):
# install the packed tarballs into empty projects outside the repository, the
# way a user would, and use them.
#
#   bash tooling/release/consumer-test.sh <dir with the four .tgz> [<work dir>]
#
# Two projects, one per package manager:
#   npm  — `npm install` of the tarballs under Node;
#   bun  — `bun add` of the tarballs under Bun.
# In each:
#   1. import every entry and subpath (idml-viewer, ./session; canvas-wasm,
#      ./introspect, ./repo; plugin-api, ./manifest.schema.json; plugin-sdk),
#      instantiate the session, introspection and repository wasm, read
#      ./introspect/catalog.json, and run the paged-plugin bin's `validate`;
#   2. typecheck a small TypeScript consumer of all four with
#      moduleResolution nodenext AND bundler, skipLibCheck off, under
#      TypeScript 7 and 5.9.
#
# Nothing is published and nothing is installed outside <work dir> (default: a
# fresh temporary directory). Exit 1 on the first failure.
set -euo pipefail

TGZ_DIR=$(cd "${1:?usage: consumer-test.sh <dir with the four .tgz> [<work dir>]}" && pwd)
WORK=${2:-$(mktemp -d "${TMPDIR:-/tmp}/paged-consumer-XXXXXX")}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
TS7=7.0.2
TS5=5.9.3
TYPES_NODE=24.19.2
TYPES_REACT=19.3.0

tgz() {
  local f
  f=$(find "$TGZ_DIR" -maxdepth 1 -name "paged-media-$1-*.tgz" | head -1)
  [ -n "$f" ] || { echo "consumer-test: no paged-media-$1-*.tgz in $TGZ_DIR" >&2; exit 1; }
  echo "$f"
}
CANVAS=$(tgz canvas-wasm)
VIEWER=$(tgz idml-viewer)
API=$(tgz plugin-api)
SDK=$(tgz plugin-sdk)

write_project() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/package.json" <<'JSON'
{ "name": "paged-consumer-test", "private": true, "version": "0.0.0", "type": "module" }
JSON
  # A minimal extension manifest for `paged-plugin validate`.
  cat >"$dir/manifest.json" <<'JSON'
{ "id": "com.example.hello", "name": "Hello", "version": "0.1.0", "apiVersion": "^0.2" }
JSON
  cat >"$dir/imports.mjs" <<'JS'
// Every entry and subpath of the four packages, from a consumer's side.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as viewer from "@paged-media/idml-viewer";
import * as session from "@paged-media/idml-viewer/session";
import * as canvas from "@paged-media/canvas-wasm";
import * as introspect from "@paged-media/canvas-wasm/introspect";
import * as repo from "@paged-media/canvas-wasm/repo";
import * as api from "@paged-media/plugin-api";
import * as sdk from "@paged-media/plugin-sdk";
import schema from "@paged-media/plugin-api/manifest.schema.json" with { type: "json" };
import viewerPkg from "@paged-media/idml-viewer/package.json" with { type: "json" };
import canvasPkg from "@paged-media/canvas-wasm/package.json" with { type: "json" };

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const bytes = (spec) => readFileSync(fileURLToPath(import.meta.resolve(spec)));

check(typeof viewer.createViewer === "function", "idml-viewer: createViewer");
check(typeof viewer.createSessionFromBundledWasm === "function", "idml-viewer: createSessionFromBundledWasm");
check(typeof session.ViewerSession === "function", "idml-viewer/session: ViewerSession");
session.initSync({ module: bytes("@paged-media/idml-viewer/session/paged_sdk_bg.wasm") });
check(true, "idml-viewer/session: the session wasm instantiates");
check(typeof canvas.CanvasWorker === "function", "canvas-wasm: CanvasWorker");
check(bytes("@paged-media/canvas-wasm/paged_canvas_wasm_bg.wasm").length > 1e6, "canvas-wasm: the canvas wasm resolves");
check(typeof introspect.Inspector === "function", "canvas-wasm/introspect: Inspector");
introspect.initSync({ module: bytes("@paged-media/canvas-wasm/introspect/paged_introspect_wasm_bg.wasm") });
const live = JSON.parse(introspect.describeCatalog());
const shipped = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@paged-media/canvas-wasm/introspect/catalog.json")), "utf8"));
check(JSON.stringify(live) === JSON.stringify(shipped), "canvas-wasm/introspect: describeCatalog() equals introspect/catalog.json");
check(typeof repo.Repository === "function", "canvas-wasm/repo: Repository");
repo.initSync({ module: bytes("@paged-media/canvas-wasm/repo/paged_repo_wasm_bg.wasm") });
const r = new repo.Repository("consumer-test");
check(typeof r.free === "function", "canvas-wasm/repo: new Repository()");
r.free();
check(Object.keys(api).length === 0, "plugin-api: type-only (no runtime exports)");
check(schema?.required?.includes("apiVersion"), "plugin-api/manifest.schema.json");
check(typeof sdk.loadBundle === "function" && typeof sdk.defineBundle === "function", "plugin-sdk: loadBundle, defineBundle");
check(sdk.satisfiesApiVersion(`^${sdk.API_VERSION.slice(0, 3)}`), "plugin-sdk: API_VERSION negotiates");
const minor = (v) => v.split(".")[1];
check(minor(viewerPkg.version) === minor(canvasPkg.version), `one version: idml-viewer ${viewerPkg.version}, canvas-wasm ${canvasPkg.version}`);

if (failures.length) {
  console.error(`${failures.length} import check(s) failed`);
  process.exit(1);
}
JS
  cat >"$dir/consumer.ts" <<'TS'
// A tiny extension and an embedder, typed against the four packages.
import type { BundleHost, PagedBundle, PluginManifest } from "@paged-media/plugin-api";
import { API_VERSION, defineBundle, satisfiesApiVersion } from "@paged-media/plugin-sdk";
import { createViewer, type Viewer } from "@paged-media/idml-viewer";
import initSession, { ViewerSession } from "@paged-media/idml-viewer/session";
import { Inspector, describeCatalog } from "@paged-media/canvas-wasm/introspect";
import { Repository } from "@paged-media/canvas-wasm/repo";
import { CanvasWorker } from "@paged-media/canvas-wasm";

export const manifest: PluginManifest = {
  id: "com.example.hello",
  name: "Hello",
  version: "0.1.0",
  apiVersion: `^${API_VERSION.slice(0, 3)}`,
};

export const bundle: PagedBundle = defineBundle({
  manifest,
  activate(host: BundleHost) {
    host.log.info(`hello from ${manifest.id}`);
    return { dispose() {} };
  },
});

export const negotiates: boolean = satisfiesApiVersion(manifest.apiVersion);

export async function embed(canvas: HTMLCanvasElement): Promise<Viewer> {
  await initSession();
  const viewer = await createViewer({ canvas, session: () => ViewerSession.new() });
  return viewer;
}

export function surfaces(): [typeof Inspector, string, typeof Repository, typeof CanvasWorker] {
  return [Inspector, describeCatalog(), Repository, CanvasWorker];
}
TS
  for res in nodenext bundler; do
    if [ "$res" = nodenext ]; then MODULE=nodenext; else MODULE=esnext; fi
    cat >"$dir/tsconfig.$res.json" <<JSON
{
  "compilerOptions": {
    "target": "es2022",
    "module": "$MODULE",
    "moduleResolution": "$res",
    "lib": ["es2022", "dom", "dom.iterable"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "files": ["consumer.ts"]
}
JSON
  done
}

# The engine's generated wire declarations (canvas-wasm's .d.ts, its
# introspect entry, and plugin-api's vendored wire.d.ts) name three types they
# never declare: CellAddr, FlowGrowRule and TableLineRestoreJson. Published
# releases have the same gap (0.73.4 included); a consumer with skipLibCheck
# on, the common default, sees them as `any`. These errors, and only these,
# are reported and tolerated; any other error fails the test.
KNOWN_TS='(paged_canvas_wasm|paged_introspect_wasm|wire)\.d\.ts\([0-9]+,[0-9]+\): error TS2304: Cannot find name .(CellAddr|FlowGrowRule|TableLineRestoreJson).\.'

typecheck() {
  local dir="$1" pm="$2" out known other
  for ts in typescript ts5; do
    for res in nodenext bundler; do
      echo "== $pm: tsc ($ts $(node "$dir/node_modules/$ts/bin/tsc" --version | awk '{print $2}')) --moduleResolution $res"
      out=$(cd "$dir" && node "node_modules/$ts/bin/tsc" -p "tsconfig.$res.json" 2>&1) || true
      known=$(printf '%s\n' "$out" | grep -cE "$KNOWN_TS" || true)
      other=$(printf '%s\n' "$out" | grep -E 'error TS' | grep -vE "$KNOWN_TS" || true)
      if [ -n "$other" ]; then
        printf '%s\n' "$other" >&2
        echo "consumer-test: tsc ($ts, $res) failed" >&2
        exit 1
      fi
      if [ "$known" -gt 0 ]; then
        echo "   ok, with $known known error(s): the wire declarations' undeclared CellAddr/FlowGrowRule/TableLineRestoreJson"
      else
        echo "   ok"
      fi
    done
  done
}

echo "consumer-test: $WORK"

# --- npm under Node ------------------------------------------------------------
NPM_DIR="$WORK/npm"
rm -rf "$NPM_DIR"
write_project "$NPM_DIR"
echo "== npm: install the four tarballs (node $(node --version), npm $(npm --version))"
(cd "$NPM_DIR" && npm install --no-audit --no-fund --loglevel=error \
  "$CANVAS" "$VIEWER" "$API" "$SDK" \
  "typescript@$TS7" "ts5@npm:typescript@$TS5" "@types/node@$TYPES_NODE" "@types/react@$TYPES_REACT")
echo "== npm: node imports.mjs"
(cd "$NPM_DIR" && node imports.mjs)
echo "== npm: npx paged-plugin validate"
(cd "$NPM_DIR" && npx --no-install paged-plugin validate manifest.json)
typecheck "$NPM_DIR" npm

# --- Bun -----------------------------------------------------------------------
BUN_DIR="$WORK/bun"
rm -rf "$BUN_DIR"
write_project "$BUN_DIR"
echo "== bun: install the four tarballs (bun $(bun --version))"
# The tarballs as dependencies, and plugin-sdk's dependency on plugin-api
# pointed at its tarball too: before a publish, the registry does not have the
# version yet (npm dedupes against the tarball on its own; Bun needs the
# override).
cat >"$BUN_DIR/package.json" <<JSON
{
  "name": "paged-consumer-test",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": {
    "@paged-media/canvas-wasm": "$CANVAS",
    "@paged-media/idml-viewer": "$VIEWER",
    "@paged-media/plugin-api": "$API",
    "@paged-media/plugin-sdk": "$SDK",
    "typescript": "$TS7",
    "ts5": "npm:typescript@$TS5",
    "@types/node": "$TYPES_NODE",
    "@types/react": "$TYPES_REACT"
  },
  "overrides": { "@paged-media/plugin-api": "$API" }
}
JSON
(cd "$BUN_DIR" && bun install --silent)
echo "== bun: bun imports.mjs"
(cd "$BUN_DIR" && bun imports.mjs)
echo "== bun: bun x paged-plugin validate"
(cd "$BUN_DIR" && ./node_modules/.bin/paged-plugin validate manifest.json)
typecheck "$BUN_DIR" bun

echo "consumer-test OK — npm and bun, nodenext and bundler, TypeScript $TS7 and $TS5"
