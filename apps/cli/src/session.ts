/*
 * This file is part of paged (https://paged.media).
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

// The CLI is a HOST (ADR 324 §1): the third injector of `host.objects`,
// after the editor and the harness. It reuses `createHeadlessHost` — the
// engine wasm booted in Node, the shared object / data-provider
// registries — and adds what a command line needs: open a file, discover and
// activate the installed bundles, save or export the result.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleHost, PagedBundle } from "@paged-media/plugin-api";
import {
  API_VERSION,
  createHeadlessHost,
  protocolFromVersion,
  resolveCanvasWasm,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";

import {
  aiObjectModel,
  complete,
  createDirectTransport,
  type AiTransport,
} from "@paged-media/ai";
import ENGINE_CATALOG from "@paged-media/ai/catalog";

import {
  autoCandidates,
  importBundle,
  resolvable,
  type DiscoveredBundle,
  type DiscoveryProblem,
} from "./plugins";
import { installNodeShims } from "./node-shims";
import { CliError, EXIT } from "./errors";

export type DocFormat = "paged" | "idml";
export type CoreExportFormat = "paged" | "idml" | "pdf";

export interface SessionOptions {
  cwd?: string;
  /** Explicit bundle list; `[]` = none; undefined = auto discovery. */
  plugins?: readonly string[];
  /** A TTF/OTF every load lays text out with (the editor's default font).
   *  Absent: the face the CLI ships (Inter, see `bundledFont`). */
  font?: string;
  /** No fallback face at all: text no font answers for is not set. */
  noDefaultFont?: boolean;
  /** An ICC CMYK profile file every load uses as its working space (the
   *  output intent of a PDF/X export). */
  cmykProfile?: string;
  /** Where the session says what the caller should know (stderr). */
  warn?: (text: string) => void;
  /** Where to resolve the engine from (else this package). */
  engineFrom?: string;
  log?: {
    debug(...a: unknown[]): void;
    info(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    error(...a: unknown[]): void;
  };
}

export interface LoadedPlugin {
  id: string;
  source: string;
  version: string | null;
  host: BundleHost;
  module: Record<string, unknown>;
}

export interface CliSession {
  readonly h: HeadlessHost;
  readonly docPath: string | null;
  readonly docFormat: DocFormat | null;
  readonly engineVersion: string;
  readonly protocol: number;
  readonly plugins: readonly LoadedPlugin[];
  /** The CLI's own driver host (broad document capabilities): what `run`
   *  scripts and the verbs use for undo / reads outside `objects`. */
  readonly driver: BundleHost;
  readonly pluginProblems: readonly DiscoveryProblem[];
  plugin(id: string): LoadedPlugin | undefined;
  /** Serialise the document in `format` (core exporters, or a plugin
   *  exporter by id / extension). */
  exportBytes(
    format: string,
    options?: ExportOptions,
  ): Promise<{
    bytes: Uint8Array;
    format: string;
    diagnostics: string[];
    lost?: string[];
  }>;
  /** Write the document to `out` (format from its extension), or back to
   *  the file it was opened from. */
  save(
    out?: string,
  ): Promise<{ path: string; format: string; bytes: number; lost?: string[] }>;
  dispose(): void;
}

