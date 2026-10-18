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

// The bundle side of the MODULE door (ADR 326): resolve a declared wasm
// artifact through the host, falling back to the bundle's own copy.
//
// A bundle has always loaded its wasm from a URL next to its own code (Vite
// `?url`, `new URL("../bin/x.wasm", import.meta.url)`). With the door the
// HOST may serve the same bytes from a module host instead — immutable per
// version, compressed, shared across sites — and vouch for them with
// Subresource Integrity. These helpers make that a one-line change at the
// call site: pass the bundle-relative URL you used before as the fallback.
//
// They are written against a host that may PREDATE the door (an editor on an
// older plugin-sdk has no `host.modules`): the probe is `supports("modules@1")`
// plus the member's presence, and every failure of the host path is the
// fallback, never an error. A bundle that must also run where THIS module
// is absent (an older plugin-sdk peer has no `resolveWasm` export) inlines
// the same probe instead of importing it — see `docs/reference/wasm-packaging.md` §7.

import type { BundleHost, ModulesSurface } from "@paged-media/plugin-api";

/** Where a wasm artifact will be loaded from. */
export interface ResolvedWasm {
  /** The URL to load. */
  url: string;
  /** Subresource Integrity to fetch it with, or `null` when unknown. */
  integrity: string | null;
  /** `"host"` when the host served the answer, `"bundle"` for the fallback. */
  source: "host" | "bundle";
}

type HostLike = Pick<BundleHost, "manifest" | "supports"> & {
  readonly modules?: Partial<ModulesSurface>;
};

/** The manifest's own integrity stamp for a declared artifact, if any. */
function declaredIntegrity(host: HostLike, name: string): string | null {
  const a = host.manifest.capabilities?.wasm?.find((w) => w.name === name);
  return a?.integrity ?? null;
}

/**
 * Resolve the declared wasm artifact `name`: the host's URL + integrity when
 * the host serves it (`supports("modules@1")`), else `fallbackUrl` (the
 * bundle-relative URL the bundle used before) with the manifest's own
 * integrity stamp, if it has one. Never rejects: a host path that fails —
 * no door, an undeclared name, a throwing backend — is the fallback.
 */
export async function resolveWasm(
  host: HostLike,
  name: string,
  fallbackUrl: string | URL,
): Promise<ResolvedWasm> {
  const fallback: ResolvedWasm = {
    url: String(fallbackUrl),
    integrity: declaredIntegrity(host, name),
    source: "bundle",
  };
  if (!host.supports("modules@1") || typeof host.modules?.resolve !== "function") {
    return fallback;
  }
  try {
    const hosted = await host.modules.resolve(name);
    if (hosted) return { url: hosted.url, integrity: hosted.integrity, source: "host" };
  } catch {
    // an undeclared name in 'enforce', or a host failure: load our own copy
  }
  return fallback;
}

/** `resolveWasm(...)`'s URL alone. */
export async function resolveWasmUrl(
  host: HostLike,
  name: string,
  fallbackUrl: string | URL,
): Promise<string> {
  return (await resolveWasm(host, name, fallbackUrl)).url;
}

/**
 * Fetch the declared wasm artifact `name` from wherever `resolveWasm` says,
 * with `{ integrity }` when one is known — a byte that differs fails the
 * fetch instead of reaching `WebAssembly`. Hand the promise to
 * `WebAssembly.instantiateStreaming` or a wasm-bindgen
 * `init({ module_or_path })`.
 */
export async function fetchWasm(
  host: HostLike,
  name: string,
  fallbackUrl: string | URL,
): Promise<Response> {
  const r = await resolveWasm(host, name, fallbackUrl);
  return r.integrity ? fetch(r.url, { integrity: r.integrity }) : fetch(r.url);
}
