#!/usr/bin/env bash
# The clean-room consumer test of the four public npm packages (PM-0008,
# amendment 3; PM-0013): install the packed tarballs into empty projects
# outside the repository, the way a user would, and use them.
#
#   bash tooling/release/consumer-test.sh <dir with the four .tgz> [<work dir>]
#
# Two projects, one per package manager:
#   npm  — `npm install` of the tarballs under Node;
#   bun  — `bun add` of the tarballs under Bun.
# In each:
#   1. import every entry and subpath (viewer, ./session; paged, ./introspect,
#      ./repo; plugin-sdk, ./api, ./api/manifest.schema.json; editor, ./iframe,
#      its JSON and its stylesheet; the editor finds the engine's wasm in
#      the installed @paged-media/paged where its build points), instantiate the
#      session, introspection and repository wasm, read
#      ./introspect/catalog.json, and run the paged-plugin bin's `validate`;
#   2. run the `paged` bin: --help and --version (its engine is the package's
#      own), and `paged mcp` with a scripted initialize, tools/list (the 15
#      tools of the Rust `paged mcp`), lookup_api and list_documents;
#   3. typecheck a small TypeScript consumer of all four (types from
#      @paged-media/plugin-sdk/api, values from @paged-media/plugin-sdk;
#      createEditor, connectEditor and PRESETS from @paged-media/editor) with
#      moduleResolution nodenext AND bundler, skipLibCheck off, under
#      TypeScript 7 and 5.9;
#   4. (npm) `paged-plugin init` a plugin, install the plugin-sdk tarball into
#      it, and run its own test (node --test) and typecheck;
#   5. (npm) build a host page that embeds the editor with Vite, the way an
#      embedder's bundler takes the package: the output carries the editor's
#      render worker, the engine's wasm from @paged-media/paged, the default
#      faces and the stylesheet, and no file the package names is missing.
#
# Nothing is published and nothing is installed outside <work dir> (default: a
# fresh temporary directory). Exit 1 on the first failure.
set -euo pipefail

TGZ_DIR=$(cd "${1:?usage: consumer-test.sh <dir with the four .tgz> [<work dir>]}" && pwd)
WORK=${2:-$(mktemp -d "${TMPDIR:-/tmp}/paged-consumer-XXXXXX")}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
# The work dir is outside the repository, where proto's shims find no
# .prototools: pin the repository's Bun for every `bun` run below.
export PROTO_BUN_VERSION="${PROTO_BUN_VERSION:-$(bun --version)}"
TS7=7.0.2
TS5=5.9.3
TYPES_NODE=24.19.2
TYPES_REACT=19.3.0
TYPES_REACT_DOM=19.3.0
REACT=19.3.1
VITE=8.3.4

tgz() {
  local f
  f=$(find "$TGZ_DIR" -maxdepth 1 -name "paged-media-$1-[0-9]*.tgz" | head -1)
  [ -n "$f" ] || { echo "consumer-test: no paged-media-$1-*.tgz in $TGZ_DIR" >&2; exit 1; }
  echo "$f"
}
PAGED=$(tgz paged)
VIEWER=$(tgz viewer)
SDK=$(tgz plugin-sdk)
EDITOR=$(tgz editor)

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
import * as viewer from "@paged-media/viewer";
import * as session from "@paged-media/viewer/session";
import * as canvas from "@paged-media/paged";
import * as introspect from "@paged-media/paged/introspect";
import * as repo from "@paged-media/paged/repo";
import * as api from "@paged-media/plugin-sdk/api";
import * as sdk from "@paged-media/plugin-sdk";
import schema from "@paged-media/plugin-sdk/api/manifest.schema.json" with { type: "json" };
import viewerPkg from "@paged-media/viewer/package.json" with { type: "json" };
import pagedPkg from "@paged-media/paged/package.json" with { type: "json" };
import sdkPkg from "@paged-media/plugin-sdk/package.json" with { type: "json" };
import * as editor from "@paged-media/editor";
import * as iframe from "@paged-media/editor/iframe";
import featureIds from "@paged-media/editor/feature-ids.json" with { type: "json" };
import themeTokens from "@paged-media/editor/theme-tokens.json" with { type: "json" };
import editorPkg from "@paged-media/editor/package.json" with { type: "json" };
import { existsSync } from "node:fs";

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const bytes = (spec) => readFileSync(fileURLToPath(import.meta.resolve(spec)));