export interface ExportOptions {
  pdf?: Record<string, unknown>;
  linkBase?: string | null;
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The oldest engine protocol the CLI runs on. The object model's core seam
 * is protocol-aware (DESIGN.md §21.9): at >= 71 core addresses go straight
 * to `Set` / `RequestGet` / `RequestQuery` and core objects can be created
 * and deleted; at 70 the interim table serves (no core creates). The
 * vendored wire may be newer than the installed engine, so the CLI pins the
 * handshake to the engine it FOUND (not the vendored stamp), within range.
 */
export const MIN_ENGINE_PROTOCOL = 70;

/** The protocol of the canvas-wasm `resolveFrom` resolves (no boot). */
export async function engineProtocolOnDisk(
  resolveFrom: string,
): Promise<{ version: string; protocol: number }> {
  const { version } = await resolveCanvasWasm(resolveFrom);
  const protocol = protocolFromVersion(version);
  if (protocol === null)
    throw new CliError(
      EXIT.usage,
      `the engine ${version}: not a 0.<protocol>.<patch> version`,
    );
  if (protocol < MIN_ENGINE_PROTOCOL) {
    throw new CliError(
      EXIT.usage,
      `the engine ${version} speaks protocol ${protocol}; the CLI needs >= ${MIN_ENGINE_PROTOCOL}`,
    );
  }
  return { version, protocol };
}

/** The packages this program ships in: the workspace's `@paged-media/cli`,
 *  and `@paged-media/paged`, the engine package on npm whose `paged` bin is
 *  this CLI, bundled (PM-0008, amendment 3). */
export const CLI_PACKAGES: readonly string[] = [
  "@paged-media/cli",
  "@paged-media/paged",
];

/** The packages the engine is found in: `@paged-media/paged` (which, when
 *  the CLI runs from it, is the CLI's own package), else the workspace's
 *  `@paged-media/canvas-wasm`. */
export const ENGINE_PACKAGES: readonly string[] = [
  "@paged-media/paged",
  "@paged-media/canvas-wasm",
];

/** The directory of this package (the anchor the engine resolves from). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string })
          .name;
        if (name !== undefined && CLI_PACKAGES.includes(name)) return dir;
      } catch {
        /* keep walking */
      }
    }
    dir = dirname(dir);
  }
  return dirname(fileURLToPath(import.meta.url));
}

export function cliVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    return "0.0.0";
  }
}

export function docFormatOf(path: string): DocFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".paged") return "paged";
  if (ext === ".idml") return "idml";
  throw new CliError(EXIT.usage, `${path}: not a .paged or .idml document`);
}

/** The face the CLI ships, as the Rust CLI does: Inter (SIL Open Font
 *  License 1.1). The npm package carries it as fonts/Inter.ttf; in a
 *  checkout it is the engine's own copy (engine/core/corpus/fonts). */
export const BUNDLED_FONT = "Inter.ttf";

/** The path of the bundled face, looked for beside `roots` (the CLI's
 *  package and the engine's): `<root>/fonts/Inter.ttf`, else a checkout's
 *  `engine/core/corpus/fonts/Inter.ttf` above it. Null: not found. */
export function bundledFont(roots: readonly string[]): string | null {
  for (const root of roots) {
    const shipped = join(root, "fonts", BUNDLED_FONT);
    if (existsSync(shipped)) return shipped;
    let dir = root;
    for (let i = 0; i < 6; i++) {
      const inRepo = join(dir, "engine/core/corpus/fonts", BUNDLED_FONT);
      if (existsSync(inRepo)) return inRepo;
      dir = dirname(dir);
    }
  }
  return null;
}

/** An ICC profile file whose data colour space is CMYK, or a usage error
 *  saying what it is instead. */
export function readCmykProfile(path: string): Uint8Array {
  const bytes = readInput(path);
  const tag = (at: number) =>
    String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 128 || tag(36) !== "acsp")
    throw new CliError(
      EXIT.usage,
      `--cmyk-profile: ${path} is not an ICC profile`,
    );
  if (tag(16) !== "CMYK")
    throw new CliError(
      EXIT.usage,
      `--cmyk-profile: ${path} is a ${tag(16).trim()} profile, not CMYK`,
    );
  return bytes;
}

function readInput(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new CliError(
      EXIT.usage,
      `cannot read ${path}: ${(err as Error).message}`,
    );
  }
}

export function writeOutput(path: string, bytes: Uint8Array): void {
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, bytes);
  } catch (err) {
    throw new CliError(
      EXIT.usage,
      `cannot write ${path}: ${(err as Error).message}`,
    );
  }
}

