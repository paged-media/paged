/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The CLI is a HOST (ADR 324 §1): the third injector of `host.objects`,
// after the editor and the harness. It reuses `createHeadlessHost` — the
// published canvas-wasm booted in Node, the shared object / data-provider
// registries — and adds what a command line needs: open a file, discover and
// activate the installed bundles, save or export the result.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BundleHost, PagedBundle } from "@paged-media/plugin-api";
import { API_VERSION, createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { autoCandidates, importBundle, resolvable, type DiscoveredBundle, type DiscoveryProblem } from "./plugins";
import { installNodeShims } from "./node-shims";
import { CliError, EXIT } from "./errors";

export type DocFormat = "paged" | "idml";
export type CoreExportFormat = "paged" | "idml" | "pdf";

export interface SessionOptions {
  cwd?: string;
  /** Explicit bundle list; `[]` = none; undefined = auto discovery. */
  plugins?: readonly string[];
  /** A TTF/OTF every load lays text out with (the editor's default font). */
  font?: string;
  /** Where to resolve `@paged-media/canvas-wasm` from (else this package). */
  engineFrom?: string;
  log?: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
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
  exportBytes(format: string, options?: ExportOptions): Promise<{ bytes: Uint8Array; format: string; diagnostics: string[]; lost?: string[] }>;
  /** Write the document to `out` (format from its extension), or back to
   *  the file it was opened from. */
  save(out?: string): Promise<{ path: string; format: string; bytes: number; lost?: string[] }>;
  dispose(): void;
}

export interface ExportOptions {
  pdf?: Record<string, unknown>;
  linkBase?: string | null;
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** The directory of this package (the anchor canvas-wasm resolves from). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === "@paged-media/cli") return dir;
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
    return (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;
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

function readInput(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new CliError(EXIT.usage, `cannot read ${path}: ${(err as Error).message}`);
  }
}

export function writeOutput(path: string, bytes: Uint8Array): void {
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, bytes);
  } catch (err) {
    throw new CliError(EXIT.usage, `cannot write ${path}: ${(err as Error).message}`);
  }
}

/**
 * Boot the engine, open `docPath` (or nothing), discover and activate the
 * bundles. Every bundle gets its own host bound to its manifest; they meet
 * through the shared registries.
 */
export async function openSession(docPath: string | null, options: SessionOptions = {}): Promise<CliSession> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? silent;
  const format = docPath ? docFormatOf(docPath) : null;
  const docBytes = docPath ? readInput(resolve(cwd, docPath)) : null;
  const font = options.font ? readInput(resolve(cwd, options.font)) : undefined;

  installNodeShims();
  let h: HeadlessHost;
  try {
    h = await createHeadlessHost({
      console: log,
      resolveFrom: options.engineFrom ?? process.env["PAGED_ENGINE_FROM"] ?? packageRoot(),
      ...(font ? { defaultFont: font, engineShaper: true } : {}),
    });
  } catch (err) {
    throw new CliError(EXIT.usage, `cannot boot the engine: ${(err as Error).message}`);
  }
  const fail = (err: unknown): never => {
    h.dispose();
    throw err;
  };

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
  const sources = explicit ? [...options.plugins!] : autoCandidates(cwd).filter((s) => resolvable(s, cwd));
  for (const source of sources) {
    let found: DiscoveredBundle;
    try {
      found = await importBundle(source, cwd);
    } catch (err) {
      if (explicit) fail(new CliError(EXIT.usage, `plugin ${source}: ${(err as Error).message}`));
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
      if (explicit) fail(new CliError(EXIT.usage, `plugin ${source} (${found.bundle.manifest.id}): ${why}`));
      problems.push({ source, error: why });
      continue;
    }
    plugins.push({ id: found.bundle.manifest.id, source, version: found.version, host: captured!, module: found.module });
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
          throw new CliError(EXIT.failed, `export ${f} failed: ${(err as Error).message}`);
        }
      }
      const exporter = h
        .exportersContributed()
        .find((e) => e.id === fmt || e.extension.replace(/^\./, "").toLowerCase() === f);
      if (!exporter) {
        const known = ["pdf", "idml", "paged", ...h.exportersContributed().map((e) => `${e.id} (${e.extension})`)];
        throw new CliError(EXIT.usage, `no exporter for "${fmt}" — known: ${known.join(", ")}`);
      }
      const result = await exporter.export();
      if (!result) throw new CliError(EXIT.failed, `${exporter.id}: nothing to export`);
      return { bytes: result.bytes, format: exporter.extension.replace(/^\./, ""), diagnostics: [] };
    },
    async save(out) {
      const target = out ? resolve(cwd, out) : session.docPath;
      if (!target) throw new CliError(EXIT.usage, "nothing to save to: pass -o <file>");
      const ext = extname(target).replace(/^\./, "").toLowerCase();
      const done = await session.exportBytes(ext || (format ?? "paged"));
      writeOutput(target, done.bytes);
      return { path: target, format: done.format, bytes: done.bytes.byteLength, ...(done.lost?.length ? { lost: done.lost } : {}) };
    },
    dispose() {
      h.dispose();
    },
  };
  return session;
}

/** The installed canvas-wasm version, for `--version` (no boot). */
export function engineVersionOnDisk(from = packageRoot()): string | null {
  try {
    const req = createRequire(join(from, "package.json"));
    return (JSON.parse(readFileSync(req.resolve("@paged-media/canvas-wasm/package.json"), "utf8")) as { version: string }).version;
  } catch {
    return null;
  }
}

export const baseName = (path: string): string => basename(path, extname(path));