check(typeof viewer.createViewer === "function", "viewer: createViewer");
check(typeof viewer.createSessionFromBundledWasm === "function", "viewer: createSessionFromBundledWasm");
check(typeof session.ViewerSession === "function", "viewer/session: ViewerSession");
session.initSync({ module: bytes("@paged-media/viewer/session/paged_sdk_bg.wasm") });
check(true, "viewer/session: the session wasm instantiates");
check(typeof canvas.CanvasWorker === "function", "paged: CanvasWorker");
check(bytes("@paged-media/paged/paged_canvas_wasm_bg.wasm").length > 1e6, "paged: the canvas wasm resolves");
check(typeof introspect.Inspector === "function", "paged/introspect: Inspector");
introspect.initSync({ module: bytes("@paged-media/paged/introspect/paged_introspect_wasm_bg.wasm") });
const live = JSON.parse(introspect.describeCatalog());
const shipped = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@paged-media/paged/introspect/catalog.json")), "utf8"));
check(JSON.stringify(live) === JSON.stringify(shipped), "paged/introspect: describeCatalog() equals introspect/catalog.json");
check(typeof repo.Repository === "function", "paged/repo: Repository");
repo.initSync({ module: bytes("@paged-media/paged/repo/paged_repo_wasm_bg.wasm") });
const r = new repo.Repository("consumer-test");
check(typeof r.free === "function" && typeof r.tree === "function", "paged/repo: new Repository()");
r.free();
check(Object.keys(api).length === 0, "plugin-sdk/api: type-only (no runtime exports)");
check(schema?.required?.includes("apiVersion"), "plugin-sdk/api/manifest.schema.json");
check(typeof sdk.loadBundle === "function" && typeof sdk.defineBundle === "function", "plugin-sdk: loadBundle, defineBundle");
check(sdk.satisfiesApiVersion(`^${sdk.API_VERSION.slice(0, 3)}`), "plugin-sdk: API_VERSION negotiates");
const fake = sdk.createFakeEditor();
const loaded = sdk.loadBundle(() => fake.editor, sdk.defineBundle({
  manifest: { id: "com.example.hello", name: "Hello", version: "0.1.0", apiVersion: "^0.2", contributes: { commands: ["com.example.hello.command.report"] } },
  activate: (host) => host.contribute.command({ id: "com.example.hello.command.report", title: "Report", handler: () => {} }),
}), { console: sdk.silentConsole, storage: sdk.mapBacking() });
check(fake.ids("commands").join() === "com.example.hello.command.report", "plugin-sdk: an activation test over createFakeEditor, mapBacking, silentConsole");
loaded.dispose();
check(typeof editor.createEditor === "function" && typeof editor.mountEditor === "function", "editor: createEditor, mountEditor");
check(typeof iframe.connectEditor === "function" && iframe.BRIDGED_METHODS.includes("setFieldValues"), "editor/iframe: connectEditor, BRIDGED_METHODS");
check(featureIds && typeof featureIds === "object" && themeTokens && typeof themeTokens === "object", "editor: feature-ids.json, theme-tokens.json");
check(existsSync(fileURLToPath(import.meta.resolve("@paged-media/editor/style.css"))), "editor: style.css");
// The build points the worker at the engine beside the package: the
// installer must have put @paged-media/paged there.
const editorIndex = fileURLToPath(import.meta.resolve("@paged-media/editor"));
const engineThere = fileURLToPath(new URL("../../paged/paged_canvas_wasm_bg.wasm", `file://${editorIndex}`));
check(existsSync(engineThere), `editor: the engine's wasm where the package looks for it (${engineThere})`);
check(editorPkg.dependencies["@paged-media/paged"] === pagedPkg.version, "editor: depends on this @paged-media/paged");
check(viewerPkg.version === pagedPkg.version && pagedPkg.version === sdkPkg.version && sdkPkg.version === editorPkg.version, `one version: viewer ${viewerPkg.version}, paged ${pagedPkg.version}, plugin-sdk ${sdkPkg.version}, editor ${editorPkg.version}`);