/**
 * Boot the engine, open `docPath` (or nothing), discover and activate the
 * bundles. Every bundle gets its own host bound to its manifest; they meet
 * through the shared registries.
 */
export async function openSession(
  docPath: string | null,
  options: SessionOptions = {},
): Promise<CliSession> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? silent;
  const format = docPath ? docFormatOf(docPath) : null;
  const docBytes = docPath ? readInput(resolve(cwd, docPath)) : null;
  installNodeShims();
  const resolveFrom =
    options.engineFrom ?? process.env["PAGED_ENGINE_FROM"] ?? packageRoot();
  // Without a face the engine sets no text at all and a PDF's pages come out
  // blank, so a run without --font takes the bundled one, as the Rust CLI
  // does; only --no-default-font goes without, and that is said out loud.
  let font: Uint8Array | undefined;
  if (options.font) font = readInput(resolve(cwd, options.font));
  else if (options.noDefaultFont)
    options.warn?.(
      "--no-default-font: text no registered font answers for is not set (exported pages may be blank)",
    );
  else {
    const path = bundledFont([packageRoot(), resolve(cwd, resolveFrom)]);
    if (path) font = readInput(path);
    else
      options.warn?.(
        `the bundled ${BUNDLED_FONT} is missing, so text is not set and exported pages may be blank — pass --font <file.ttf>`,
      );
  }
  const cmykProfile = options.cmykProfile
    ? readCmykProfile(resolve(cwd, options.cmykProfile))
    : undefined;
  let h: HeadlessHost;
  try {
    const { protocol } = await engineProtocolOnDisk(resolveFrom);
    h = await createHeadlessHost({
      console: log,
      resolveFrom,
      expectedProtocol: protocol,
      ...(font ? { defaultFont: font, engineShaper: true } : {}),
      ...(cmykProfile ? { cmykProfile } : {}),
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      EXIT.usage,
      `cannot boot the engine: ${(err as Error).message}`,
    );
  }
  const fail = (err: unknown): never => {
    h.dispose();
    throw err;
  };

  // Scripts may ask Claude (`await paged.invoke("paged.ai.complete", …)`),
  // answered with the caller's own credential. The client is built on the
  // first call, so a run that never asks needs no key.
  h.objects.register({ plugin: "paged.ai", model: aiObjectModel(cliComplete) });

  if (docBytes) {
    try {
      await h.load(docBytes);
    } catch (err) {
      fail(new CliError(EXIT.usage, `${docPath}: ${(err as Error).message}`));
    }
  }

  // ---- the CLI's own driver bundle: loaded first, so the doors it uses
  // (undo, reads) are its own, independent of which plugins load.
  let driver: BundleHost | null = null;
  h.loadBundle({
    manifest: {
      id: "media.paged.cli",
      name: "paged CLI",
      version: cliVersion(),
      apiVersion: `^${API_VERSION.slice(0, 3)}`,
      capabilities: {
        document: { read: "broad", write: "broad" },
        rendering: ["hitTest"],
        documents: { export: true, open: true },
      },
    },
    activate(host) {
      driver = host;
      return { dispose() {} };
    },
  });

  // ---- bundles
  const plugins: LoadedPlugin[] = [];
  const problems: DiscoveryProblem[] = [];
  const explicit = options.plugins !== undefined;
  const sources = explicit
    ? [...options.plugins!]
    : autoCandidates(cwd).filter((s) => resolvable(s, cwd));
  for (const source of sources) {
    let found: DiscoveredBundle;
    try {
      found = await importBundle(source, cwd);
    } catch (err) {
      if (explicit)
        fail(
          new CliError(
            EXIT.usage,
            `plugin ${source}: ${(err as Error).message}`,
          ),
        );
      problems.push({ source, error: (err as Error).message });
      continue;
    }
    if (plugins.some((p) => p.id === found.bundle.manifest.id)) continue;
    let captured: BundleHost | null = null;
    const wrapped: PagedBundle = {
      manifest: found.bundle.manifest,
      activate(host) {
        captured = host;
        return found.bundle.activate(host);
      },
    };
    try {
      h.loadBundle(wrapped);
    } catch (err) {
      const why = `activation failed: ${(err as Error).message}`;
      if (explicit)
        fail(
          new CliError(
            EXIT.usage,
            `plugin ${source} (${found.bundle.manifest.id}): ${why}`,
          ),
        );
      problems.push({ source, error: why });
      continue;
    }
    plugins.push({
      id: found.bundle.manifest.id,
      source,
      version: found.version,
      host: captured!,
      module: found.module,
    });
  }

  const session: CliSession = {
    h,
    docPath: docPath ? resolve(cwd, docPath) : null,
    docFormat: format,
    engineVersion: h.engineVersion,
    protocol: h.protocolVersion,
    plugins,
    driver: driver!,
    pluginProblems: problems,
    plugin: (id) => plugins.find((p) => p.id === id),
    async exportBytes(fmt, exportOptions = {}) {
      const f = fmt.replace(/^\./, "").toLowerCase();
      if (f === "paged" || f === "idml" || f === "pdf") {
        // Plugins settle their pending state first, as File ▸ Save does.
        if (f !== "pdf") await h.willSave.fire();
        try {
          const out = await h.exportDocument(f, exportOptions);
          return { ...out, format: f };
        } catch (err) {
          throw new CliError(
            EXIT.failed,
            `export ${f} failed: ${(err as Error).message}`,
          );
        }
      }
      const exporter = h
        .exportersContributed()
        .find(
          (e) =>
            e.id === fmt || e.extension.replace(/^\./, "").toLowerCase() === f,
        );
      if (!exporter) {
        const known = [
          "pdf",
          "idml",
          "paged",
          ...h.exportersContributed().map((e) => `${e.id} (${e.extension})`),
        ];
        throw new CliError(
          EXIT.usage,
          `no exporter for "${fmt}" — known: ${known.join(", ")}`,
        );
      }
      const result = await exporter.export();
      if (!result)
        throw new CliError(EXIT.failed, `${exporter.id}: nothing to export`);
      return {
        bytes: result.bytes,
        format: exporter.extension.replace(/^\./, ""),
        diagnostics: [],
      };
    },
    async save(out) {
      const target = out ? resolve(cwd, out) : session.docPath;
      if (!target)
        throw new CliError(EXIT.usage, "nothing to save to: pass -o <file>");
      const ext = extname(target).replace(/^\./, "").toLowerCase();
      const done = await session.exportBytes(ext || (format ?? "paged"));
      writeOutput(target, done.bytes);
      return {
        path: target,
        format: done.format,
        bytes: done.bytes.byteLength,
        ...(done.lost?.length ? { lost: done.lost } : {}),
      };
    },
    dispose() {
      h.dispose();
    },
  };
  return session;
}

/** The installed engine's version, for `--version` (no boot). */
export function engineVersionOnDisk(from = packageRoot()): string | null {
  const req = createRequire(join(from, "package.json"));
  for (const name of ENGINE_PACKAGES) {
    try {
      const pj = req.resolve(`${name}/package.json`);
      if (!existsSync(join(dirname(pj), "paged_canvas_wasm_bg.wasm"))) continue;
      return (JSON.parse(readFileSync(pj, "utf8")) as { version: string })
        .version;
    } catch {
      /* the next package */
    }
  }
  return null;
}

export const baseName = (path: string): string => basename(path, extname(path));

let cliTransport: AiTransport | null = null;

/** `paged.ai.complete` for CLI scripts: straight to Anthropic with
 *  ANTHROPIC_API_KEY or an `ant auth login` profile. */
function cliComplete(prompt: string) {
  cliTransport ??= createDirectTransport({ catalog: ENGINE_CATALOG });
  return complete(cliTransport, prompt);
}
