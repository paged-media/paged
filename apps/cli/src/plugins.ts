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

// Bundle DISCOVERY (ADR 324 §2). The CLI never depends on a plugin at build
// time; it loads bundles at run time, and only the ones it is told to. A
// bundle is code that runs with the caller's rights, so the directory a
// command happens to run in never decides what loads:
//   · default, and `--no-plugins` — none (core objects only);
//   · `--plugins a,b` — exactly these (package names or paths); a miss is
//     an error;
//   · `--plugins auto` — every first-party bundle resolvable from the cwd
//     (`@paged-media/{draw,image,sheet,data,web,doc,slide,publish,pdf}`) plus
//     every dependency of the cwd's package.json that carries a
//     `"paged": { "manifest": … }` entry; a miss is silent.
// `PAGED_PLUGINS` in the environment takes the same values and is the
// default when neither flag is given.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PagedBundle } from "@paged-media/plugin-api";

export const FIRST_PARTY_BUNDLES = [
  "@paged-media/draw",
  "@paged-media/image",
  "@paged-media/sheet",
  "@paged-media/data",
  "@paged-media/web",
  "@paged-media/doc",
  "@paged-media/slide",
  "@paged-media/publish",
  "@paged-media/pdf",
] as const;

/** The value of `--plugins` / `PAGED_PLUGINS` that asks for discovery. */
export const AUTO_PLUGINS = "auto";

/** What a `--plugins` / `PAGED_PLUGINS` value selects: `"auto"` (discovery
 *  from the cwd) or the listed sources; an empty value selects none. */
export function parsePluginSelection(
  value: string,
): readonly string[] | typeof AUTO_PLUGINS {
  const list = value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return list.length === 1 && list[0] === AUTO_PLUGINS ? AUTO_PLUGINS : list;
}

export interface DiscoveredBundle {
  /** The package (or path) it came from. */
  source: string;
  version: string | null;
  bundle: PagedBundle;
  /** The module namespace (some verbs use a bundle's other exports). */
  module: Record<string, unknown>;
}

export interface DiscoveryProblem {
  source: string;
  error: string;
}

const isBundle = (v: unknown): v is PagedBundle =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as PagedBundle).activate === "function" &&
  typeof (v as PagedBundle).manifest?.id === "string";

/** The bundle a module exports: `default`, else the first bundle-shaped export. */
export function bundleOf(mod: Record<string, unknown>): PagedBundle | null {
  if (isBundle(mod["default"])) return mod["default"];
  for (const v of Object.values(mod)) if (isBundle(v)) return v;
  return null;
}

function packageJsonOf(
  requireFrom: NodeRequire,
  name: string,
): { version?: string } | null {
  try {
    return JSON.parse(
      readFileSync(requireFrom.resolve(`${name}/package.json`), "utf8"),
    );
  } catch {
    return null;
  }
}

/** Candidates for automatic discovery from `cwd`. */
export function autoCandidates(cwd: string): string[] {
  const out = new Set<string>(FIRST_PARTY_BUNDLES);
  const pj = join(cwd, "package.json");
  if (existsSync(pj)) {
    try {
      const pkg = JSON.parse(readFileSync(pj, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      const req = createRequire(pj);
      for (const name of Object.keys({
        ...pkg["dependencies"],
        ...pkg["devDependencies"],
      })) {
        const dep = packageJsonOf(req, name) as {
          paged?: { manifest?: string };
        } | null;
        if (dep?.paged?.manifest) out.add(name);
      }
    } catch {
      /* an unreadable package.json discovers nothing extra */
    }
  }
  return [...out];
}

/** Import one bundle by package name or path, resolved from `cwd`. */
export async function importBundle(
  source: string,
  cwd: string,
): Promise<DiscoveredBundle> {
  const anchor = join(cwd, "package.json");
  const req = createRequire(anchor);
  const looksLikePath = source.startsWith(".") || isAbsolute(source);
  const resolved = looksLikePath ? resolve(cwd, source) : req.resolve(source);
  const mod = (await import(pathToFileURL(resolved).href)) as Record<
    string,
    unknown
  >;
  const bundle = bundleOf(mod);
  if (!bundle)
    throw new Error(
      `${source} exports no plugin bundle ({ manifest, activate })`,
    );
  const version = looksLikePath
    ? bundle.manifest.version
    : (packageJsonOf(req, source)?.version ?? bundle.manifest.version);
  return { source, version: version ?? null, bundle, module: mod };
}

/** Is `source` resolvable from `cwd` at all (auto discovery skips silently)? */
export function resolvable(source: string, cwd: string): boolean {
  try {
    createRequire(join(cwd, "package.json")).resolve(source);
    return true;
  } catch {
    return false;
  }
}