if (failures.length) {
  console.error(`${failures.length} import check(s) failed`);
  process.exit(1);
}
JS
  # `paged mcp` over stdio: initialize, tools/list, lookup_api, list_documents.
  cat >"$dir/mcp.mjs" <<'JS'
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const [runtime, bin] = process.argv.slice(2);
mkdirSync("library", { recursive: true });
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const input = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  call(3, "lookup_api", { query: "paged.set" }),
  call(4, "list_documents", {}),
].map((m) => JSON.stringify(m)).join("\n") + "\n";
const p = spawnSync(runtime, [bin, "mcp", "--library", "library"], { input, encoding: "utf8" });
if (p.status !== 0) { console.error(p.stderr); process.exit(1); }
const replies = p.stdout.trim().split("\n").map((l) => JSON.parse(l));
const by = (id) => replies.find((r) => r.id === id);
const fail = (m) => { console.error(`FAIL paged mcp: ${m}\n${p.stdout}`); process.exit(1); };
if (replies.length !== 4) fail(`${replies.length} replies to 4 requests`);
if (by(1).result.protocolVersion !== "2025-06-18") fail("initialize");
const tools = by(2).result.tools.map((t) => t.name);
const expected = ["list_documents", "describe_document", "read_part", "history", "diff", "create_branch", "commit_parts", "propose_change", "list_changes", "download_link", "open_document", "run_script", "render_page", "save_document", "lookup_api"];
if (tools.join() !== expected.join()) fail(`tools/list: ${tools.join()}`);
if (!(by(3).result.structuredContent.matches > 0)) fail("lookup_api found nothing");
if (by(4).result.structuredContent.documents.length !== 0) fail("list_documents");
console.log(`ok   paged mcp (${runtime}): initialize, tools/list (${tools.length} tools), lookup_api, list_documents`);
JS
  cat >"$dir/consumer.ts" <<'TS'
// A tiny extension and embedders, typed against the four packages.
import type { BundleHost, PagedBundle, PluginManifest } from "@paged-media/plugin-sdk/api";
import {
  API_VERSION,
  createFakeEditor,
  defineBundle,
  loadBundle,
  mapBacking,
  satisfiesApiVersion,
  silentConsole,
} from "@paged-media/plugin-sdk";
import { createViewer, type Viewer } from "@paged-media/viewer";
import initSession, { ViewerSession } from "@paged-media/viewer/session";
import { Inspector, describeCatalog } from "@paged-media/paged/introspect";
import { Repository } from "@paged-media/paged/repo";
import { CanvasWorker } from "@paged-media/paged";
import {
  createEditor,
  type EditorConfig,
  type EditorHandle,
  type EditorProfile,
} from "@paged-media/editor";
import { connectEditor, type RemoteEditorHandle } from "@paged-media/editor/iframe";
import { PRESETS } from "@paged-media/editor/presets";

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

/** The activation test a bundle's own suite writes, over the SDK's doubles. */
export function activationTest(): string[] {
  const fake = createFakeEditor();
  loadBundle(() => fake.editor, bundle, { console: silentConsole, storage: mapBacking() }).dispose();
  return fake.ids("commands");
}

export async function embed(canvas: HTMLCanvasElement): Promise<Viewer> {
  await initSession();
  const viewer = await createViewer({ canvas, session: () => ViewerSession.new() });
  return viewer;
}

export function surfaces(): [typeof Inspector, string, typeof Repository, typeof CanvasWorker] {
  return [Inspector, describeCatalog(), Repository, CanvasWorker];
}

/** An embedder: a template to fill, its fields set, the result saved. */
export async function fill(element: HTMLElement, template: Uint8Array): Promise<Uint8Array> {
  const profile: EditorProfile = { extends: "template-fill", features: { "chrome:rulers": false } };
  const config: EditorConfig = {
    profile: PRESETS["template-fill"] ? profile : "full",
    document: { bytes: template, name: "card.paged" },
    actions: { submit: () => {} },
  };
  const handle: EditorHandle = await createEditor(element, config);
  const result = await handle.setFieldValues({ name: "Ada", photo: { kind: "image", uri: "photo.jpg" }, logo: false });
  if (!result.ok) throw new Error(result.problems.map((p) => p.problem).join());
  handle.features.disable("command:paged.object.*");
  handle.setTheme({ mode: "light", tokens: { "--paged-primary": "210 80% 40%" } });
  const off = handle.on((event) => { if (event.type === "fieldChange") console.log(event.fields.length); });
  const bytes = await handle.save();
  off();
  handle.dispose();
  return bytes;
}

export async function framed(frame: HTMLIFrameElement): Promise<RemoteEditorHandle> {
  const handle = await connectEditor(frame, { profile: "viewer", actions: { close: () => {} } });
  await handle.setRole("filler");
  return handle;
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

typecheck() {
  local dir="$1" pm="$2"
  for ts in typescript ts5; do
    for res in nodenext bundler; do
      echo "== $pm: tsc ($ts $(node "$dir/node_modules/$ts/bin/tsc" --version | awk '{print $2}')) --moduleResolution $res"
      if ! (cd "$dir" && node "node_modules/$ts/bin/tsc" -p "tsconfig.$res.json"); then
        echo "consumer-test: tsc ($ts, $res) failed" >&2
        exit 1
      fi
      echo "   ok"
    done
  done
}

paged_bin() {
  local dir="$1" runtime="$2" bin="$3"
  echo "== $runtime: paged --help, --version"
  local first
  first=$(cd "$dir" && "$runtime" "$bin" --help | head -1)
  case "$first" in
    "paged "*) echo "   $first" ;;
    *) echo "consumer-test: paged --help says: $first" >&2; exit 1 ;;
  esac
  local version
  version=$(cd "$dir" && "$runtime" "$bin" --version)
  echo "   $version"
  if ! node -e 'const v=JSON.parse(process.argv[1]); process.exit(v.cli && v.cli===v.engine ? 0 : 1)' "$version"; then
    echo "consumer-test: paged --version does not find its own engine: $version" >&2
    exit 1
  fi
  echo "== $runtime: paged mcp"
  (cd "$dir" && node mcp.mjs "$runtime" "$bin")
}

echo "consumer-test: $WORK"

# --- npm under Node ------------------------------------------------------------
NPM_DIR="$WORK/npm"
rm -rf "$NPM_DIR"
write_project "$NPM_DIR"
echo "== npm: install the four tarballs (node $(node --version), npm $(npm --version))"
(cd "$NPM_DIR" && npm install --no-audit --no-fund --loglevel=error \
  "$PAGED" "$VIEWER" "$SDK" "$EDITOR" "react@$REACT" "react-dom@$REACT" \
  "typescript@$TS7" "ts5@npm:typescript@$TS5" "@types/node@$TYPES_NODE" "@types/react@$TYPES_REACT" \
  "@types/react-dom@$TYPES_REACT_DOM" "vite@$VITE")
echo "== npm: node imports.mjs"
(cd "$NPM_DIR" && node imports.mjs)
echo "== npm: npx paged-plugin validate"
(cd "$NPM_DIR" && npx --no-install paged-plugin validate manifest.json)
paged_bin "$NPM_DIR" node "$NPM_DIR/node_modules/.bin/paged"
typecheck "$NPM_DIR" npm

echo "== npm: a host page embeds the editor, built by Vite $VITE"
mkdir -p "$NPM_DIR/host"
cat >"$NPM_DIR/host/index.html" <<'HTML'
<!doctype html>
<html><body><div id="editor" style="height: 100vh"></div><script type="module" src="./main.js"></script></body></html>
HTML
cat >"$NPM_DIR/host/main.js" <<'JS'
import { createEditor } from "@paged-media/editor";
import "@paged-media/editor/style.css";
const editor = await createEditor(document.getElementById("editor"), { profile: "template-fill" });
window.pagedEditor = editor;
JS
cat >"$NPM_DIR/host/vite.config.mjs" <<'JS'
export default { root: import.meta.dirname, logLevel: "warn", build: { target: "es2022", outDir: "dist", emptyOutDir: true } };
JS
(cd "$NPM_DIR" && node node_modules/vite/bin/vite.js build -c host/vite.config.mjs)
node -e '
  const fs = require("node:fs"), path = require("node:path");
  const dist = process.argv[1];
  const files = fs.readdirSync(dist, { recursive: true }).map(String);
  const js = files.filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(dist, f), "utf8")).join("\n");
  const fail = (m) => { console.error("FAIL host build: " + m); process.exit(1); };
  const engine = fs.statSync(path.join(process.argv[2], "paged_canvas_wasm_bg.wasm")).size;
  const wasm = files.filter((f) => f.endsWith(".wasm")).map((f) => fs.statSync(path.join(dist, f)).size);
  if (!wasm.includes(engine)) fail("the engine wasm of @paged-media/paged is not in the output");
  if (!files.some((f) => /Inter.*\.ttf$/.test(f))) fail("the default face is not in the output");
  if (!files.some((f) => f.endsWith(".css"))) fail("the stylesheet is not in the output");
  if (!/new Worker\(/.test(js)) fail("no worker is constructed");
  if (/@paged-media\/editor\/dist|\/node_modules\//.test(js)) fail("the output points into node_modules");
  console.log(`ok   host build: ${files.length} files, ${wasm.length} wasm (the engine among them), the face, the stylesheet, the workers`);
' "$NPM_DIR/host/dist" "$NPM_DIR/node_modules/@paged-media/paged"

echo "== npm: paged-plugin init, then the plugin's own test and typecheck"
(cd "$WORK" && "$NPM_DIR/node_modules/.bin/paged-plugin" init hello-plugin)
# Before a publish the registry has no plugin-sdk at this version: the
# scaffold's development dependency is pointed at the tarball.
node -e '
  const fs = require("node:fs");
  const [file, tgz] = process.argv.slice(1);
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  p.devDependencies["@paged-media/plugin-sdk"] = "file:" + tgz;
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
' "$WORK/hello-plugin/package.json" "$SDK"
(cd "$WORK/hello-plugin" && npm install --no-audit --no-fund --loglevel=error \
  && npm test && npm run typecheck && npm run validate)

# --- Bun -----------------------------------------------------------------------
BUN_DIR="$WORK/bun"
rm -rf "$BUN_DIR"
write_project "$BUN_DIR"
echo "== bun: install the four tarballs (bun $(bun --version))"
cat >"$BUN_DIR/package.json" <<JSON
{
  "name": "paged-consumer-test",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": {
    "@paged-media/paged": "$PAGED",
    "@paged-media/viewer": "$VIEWER",
    "@paged-media/plugin-sdk": "$SDK",
    "@paged-media/editor": "$EDITOR",
    "react": "$REACT",
    "react-dom": "$REACT",
    "@types/react-dom": "$TYPES_REACT_DOM",
    "typescript": "$TS7",
    "ts5": "npm:typescript@$TS5",
    "@types/node": "$TYPES_NODE",
    "@types/react": "$TYPES_REACT"
  },
  "overrides": {
    "@paged-media/paged": "$PAGED"
  }
}
JSON
# Before a publish the registry has no @paged-media/paged at this version:
# the editor's dependency on it is pointed at the tarball (npm takes the
# tarball installed beside it; Bun needs telling).
(cd "$BUN_DIR" && bun install --silent)
echo "== bun: bun imports.mjs"
(cd "$BUN_DIR" && bun imports.mjs)
echo "== bun: paged-plugin validate"
(cd "$BUN_DIR" && ./node_modules/.bin/paged-plugin validate manifest.json)
paged_bin "$BUN_DIR" bun "$BUN_DIR/node_modules/@paged-media/paged/dist/paged.js"
typecheck "$BUN_DIR" bun

echo "consumer-test OK — npm and bun, nodenext and bundler, TypeScript $TS7 and $TS5, the paged bin and paged mcp, paged-plugin init, the editor in a Vite host build"
